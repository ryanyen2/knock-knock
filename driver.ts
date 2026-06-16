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
  /** Whether the identity/roster preamble has been sent on this session yet.
   *  Tracked separately from sessionId so a *resumed* foreign session (bound via
   *  bindSession, sessionId already set) still gets the room preamble once. */
  private preambleSent = false
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

  /** Bind this driver to an existing runtime session id, to be resumed on the
   *  next turn (owner "resume session", or a persisted binding after restart).
   *  Resets the preamble flag so the resumed session is (re)told the room
   *  context, which it has no way of knowing.
   *
   *  Enqueued onto the same serialized queue as runTurn: a resume issued while a
   *  turn is in flight must not race that turn's own `this.sessionId = result`
   *  write — the bind lands after the in-flight turn and before the next one. */
  bindSession(sessionId: string): void {
    this.queue = this.queue.then(() => {
      this.sessionId = sessionId
      this.preambleSent = false
    })
  }

  /** Enqueue a turn; runs serially so concurrent messages don't corrupt session state.
   *  `contextPrefix` (e.g. an imported <shared-context> block) is prepended once,
   *  ahead of the <channel> envelope, on this turn only.
   *  `profile`, when given, is re-applied to the adapter BEFORE this turn runs —
   *  this is the per-actor permission floor (resolved from who prompted the turn).
   *  Applying it inside the serialized queue guarantees each turn enforces its own
   *  requester's floor with no cross-turn race. */
  runTurn(
    text: string,
    meta: TurnMeta,
    signal?: AbortSignal,
    contextPrefix?: string,
    profile?: PermissionProfile,
  ): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      this.queue = this.queue.then(async () => {
        try {
          if (profile) this.adapter.applyPolicy(profile)
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

    // Send the identity/roster/priority preamble once per session (the first
    // turn, or the first turn after a resume bind). Imported <shared-context>,
    // when present, rides between the preamble and the <channel> envelope so it
    // reads as reference, not as the sender's message.
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
