// Billboard — the shared, pinned coordination snapshot for a scope (the no-Postgres
// mesh's visible payoff): WHO is here + what each is doing + the task DAG (○/◐/✓).
// ONE bot maintains it — the deterministically elected scribe (electScribe), so N
// co-resident/cross-machine bots don't each pin their own, and the role fails over for
// free if the scribe leaves. Mesh-gated: the host only constructs it when mesh is on.
//
// Mirrors ConfigCard's throttle + in-flight + edit-in-place machinery; the only
// differences are the scribe gate and what it renders.

import type { HostContext } from './context.ts'
import type { ChannelId } from '../ledger/interaction.ts'
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
import { renderBillboard, electScribe } from '../lib.ts'

const CARD_THROTTLE_MS = 2000
const REPOST_AFTER_EDIT_FAILURES = 3

export class Billboard {
  private readonly msgByScope = new Map<ChannelId, string>()
  private readonly timers = new Map<ChannelId, ReturnType<typeof setTimeout>>()
  private readonly lastRender = new Map<ChannelId, number>()
  private readonly editFailures = new Map<ChannelId, number>()
  private readonly rendering = new Set<ChannelId>()
  private readonly dirty = new Set<ChannelId>()
  private stopped = false

  constructor(private readonly ctx: HostContext) {}

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Request a billboard refresh for a scope. Throttled; a no-op unless this bot is
   *  the elected scribe for the scope's room. */
  refresh(scopeId: ChannelId): void {
    const roomId = this.ctx.roomForScope(scopeId)
    if (this.stopped || !roomId) return
    if (!this.isScribe(roomId)) return // exactly one bot maintains the pin
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

  /** Am I the deterministically-elected scribe among the directory bots serving this
   *  room? Every relay computes the same answer; if the scribe leaves the directory,
   *  electScribe promotes the next bot automatically. */
  private isScribe(roomId: ChannelId): boolean {
    let present: string[]
    try {
      present = directoryFor(this.ctx.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
        .filter(id => id.platform === this.ctx.messaging.platform && id.rooms.includes(roomId))
        .map(id => id.agentKey)
    } catch {
      return false // directory fold not registered
    }
    if (!present.includes(this.ctx.key)) present.push(this.ctx.key) // include myself
    return electScribe(present) === this.ctx.key
  }

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

  private async renderNow(scopeId: ChannelId, roomId: ChannelId): Promise<void> {
    let text: string
    try {
      const roster = directoryFor(this.ctx.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
        .filter(id => id.platform === this.ctx.messaging.platform && id.rooms.includes(roomId))
        .map(id => ({ agentKey: id.agentKey, label: id.label }))
      const presence = boardFor(this.ctx.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), scopeId).presence
      const tasks = [...tasksFor(this.ctx.engine.get<TaskDagFoldState>(TASK_DAG_FOLD), scopeId).values()]
      text = renderBillboard(roster, presence, tasks)
    } catch {
      return // a fold isn't registered — no billboard
    }
    if (!text) return // nothing to show yet

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
      const failures = (this.editFailures.get(scopeId) ?? 0) + 1
      if (failures < REPOST_AFTER_EDIT_FAILURES) {
        this.editFailures.set(scopeId, failures)
        return
      }
      this.editFailures.delete(scopeId)
      this.msgByScope.delete(scopeId)
    }
    if (this.stopped) return
    const ref = await this.ctx.messaging.send(scopeId, text, { suppressMentions: true }).catch(() => undefined)
    if (!ref) return
    this.msgByScope.set(scopeId, ref.id)
    this.ctx.noteBotMsg(ref.id)
    if (caps.pin) void this.ctx.messaging.pin(ref).catch(() => {})
  }
}
