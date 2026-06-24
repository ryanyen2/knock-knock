/**
 * Driver — one live agent conversation: a sessionId, a serialized turn queue, and one AgentAdapter.
 * With a PreambleContext the collaborative layer rides in the prompt text (preamble on first turn, <channel> envelope every turn) so the adapter seam stays plain prompt/response.
 */

import type { AgentAdapter, PermissionProfile, TurnOptions, Verdict } from './agent-adapter.ts'
import { chunk, wrapEnvelope, buildPreamble, type PreambleContext, type TurnEnvelopeMeta } from './lib.ts'

export type TurnMeta = {
  senderId: string
  kind: 'owner' | 'human' | 'agent' | 'unknown'
  messageId: string
  ts: string
  channelId: string
}

const CHUNK_LIMIT = 1900
const CHUNK_MODE = 'newline' as const

export class Driver {
  private sessionId?: string
  /** Whether the preamble was sent. Tracked separately from sessionId so a resumed foreign session still gets the room preamble once. */
  private preambleSent = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly sessionKey: string,
    profile: PermissionProfile,
    permissionHandler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
    /** Collaborative context — when provided, injects the preamble on the first turn and wraps every turn in a <channel> envelope. Omit for a plain-text session. */
    private readonly ctx?: PreambleContext,
  ) {
    adapter.applyPolicy(profile)
    adapter.onPermissionRequest(permissionHandler)
  }

  /** Bind to an existing runtime session id, resumed on the next turn; resets the preamble flag. Enqueued onto the serialized queue so it can't race an in-flight turn's sessionId write. */
  bindSession(sessionId: string): void {
    this.queue = this.queue.then(() => {
      this.sessionId = sessionId
      this.preambleSent = false
    })
  }

  /** Enqueue a turn; runs serially so concurrent messages don't corrupt session state.
   *  `contextPrefix` is prepended once ahead of the envelope on this turn only.
   *  `profile`, when given, is the per-actor floor re-applied inside the queue so each turn enforces its requester's floor with no race.
   *  `turnOptions` are forwarded for this turn only (claude-sdk honors; ACP ignores). */
  runTurn(
    text: string,
    meta: TurnMeta,
    signal?: AbortSignal,
    contextPrefix?: string,
    profile?: PermissionProfile,
    turnOptions?: TurnOptions,
  ): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      this.queue = this.queue.then(async () => {
        try {
          if (profile) this.adapter.applyPolicy(profile)
          const prompt = this.buildPrompt(text, meta, contextPrefix)
          const result = await this.adapter.prompt({ text: prompt, sessionId: this.sessionId, signal, options: turnOptions })
          this.sessionId = result.sessionId
          resolve(chunk(result.text, CHUNK_LIMIT, CHUNK_MODE))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`driver[${this.sessionKey}]: turn error: ${err}\n`)
          resolve([`Error: ${msg}`])
        }
      })
    })
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private buildPrompt(text: string, meta: TurnMeta, contextPrefix?: string): string {
    if (!this.ctx) {
      return contextPrefix ? `${contextPrefix}\n\n${text}` : text
    }

    const envelopeMeta: TurnEnvelopeMeta = {
      kind: meta.kind,
      senderId: meta.senderId,
      messageId: meta.messageId,
      ts: meta.ts,
      channelId: meta.channelId,
    }
    const wrapped = wrapEnvelope(envelopeMeta, text)

    // Preamble once per session; imported <shared-context> rides between it and the envelope.
    const parts: string[] = []
    if (!this.preambleSent) {
      parts.push(buildPreamble(this.ctx))
      this.preambleSent = true
    }
    if (contextPrefix) parts.push(contextPrefix)
    parts.push(wrapped)
    return parts.join('\n\n')
  }
}
