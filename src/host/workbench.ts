// Workbench — the single per-scope status surface, posted inline (not pinned) and edited
// in place as work runs. Combines the shared coordination snapshot (WHO is here + the task
// DAG) with each active agent's live activity log, both read from the shared folds. ONE bot
// maintains it — the deterministically elected scribe (electScribe) — so N co-resident /
// cross-machine bots don't each post their own copy; the role fails over for free if the
// scribe leaves. Replaces the old per-turn workbench + the separately-pinned Billboard.

import type { HostContext } from './context.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import { TURN_FOLD, type TurnFoldState } from '../ledger/concepts/turn.ts'
import { CONFIG_FOLD, resolveConfigFor, type ConfigFoldState } from '../ledger/concepts/config.ts'
import {
  AGENT_DIRECTORY_FOLD,
  directoryFor,
  type AgentDirectoryFoldState,
} from '../ledger/concepts/agent-directory.ts'
import {
  COORD_BOARD_FOLD,
  boardFor,
  type CoordBoardFoldState,
} from '../ledger/concepts/coordination-board.ts'
import { TASK_DAG_FOLD, tasksFor, type TaskDagFoldState } from '../ledger/concepts/task-dag.ts'
import { renderWorkbench, workbenchEntries } from '../ledger/render/surface.ts'
import { renderBillboard, electScribe } from '../lib.ts'

/** Max one edit per scope per this window (platform rate limit). */
const THROTTLE_MS = 1500
/** Consecutive edit failures before assuming the message was deleted and reposting. */
const REPOST_AFTER_EDIT_FAILURES = 3

export class Workbench {
  /** Per-scope status message id. */
  private readonly msgByScope = new Map<ChannelId, string>()
  private readonly timers = new Map<ChannelId, ReturnType<typeof setTimeout>>()
  private readonly lastRender = new Map<ChannelId, number>()
  private readonly editFailures = new Map<ChannelId, number>()
  /** Scopes with a render in flight — guards a slow render against a concurrent one. */
  private readonly rendering = new Set<ChannelId>()
  /** Scopes asked to refresh mid-render — re-rendered once after. */
  private readonly dirty = new Set<ChannelId>()
  /** Set on shutdown so a render resolving after stop() never posts/edits. */
  private stopped = false

  constructor(private readonly ctx: HostContext) {}

  /** Cancel any pending renders (host shutdown) and suppress in-flight ones. */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Request a refresh of a scope's status surface; throttled per THROTTLE_MS, with a
   *  dirty bit so a request mid-render isn't lost. A no-op unless this bot is the elected
   *  scribe for the scope's room (so exactly one bot owns the surface). */
  refresh(scopeId: ChannelId): void {
    const roomId = this.ctx.roomForScope(scopeId)
    if (this.stopped || !roomId) return
    if (!this.isScribe(roomId)) return // exactly one bot maintains the surface
    if (this.rendering.has(scopeId)) {
      this.dirty.add(scopeId)
      return
    }
    if (this.timers.has(scopeId)) return // already scheduled
    const since = Date.now() - (this.lastRender.get(scopeId) ?? 0)
    const wait = Math.max(0, THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.timers.delete(scopeId)
      void this.renderTick(scopeId, roomId)
    }, wait)
    this.timers.set(scopeId, timer)
  }

  /** Am I the deterministically-elected scribe among the directory bots serving this room?
   *  Every relay computes the same answer; electScribe promotes the next bot automatically
   *  if the scribe leaves. Falls back to TRUE when the directory fold is unregistered/empty
   *  (a lone bot owns its own surface). */
  private isScribe(roomId: ChannelId): boolean {
    let present: string[]
    try {
      present = directoryFor(this.ctx.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
        .filter(id => id.platform === this.ctx.messaging.platform && id.rooms.includes(roomId))
        .map(id => id.agentKey)
    } catch {
      return true // directory fold not registered — lone bot owns its surface
    }
    if (!present.includes(this.ctx.key)) present.push(this.ctx.key) // include myself
    return electScribe(present) === this.ctx.key
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

  /** Render the combined coordination + activity surface from the shared folds and
   *  edit-in-place; first render posts a new (unpinned) message. Skips entirely when there
   *  is nothing to show. Best-effort. */
  private async renderNow(scopeId: ChannelId, roomId: ChannelId): Promise<void> {
    if (this.stopped) return
    let text: string
    try {
      const turns = this.ctx.engine.get<TurnFoldState>(TURN_FOLD)

      // Coordination block (best-effort; '' when its folds are absent or there's nothing yet).
      let coord = ''
      try {
        const roster = directoryFor(this.ctx.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
          .filter(id => id.platform === this.ctx.messaging.platform && id.rooms.includes(roomId))
          .map(id => ({ agentKey: id.agentKey, label: id.label }))
        const presence = boardFor(this.ctx.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), scopeId).presence
        const tasks = [...tasksFor(this.ctx.engine.get<TaskDagFoldState>(TASK_DAG_FOLD), scopeId).values()]
        coord = renderBillboard(roster, presence, tasks)
      } catch {
        /* coordination folds not registered — coordination block stays empty */
      }

      // Activity block: one entry per agent active in this scope. Prompt text lives on the
      // inbound message, not the Turn fold — pre-fetch it for each entry's latest turn so
      // the (sync) render resolver can read it.
      const prompts = await this.prefetchPrompts(turns, scopeId)
      const entries = workbenchEntries(turns, scopeId, h => (h ? prompts.get(h) : undefined))
      if (entries.length === 0 && !coord) return // nothing to show — don't post

      const verbosity = this.verbosityFor(roomId, scopeId)
      const blocks = [coord, entries.length ? renderWorkbench(entries, new Date().toISOString(), verbosity) : '']
      text = blocks.filter(Boolean).join('\n\n')
    } catch {
      return // Turn fold not registered — surface is off
    }
    if (!text) return

    const caps = this.ctx.messaging.capabilities()
    const existing = this.msgByScope.get(scopeId)
    if (existing && caps.edit) {
      const ok = await this.ctx.messaging
        .edit({ id: existing, scope: scopeId }, text, { suppressMentions: true })
        .catch(() => false)
      if (ok) {
        this.editFailures.delete(scopeId)
        return
      }
      // Treat a failed edit as transient; repost only after REPOST_AFTER_EDIT_FAILURES
      // (reposting early accumulates duplicate surfaces).
      const failures = (this.editFailures.get(scopeId) ?? 0) + 1
      if (failures < REPOST_AFTER_EDIT_FAILURES) {
        this.editFailures.set(scopeId, failures)
        return
      }
      this.editFailures.delete(scopeId)
      this.msgByScope.delete(scopeId)
    }
    if (this.stopped) return // shut down while awaiting
    const ref = await this.ctx.messaging.send(scopeId, text, { suppressMentions: true }).catch(() => undefined)
    if (!ref) return
    this.msgByScope.set(scopeId, ref.id)
    this.ctx.noteBotMsg(ref.id)
  }

  /** Pre-fetch the inbound prompt text for each agent's latest turn in `scopeId`, keyed by
   *  inboundHash — bounded by the number of active agents (not the turn history). */
  private async prefetchPrompts(turns: TurnFoldState, scopeId: ChannelId): Promise<Map<string, string>> {
    const latest = new Map<string, { startedAt: string; inboundHash?: string }>()
    for (const t of turns.values()) {
      if (t.channel !== scopeId) continue
      const prev = latest.get(t.agentKey)
      if (!prev || t.startedAt > prev.startedAt) latest.set(t.agentKey, t)
    }
    const out = new Map<string, string>()
    for (const t of latest.values()) {
      if (!t.inboundHash) continue
      const inbound = await this.ctx.store.getByHash(t.inboundHash).catch(() => undefined)
      const txt =
        inbound?.patch.kind === 'external'
          ? (inbound.patch.intent.args as { text?: string } | undefined)?.text
          : undefined
      if (txt) out.set(t.inboundHash, txt)
    }
    return out
  }

  /** Per-thread verbosity, resolved scope→room; defaults to 'normal'. */
  private verbosityFor(roomId: ChannelId, scopeId: ChannelId): 'quiet' | 'normal' | 'verbose' {
    try {
      return (
        resolveConfigFor(this.ctx.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId, scopeId)
          .workbenchVerbosity || 'normal'
      )
    } catch {
      return 'normal'
    }
  }
}
