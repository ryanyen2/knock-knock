/**
 * Driver — one live agent conversation.
 * Owns a sessionId, a per-session turn queue (so concurrent messages can't
 * race), and one AgentAdapter. The relay holds Drivers in its routing table;
 * a Driver never holds other Drivers.
 *
 * When a PreambleContext is supplied, the collaborative layer rides in the
 * prompt *text* — the AgentAdapter seam stays a plain prompt/response contract:
 *   • First turn: buildPreamble(ctx) prepended (identity, roster, role priority)
 *   • Every turn:  wrapEnvelope(meta, text)  (<channel kind=…> wrapper)
 */

import type { AgentAdapter, PermissionProfile, Verdict } from './agent-adapter.ts'
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
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly sessionKey: string,
    profile: PermissionProfile,
    permissionHandler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
    /** Collaborative context — when provided, injects identity/roster/role-priority
     *  preamble on the first turn and wraps every turn in a <channel> envelope.
     *  Omit for a plain-text session (e.g. an agent with no room config). */
    private readonly ctx?: PreambleContext,
  ) {
    adapter.applyPolicy(profile)
    adapter.onPermissionRequest(permissionHandler)
  }

  /** Enqueue a turn; runs serially so concurrent messages don't corrupt session state.
   *  `contextPrefix` (e.g. an imported <shared-context> block) is prepended once,
   *  ahead of the <channel> envelope, on this turn only. */
  runTurn(text: string, meta: TurnMeta, signal?: AbortSignal, contextPrefix?: string): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      this.queue = this.queue.then(async () => {
        try {
          const prompt = this.buildPrompt(text, meta, contextPrefix)
          const result = await this.adapter.prompt({ text: prompt, sessionId: this.sessionId, signal })
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
      // No collaborative context — send raw text, with any imported context ahead.
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

    // On the first turn of a new session, prepend the identity/roster/priority preamble.
    // Subsequent turns of the same session already have context from the preamble.
    // Imported <shared-context>, when present, rides between the preamble and the
    // <channel> envelope so it reads as reference, not as the sender's message.
    const isFirstTurn = this.sessionId === undefined
    const parts: string[] = []
    if (isFirstTurn) parts.push(buildPreamble(this.ctx))
    if (contextPrefix) parts.push(contextPrefix)
    parts.push(wrapped)
    return parts.join('\n\n')
  }
}
