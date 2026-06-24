/**
 * ConfigCard — the pinned per-thread "setup" card.
 *
 * In a task thread the pinned slot shows the resolved config (persona, objective,
 * model/thinking/effort, permission mode) and the attached context-note count, so
 * the owner always sees the current setup. Refreshed when a task thread is
 * created and whenever `!config` / `!context` edits land. The Workbench no longer
 * pins (it posts a per-turn activity log inline) — the card owns the pin.
 *
 * A per-thread concept: only thread scopes get a card (a plain channel, where a
 * top-level task spawns its own thread, does not). Modeled on Workbench — owns
 * its own throttle + pinned-message bookkeeping; reads the shared folds.
 */

import type { HostContext } from './context.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import { CONFIG_FOLD, configFor, type ConfigFoldState } from '../ledger/concepts/config.ts'
import {
  KNOWLEDGE_FOLD,
  activeNotes,
  type KnowledgeFoldState,
} from '../ledger/artifacts/knowledge.ts'
import { renderConfigCard } from '../ledger/render/surface.ts'

/** Max one card edit per scope per this window (Discord rate limit). */
const CARD_THROTTLE_MS = 1500
/** Consecutive failed edits before we assume the pinned card was deleted and
 *  repost it. A single failed edit is treated as transient — reposting on it
 *  would leave the old card pinned and accumulate duplicate pins (no unpin in
 *  the messaging seam), so we retry the edit on the next refresh instead. */
const REPOST_AFTER_EDIT_FAILURES = 3

export class ConfigCard {
  /** Per-scope pinned card message id. */
  private readonly cardMsgByScope = new Map<ChannelId, string>()
  private readonly timers = new Map<ChannelId, ReturnType<typeof setTimeout>>()
  private readonly lastRender = new Map<ChannelId, number>()
  /** Per-scope consecutive edit-failure count (reset on a successful edit). */
  private readonly editFailures = new Map<ChannelId, number>()
  /** Scopes with a render in flight — guards a slow render against a concurrent one. */
  private readonly rendering = new Set<ChannelId>()
  private readonly dirty = new Set<ChannelId>()
  private stopped = false

  constructor(private readonly ctx: HostContext) {}

  /** Cancel any pending renders (host shutdown) and suppress in-flight ones. */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * Request a refresh of this scope's pinned config card. The card is a
   * per-thread concept, so a scope that IS its own room (a plain channel) is
   * skipped — its tasks run in spawned threads, which each get their own card.
   * Throttled to at most one Discord edit per CARD_THROTTLE_MS per scope.
   */
  refresh(scopeId: ChannelId): void {
    const roomId = this.ctx.roomForScope(scopeId)
    if (this.stopped || !roomId || roomId === scopeId) return // not served, or not a thread
    if (this.rendering.has(scopeId)) {
      this.dirty.add(scopeId) // re-render once the in-flight render finishes
      return
    }
    if (this.timers.has(scopeId)) return
    const since = Date.now() - (this.lastRender.get(scopeId) ?? 0)
    const wait = Math.max(0, CARD_THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.timers.delete(scopeId)
      void this.renderTick(scopeId, roomId)
    }, wait)
    this.timers.set(scopeId, timer)
  }

  /** One render pass with a per-scope in-flight guard so a slow Discord
   *  round-trip can't race a freshly-scheduled render into a concurrent edit. */
  private async renderTick(scopeId: ChannelId, roomId: ChannelId): Promise<void> {
    if (this.rendering.has(scopeId)) {
      this.dirty.add(scopeId)
      return
    }
    this.rendering.add(scopeId)
    this.lastRender.set(scopeId, Date.now())
    try {
      await this.renderNow(scopeId, roomId)
    } finally {
      this.rendering.delete(scopeId)
      if (this.dirty.delete(scopeId) && !this.stopped) this.refresh(scopeId)
    }
  }

  /** Render the resolved (thread ⊕ room) config + context count and edit-in-place
   *  the pinned card; create + pin it on first render. Best-effort. */
  private async renderNow(scopeId: ChannelId, roomId: ChannelId): Promise<void> {
    let text: string
    try {
      const cfgState = this.ctx.engine.get<ConfigFoldState>(CONFIG_FOLD)
      const roomCfg = configFor(cfgState, roomId)
      const scopeCfg = configFor(cfgState, scopeId)
      let count = 0
      try {
        const kState = this.ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
        count = activeNotes(kState, `know:channel/${scopeId}/shared-context`).length
      } catch {
        /* knowledge fold not registered — count stays 0 */
      }
      text = renderConfigCard(roomCfg, scopeCfg, count)
    } catch {
      return // config fold not registered — no card
    }

    const caps = this.ctx.messaging.capabilities()
    const existing = this.cardMsgByScope.get(scopeId)
    if (existing && caps.edit) {
      const ok = await this.ctx.messaging.edit({ id: existing, scope: scopeId }, text).catch(() => false)
      if (ok) {
        this.editFailures.delete(scopeId)
        return
      }
      // A failed edit is treated as transient: there is no unpin/delete in the
      // messaging seam, so reposting now would leave the old card pinned and
      // accumulate duplicate pins. Retry the edit on the next refresh; only after
      // REPOST_AFTER_EDIT_FAILURES consecutive failures do we assume the message
      // was actually deleted and fall through to repost.
      const failures = (this.editFailures.get(scopeId) ?? 0) + 1
      if (failures < REPOST_AFTER_EDIT_FAILURES) {
        this.editFailures.set(scopeId, failures)
        return
      }
      this.editFailures.delete(scopeId)
      this.cardMsgByScope.delete(scopeId)
    }
    if (this.stopped) return // shut down while awaiting — don't post to a dead client
    const ref = await this.ctx.messaging.send(scopeId, text).catch(() => undefined)
    if (!ref) return
    this.cardMsgByScope.set(scopeId, ref.id)
    this.ctx.noteBotMsg(ref.id)
    if (caps.pin) void this.ctx.messaging.pin(ref).catch(() => {})
  }
}
