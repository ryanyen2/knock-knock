// Workbench — a per-turn activity log, posted inline (not pinned) and edited in
// place as the turn runs, then kept as a trace. Reads the shared Turn fold.

import type { HostContext } from './context.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { TURN_FOLD, type TurnFoldState } from '../ledger/concepts/turn.ts'
import { CONFIG_FOLD, resolveConfigFor, type ConfigFoldState } from '../ledger/concepts/config.ts'
import { renderWorkbench, workbenchEntryForTurn } from '../ledger/render/surface.ts'

/** Max one Workbench edit per turn per this window (Discord rate limit). */
const PILL_THROTTLE_MS = 1500
/** Cap on tracked turns; FIFO-evict the oldest beyond this. */
const MAX_TRACKED_TURNS = 500

export class Workbench {
  /** Per-turn (promptHash) message id. */
  private readonly msgByTurn = new Map<Hash, string>()
  private readonly timers = new Map<Hash, ReturnType<typeof setTimeout>>()
  private readonly lastRender = new Map<Hash, number>()
  /** Turns with a render in flight — guards a slow render against a newly scheduled one. */
  private readonly rendering = new Set<Hash>()
  /** Turns asked to refresh mid-render — re-rendered once after. */
  private readonly dirty = new Set<Hash>()
  /** Set on shutdown so a render resolving after stop() never posts/edits. */
  private stopped = false

  constructor(private readonly ctx: HostContext) {}

  /** Cancel any pending renders (host shutdown) and suppress in-flight ones. */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Request a refresh of a turn's activity log; throttled per PILL_THROTTLE_MS,
   *  with a dirty bit so a request mid-render isn't lost. */
  updateForTurn(scopeId: ChannelId, promptHash: Hash): void {
    if (this.stopped || !this.ctx.roomForScope(scopeId)) return
    if (this.rendering.has(promptHash)) {
      this.dirty.add(promptHash)
      return
    }
    if (this.timers.has(promptHash)) return // already scheduled
    const since = Date.now() - (this.lastRender.get(promptHash) ?? 0)
    const wait = Math.max(0, PILL_THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.timers.delete(promptHash)
      void this.renderTick(scopeId, promptHash)
    }, wait)
    this.timers.set(promptHash, timer)
  }

  /** One render pass with a per-turn in-flight guard so concurrent edits can't race. */
  private async renderTick(scopeId: ChannelId, promptHash: Hash): Promise<void> {
    if (this.rendering.has(promptHash)) {
      this.dirty.add(promptHash)
      return
    }
    this.rendering.add(promptHash)
    this.lastRender.set(promptHash, Date.now())
    // Bound lastRender entries track() can't prune (rendered but never sent).
    while (this.lastRender.size > MAX_TRACKED_TURNS * 2) {
      const oldest = this.lastRender.keys().next().value
      if (oldest === undefined) break
      this.lastRender.delete(oldest)
    }
    try {
      await this.renderNow(scopeId, promptHash)
    } finally {
      this.rendering.delete(promptHash)
      if (this.dirty.delete(promptHash) && !this.stopped) this.updateForTurn(scopeId, promptHash)
    }
  }

  /** Render + edit-in-place one turn's Workbench from the Turn fold (first render
   *  posts a new unpinned message). Best-effort. */
  private async renderNow(scopeId: ChannelId, promptHash: Hash): Promise<void> {
    if (this.stopped) return
    let text: string
    try {
      const turns = this.ctx.engine.get<TurnFoldState>(TURN_FOLD)
      const turn = turns.get(promptHash)
      if (!turn) return
      // Prompt text lives on the inbound message, not the Turn fold — pre-fetch it.
      let promptText: string | undefined
      if (turn.inboundHash) {
        const inbound = await this.ctx.store.getByHash(turn.inboundHash)
        promptText =
          inbound?.patch.kind === 'external'
            ? (inbound.patch.intent.args as { text?: string } | undefined)?.text
            : undefined
      }
      const entry = workbenchEntryForTurn(turns, promptHash, () => promptText)
      if (!entry) return
      // Per-thread verbosity, resolved scope→room; defaults to 'normal'.
      const roomId = this.ctx.roomForScope(scopeId)
      let verbosity: 'quiet' | 'normal' | 'verbose' = 'normal'
      try {
        verbosity =
          (roomId &&
            resolveConfigFor(this.ctx.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId, scopeId)
              .workbenchVerbosity) ||
          'normal'
      } catch {
        /* config fold not registered — keep 'normal' */
      }
      text = renderWorkbench([entry], new Date().toISOString(), verbosity)
    } catch {
      return // Turn fold not registered — workbench is off.
    }
    const caps = this.ctx.messaging.capabilities()
    const existing = this.msgByTurn.get(promptHash)
    // Edit in place where supported; fall through to re-post if the edit can't land.
    if (existing && caps.edit) {
      const ok = await this.ctx.messaging
        .edit({ id: existing, scope: scopeId }, text, { suppressMentions: true })
        .catch(() => false)
      if (ok) return
    }
    if (this.stopped) return // shut down while awaiting
    const ref = await this.ctx.messaging.send(scopeId, text, { suppressMentions: true }).catch(() => undefined)
    if (!ref) return
    this.track(promptHash, ref.id)
    this.ctx.noteBotMsg(ref.id)
  }

  /** Record a turn's message id, FIFO-evicting the oldest beyond the cap. */
  private track(promptHash: Hash, msgId: string): void {
    this.msgByTurn.set(promptHash, msgId)
    while (this.msgByTurn.size > MAX_TRACKED_TURNS) {
      const oldest = this.msgByTurn.keys().next().value
      if (oldest === undefined) break
      this.msgByTurn.delete(oldest)
      this.lastRender.delete(oldest)
    }
  }
}
