/**
 * Workbench (§4.1) — a per-TURN activity log, refreshed as a turn runs (start,
 * each tool step, end) and kept as a trace after it ends. Driven by a relay-level
 * subscriber on the turn/tool verbs that resolves the turn and calls
 * `updateForTurn`.
 *
 * One message per turn (per agent-tag "call"), posted inline and edited in place
 * as the turn progresses — it is NOT pinned. The pinned slot in a thread belongs
 * to the ConfigCard (the thread's current setup); the workbench is the live
 * activity for one call, left as a trace once the turn finishes.
 *
 * Owns its own throttle + per-turn message bookkeeping; reads the shared Turn
 * fold so a turn's board renders from one source.
 */

import type { HostContext } from './context.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { TURN_FOLD, type TurnFoldState } from '../ledger/concepts/turn.ts'
import { CONFIG_FOLD, resolveConfigFor, type ConfigFoldState } from '../ledger/concepts/config.ts'
import { renderWorkbench, workbenchEntryForTurn } from '../ledger/render/surface.ts'

/** Max one Workbench edit per turn per this window (Discord rate limit). */
const PILL_THROTTLE_MS = 1500
/** Cap on tracked turns. A turn's bookkeeping (message id, last-render time) is
 *  kept after the turn ends so a late edit lands on the same message; over a
 *  long-lived relay that is unbounded, so FIFO-evict the oldest beyond this. */
const MAX_TRACKED_TURNS = 500

export class Workbench {
  /** Per-turn (promptHash) message id. */
  private readonly msgByTurn = new Map<Hash, string>()
  /** Per-turn pending render timer + last render time (throttle). */
  private readonly timers = new Map<Hash, ReturnType<typeof setTimeout>>()
  private readonly lastRender = new Map<Hash, number>()
  /** Turns with a render in flight — guards against a slow render racing a newly
   *  scheduled one (the timer is dropped before the async render starts). */
  private readonly rendering = new Set<Hash>()
  /** Turns asked to refresh while a render was in flight — re-rendered once after. */
  private readonly dirty = new Set<Hash>()
  /** Set on shutdown so a render that resolves after stop() never posts/edits. */
  private stopped = false

  constructor(private readonly ctx: HostContext) {}

  /** Cancel any pending renders (host shutdown) and suppress in-flight ones. */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * Request a refresh of a turn's activity log. Throttled to at most one Discord
   * edit per PILL_THROTTLE_MS per turn (tool events can burst); the trailing
   * render always reads the latest Turn fold state, so the log stays current
   * without tripping Discord's edit rate limit. A request that arrives while a
   * render is in flight sets a dirty bit so the final state isn't lost.
   */
  updateForTurn(scopeId: ChannelId, promptHash: Hash): void {
    if (this.stopped || !this.ctx.roomForScope(scopeId)) return
    if (this.rendering.has(promptHash)) {
      this.dirty.add(promptHash) // re-render once the in-flight render finishes
      return
    }
    if (this.timers.has(promptHash)) return // a render is already scheduled
    const since = Date.now() - (this.lastRender.get(promptHash) ?? 0)
    const wait = Math.max(0, PILL_THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.timers.delete(promptHash)
      void this.renderTick(scopeId, promptHash)
    }, wait)
    this.timers.set(promptHash, timer)
  }

  /** One render pass with a per-turn in-flight guard: only one renderNow runs per
   *  turn at a time, so a slow Discord round-trip can't race a freshly scheduled
   *  render into a concurrent edit. A refresh requested mid-render re-runs after. */
  private async renderTick(scopeId: ChannelId, promptHash: Hash): Promise<void> {
    if (this.rendering.has(promptHash)) {
      this.dirty.add(promptHash)
      return
    }
    this.rendering.add(promptHash)
    this.lastRender.set(promptHash, Date.now())
    // Defensive bound: a turn that renders but never sends (fold not ready) leaves
    // only a lastRender entry, which track() can't prune — FIFO-evict the oldest.
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

  /**
   * Render and edit-in-place one turn's Workbench from the Turn fold. The first
   * render posts a new (unpinned) message for this turn; later renders edit it.
   * Best-effort — a missing send/edit permission just means no board.
   */
  private async renderNow(scopeId: ChannelId, promptHash: Hash): Promise<void> {
    if (this.stopped) return
    let text: string
    try {
      const turns = this.ctx.engine.get<TurnFoldState>(TURN_FOLD)
      const turn = turns.get(promptHash)
      if (!turn) return
      // Prompt text lives on the inbound message, not the Turn fold — pre-fetch it
      // so the workbench header shows what was asked (kept as the trace).
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
      // Per-thread Workbench verbosity (owner `!config workbench …`), resolved
      // scope→room; defaults to 'normal' if unset or the fold isn't registered.
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
    // Edit the existing per-turn message in place where supported; if the edit
    // can't land (message deleted), fall through to re-post.
    if (existing && caps.edit) {
      const ok = await this.ctx.messaging.edit({ id: existing, scope: scopeId }, text).catch(() => false)
      if (ok) return
    }
    if (this.stopped) return // shut down while awaiting — don't post to a dead client
    const ref = await this.ctx.messaging.send(scopeId, text).catch(() => undefined)
    if (!ref) return
    this.track(promptHash, ref.id)
    this.ctx.noteBotMsg(ref.id)
  }

  /** Record a turn's message id, FIFO-evicting the oldest tracked turn beyond the
   *  cap so per-turn bookkeeping can't grow without bound over a long-lived relay. */
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
