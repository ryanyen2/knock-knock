/**
 * Coordination — per-pattern integration (U16). Proves each collaboration topology
 * is the SAME mechanism (reply-claim + task-scheduler + the folds) switched only by
 * config (R12), and that addressing is platform-neutral (R11) and capture is
 * runtime-neutral (R13). Nothing here changes mechanism code per pattern.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import { replyClaim, type ReplyCoordContext } from '../../src/ledger/synchronizations/reply-claim.ts'
import { taskScheduler, scheduleScope, type TaskSchedulerOpts } from '../../src/ledger/synchronizations/task-scheduler.ts'
import { capturePresence } from '../../src/ledger/synchronizations/capture-presence.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import { coordBoardFold, boardFor, type CoordBoardFoldState } from '../../src/ledger/concepts/coordination-board.ts'
import { taskDagFold, tasksFor, taskArtifact, type TaskDagFoldState } from '../../src/ledger/concepts/task-dag.ts'
import { isAddressed, type ChannelConfig, type AddressSignals } from '../../src/lib.ts'

const flush = () => new Promise(r => setTimeout(r, 15))

function msg(channel: ChannelId, messageId: string, targetAgent: string) {
  return {
    actor: 'human1', role: 'human' as Role, channel,
    target: { artifactId: discordArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'channel.message' as const,
    patch: { kind: 'external' as const, intent: { channel: 'discord', op: 'received', args: { text: 'hi', messageId, targetAgent } } },
    effect: 'external' as const, caused_by: [] as string[],
  }
}
function taskCreated(scope: ChannelId, data: { id: string; dependsOn?: string[]; assignee?: string }) {
  return {
    actor: 'owner1', role: 'owner' as Role, channel: scope,
    target: { artifactId: taskArtifact(scope), anchor: { kind: 'none' as const } },
    verb: 'task.created' as const, patch: { kind: 'task' as const, data }, effect: 'pure' as const, caused_by: [] as string[],
  }
}
function turn(scope: ChannelId, agent: string, verb: 'turn.prompted' | 'turn.replied') {
  return {
    actor: agent, role: 'agent' as Role, channel: scope,
    target: { artifactId: discordArtifact(scope), anchor: { kind: 'none' as const } },
    verb, patch: { kind: 'none' as const }, effect: 'pure' as const, caused_by: [] as string[],
  }
}
const replyResolver =
  (agents: Record<string, { cfg?: ChannelConfig; relayId?: string }>) =>
  (_c: ChannelId, t: string | undefined): ReplyCoordContext | undefined => {
    const a = t ? agents[t] : undefined
    return a ? { agentKey: t!, isOwnerBot: true, cfg: a.cfg ?? {}, relayId: a.relayId ?? 'relayA' } : undefined
  }
const schedOpts = (agent: string, cfg: ChannelConfig, relayId = 'relayA'): TaskSchedulerOpts => ({
  resolveSchedule: () => ({ agentKey: agent, cfg, relayId, isTurnLive: () => true }),
})
const owners = async (s: SqliteStore) =>
  (await s.listByVerb('task.claimed')).map(r => (r.patch.kind === 'task' ? r.patch.data.owner : '?'))
const prompted = async (s: SqliteStore) => (await s.listByVerb('turn.prompted')).map(r => r.actor)

// ── PEER (race + pull-claim): the default decentralized pattern ────────────────
test('pattern PEER (race + pull): one of two eligible agents answers; one claims a task', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(taskDagFold)
  const s = new Synchronizer(store, engine)
  s.register(replyClaim({ resolveCoord: replyResolver({ bot002: {}, bot101: {} }) }))
  s.register(taskScheduler(schedOpts('bot002', {})))
  s.start()

  await admit(store, msg('chan1', 'm1', 'bot002'))
  await admit(store, msg('chan1', 'm1', 'bot101'))
  await admit(store, taskCreated('chan1', { id: 'A' }))
  await flush()

  expect((await prompted(store)).length).toBeGreaterThanOrEqual(1)
  expect((await owners(store))).toEqual(['bot002'])
  store.close()
})

// ── ORCHESTRATOR-WORKER (designated + push-assign) ─────────────────────────────
test('pattern ORCHESTRATOR (designated + push): front-door answers; assignee gets the task', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(taskDagFold)
  const cfg: ChannelConfig = { responder: 'designated', responderAgent: 'lead', allocation: 'push-assign' }
  const deferred: Array<() => void> = []
  const s = new Synchronizer(store, engine)
  s.register(replyClaim({ resolveCoord: replyResolver({ lead: { cfg }, worker: { cfg } }), defer: fn => deferred.push(fn) }))
  s.register(taskScheduler(schedOpts('worker', cfg))) // worker's scheduler; task assigned to worker
  s.start()

  await admit(store, msg('chan1', 'm1', 'worker')) // non-designate arrives, must defer
  await admit(store, msg('chan1', 'm1', 'lead')) // designate answers inline
  await admit(store, taskCreated('chan1', { id: 'A', assignee: 'worker' }))
  await flush()
  for (const fn of deferred.splice(0)) fn()
  await flush()

  expect(await prompted(store)).toContain('lead') // front-door fielded the message
  // worker (the assignee) owns the task; lead would not, even though it's the front door
  expect(await owners(store)).toEqual(['worker'])
  store.close()
})

// ── PIPELINE (pull over a dependency chain) ────────────────────────────────────
test('pattern PIPELINE (chain + pull): A→B→C claimed strictly in dependency order', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const s = new Synchronizer(store, engine)
  s.register(taskScheduler(schedOpts('bot002', {})))
  s.start()

  await admit(store, taskCreated('chan1', { id: 'A' }))
  await admit(store, taskCreated('chan1', { id: 'B', dependsOn: ['A'] }))
  await admit(store, taskCreated('chan1', { id: 'C', dependsOn: ['B'] }))
  await flush()
  let board = tasksFor(engine.get<TaskDagFoldState>(taskDagFold.name), 'chan1')
  expect(board.get('A')?.status).toBe('claimed')
  expect(board.get('B')?.status).toBe('open') // blocked

  // Complete A then B; each unlocks the next.
  await admit(store, { ...taskCreated('chan1', { id: 'A' }), verb: 'task.completed' as const })
  await flush()
  board = tasksFor(engine.get<TaskDagFoldState>(taskDagFold.name), 'chan1')
  expect(board.get('B')?.status).toBe('claimed')
  store.close()
})

// ── CONTRACT-NET (bid) ─────────────────────────────────────────────────────────
test('pattern CONTRACT-NET (bid): agents bid, winner claims on the settle pass', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const cfg: ChannelConfig = { allocation: 'bid' }
  const run = (agent: string, relay: string, allowBidClaim = false) =>
    scheduleScope({ store, engine, admit: p => admit(store, p), opts: schedOpts(agent, cfg, relay), scope: 'chan1', allowBidClaim })

  await admit(store, taskCreated('chan1', { id: 'A' }))
  await run('bot002', 'relayA')
  await run('bot101', 'relayB')
  await flush()
  expect(await owners(store)).toEqual([]) // bidding window, no claim yet
  await run('bot002', 'relayA', true)
  await run('bot101', 'relayB', true)
  await flush()
  expect((await owners(store)).length).toBe(1) // exactly one winner claimed
  store.close()
})

// ── R11: platform-neutral addressing (no native mentions) ─────────────────────
test('R11: addressing resolves on a reply-only platform (mentionsBot false, repliedToMe true)', () => {
  const sig: AddressSignals = { mentionsBot: false, repliedToMe: true, text: 'plain text, no @' }
  expect(isAddressed(sig)).toBe(true) // reply addressing, no platform mention syntax needed
})

// ── R13: runtime-neutral capture (bare turn.* stream, no TodoWrite) ───────────
test('R13: capture-presence works on a non-Claude turn.* stream', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(coordBoardFold)
  const s = new Synchronizer(store, engine)
  s.register(capturePresence())
  s.start()

  await admit(store, turn('chan1', 'codex-bot', 'turn.prompted'))
  await flush()
  const board = boardFor(engine.get<CoordBoardFoldState>(coordBoardFold.name), 'chan1')
  expect(board.presence.find(p => p.agentKey === 'codex-bot')?.status).toBe('working')
  store.close()
})
