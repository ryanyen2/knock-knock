// ConfigCard — the pinned per-thread setup card (resolved config + context-note
// count), refreshed on thread spawn and on `!config`/`!context` edits. Thread
// scopes only; owns the pin.

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
/** Consecutive edit failures before assuming the card was deleted and reposting
 *  (a single failure is transient; reposting early accumulates duplicate pins). */
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

  /** Request a refresh of this scope's pinned card (thread scopes only; a plain
   *  channel is skipped). Throttled per CARD_THROTTLE_MS. */
  refresh(scopeId: ChannelId): void {
    const roomId = this.ctx.roomForScope(scopeId)
    if (this.stopped || !roomId || roomId === scopeId) return // not served, or not a thread
    if (this.rendering.has(scopeId)) {
      this.dirty.add(scopeId)
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

  /** One render pass with a per-scope in-flight guard so concurrent edits can't race. */
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
   *  the pinned card; create + pin on first render. Best-effort. */
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
      // Treat a failed edit as transient: retry next refresh, repost only after
      // REPOST_AFTER_EDIT_FAILURES (reposting early accumulates duplicate pins).
      const failures = (this.editFailures.get(scopeId) ?? 0) + 1
      if (failures < REPOST_AFTER_EDIT_FAILURES) {
        this.editFailures.set(scopeId, failures)
        return
      }
      this.editFailures.delete(scopeId)
      this.cardMsgByScope.delete(scopeId)
    }
    if (this.stopped) return // shut down while awaiting
    const ref = await this.ctx.messaging.send(scopeId, text).catch(() => undefined)
    if (!ref) return
    this.cardMsgByScope.set(scopeId, ref.id)
    this.ctx.noteBotMsg(ref.id)
    if (caps.pin) void this.ctx.messaging.pin(ref).catch(() => {})
  }
}
