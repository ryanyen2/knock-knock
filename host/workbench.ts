/**
 * Workbench (§4.1) — one pinned per-scope activity log, refreshed as a turn
 * runs (start, each tool step, end) and kept as a trace after it ends. Driven
 * by a relay-level subscriber on the turn/tool verbs that calls `updatePill`.
 *
 * Owns its own throttle + pinned-message bookkeeping; reads the shared Turn
 * fold so a scope served by several agents still renders one board.
 */

import type { HostContext } from './context.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { TURN_FOLD, type TurnFoldState } from '../ledger/concepts/turn.ts'
import { renderWorkbench, workbenchEntries } from '../ledger/render/surface.ts'

/** Max one Workbench edit per scope per this window (Discord rate limit). */
const PILL_THROTTLE_MS = 1500

export class Workbench {
  /** Per-scope pinned pill message id. */
  private readonly pillMsgByChannel = new Map<ChannelId, string>()
  /** Per-scope pending render timer + last render time (throttle). */
  private readonly pillTimers = new Map<ChannelId, ReturnType<typeof setTimeout>>()
  private readonly pillLastRender = new Map<ChannelId, number>()

  constructor(private readonly ctx: HostContext) {}

  /** Cancel any pending renders (host shutdown). */
  stop(): void {
    for (const t of this.pillTimers.values()) clearTimeout(t)
    this.pillTimers.clear()
  }

  /**
   * Request a refresh of this scope's pinned Workbench. Throttled to at most one
   * Discord edit per PILL_THROTTLE_MS per scope (tool events can burst); the
   * trailing render always reads the latest Turn fold state, so the activity log
   * stays current without tripping Discord's edit rate limit.
   */
  updatePill(scopeId: ChannelId): void {
    if (!this.ctx.roomForScope(scopeId)) return
    if (this.pillTimers.has(scopeId)) return // a render is already scheduled
    const since = Date.now() - (this.pillLastRender.get(scopeId) ?? 0)
    const wait = Math.max(0, PILL_THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.pillTimers.delete(scopeId)
      this.pillLastRender.set(scopeId, Date.now())
      void this.renderNow(scopeId)
    }, wait)
    this.pillTimers.set(scopeId, timer)
  }

  /**
   * Render and edit-in-place the Workbench from the Turn fold (shared across
   * agents, so one host renders the whole scope). Created and pinned once;
   * best-effort — a missing Manage-Messages permission just means no pin.
   */
  private async renderNow(scopeId: ChannelId): Promise<void> {
    let text: string
    try {
      const turns = this.ctx.engine.get<TurnFoldState>(TURN_FOLD)
      // Prompt text lives on the inbound message, not the Turn fold — pre-fetch
      // it for each agent's latest turn (working OR finished) so the workbench
      // header shows what was asked, kept as the trace after the turn ends.
      const latest = new Map<string, Hash>()
      const startedAt = new Map<string, string>()
      for (const t of turns.values()) {
        if (t.channel !== scopeId || !t.inboundHash) continue
        const prev = startedAt.get(t.agentKey)
        if (!prev || t.startedAt > prev) {
          startedAt.set(t.agentKey, t.startedAt)
          latest.set(t.agentKey, t.inboundHash)
        }
      }
      const prompts = new Map<Hash, string>()
      for (const inboundHash of new Set(latest.values())) {
        const inbound = await this.ctx.store.getByHash(inboundHash)
        const txt =
          inbound?.patch.kind === 'external'
            ? (inbound.patch.intent.args as { text?: string } | undefined)?.text
            : undefined
        if (txt) prompts.set(inboundHash, txt)
      }
      const entries = workbenchEntries(turns, scopeId, h => (h ? prompts.get(h) : undefined))
      text = renderWorkbench(entries, new Date().toISOString())
    } catch {
      return // Turn fold not registered — pill is off.
    }
    const caps = this.ctx.messaging.capabilities()
    const existing = this.pillMsgByChannel.get(scopeId)
    // Edit the existing pill in place where the platform supports it (Discord
    // does). If the edit can't land (pill deleted), fall through to re-post —
    // matching the original fetch-then-edit-or-send behavior exactly.
    if (existing && caps.edit) {
      const ok = await this.ctx.messaging.edit({ id: existing, scope: scopeId }, text).catch(() => false)
      if (ok) return
    }
    const ref = await this.ctx.messaging.send(scopeId, text).catch(() => undefined)
    if (!ref) return
    this.pillMsgByChannel.set(scopeId, ref.id)
    this.ctx.noteBotMsg(ref.id)
    if (caps.pin) void this.ctx.messaging.pin(ref).catch(() => {})
  }
}
