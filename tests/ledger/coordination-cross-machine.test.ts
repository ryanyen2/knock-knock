/**
 * Coordination — cross-machine convergence battery (U11). The ship gate: the
 * decisions hold regardless of which policy is selected and which relay acts.
 *
 * Two FoldEngines share ONE SqliteStore — the same in-process `subscribe` both
 * receive on each insert, mirroring what `LISTEN interaction_inserted` delivers
 * across machines on the Postgres path (same Interaction, same step order,
 * byte-identical fold output). external_claim contention resolves by the store's
 * row lock, NOT by NOTIFY — so exactly-one holds even under delivery skew.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import { replyClaim, type ReplyCoordContext } from '../../src/ledger/synchronizations/reply-claim.ts'
import { taskScheduler, type TaskSchedulerOpts } from '../../src/ledger/synchronizations/task-scheduler.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import { taskDagFold, tasksFor, taskArtifact, type TaskDagFoldState } from '../../src/ledger/concepts/task-dag.ts'
import { projectTaskDag, readyTasks, type ChannelConfig } from '../../src/lib.ts'

const flush = () => new Promise(r => setTimeout(r, 15))

function channelMessage(channel: ChannelId, messageId: string, targetAgent: string) {
  return {
    actor: 'human1',
    role: 'human' as Role,
    channel,
    target: { artifactId: discordArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'channel.message' as const,
    patch: { kind: 'external' as const, intent: { channel: 'discord', op: 'received', args: { text: 'hi', messageId, targetAgent } } },
    effect: 'external' as const,
    caused_by: [] as string[],
  }
}

function taskOp(scope: ChannelId, verb: 'task.created', data: { id: string; assignee?: string }) {
  return {
    actor: 'owner1',
    role: 'owner' as Role,
    channel: scope,
    target: { artifactId: taskArtifact(scope), anchor: { kind: 'none' as const } },
    verb,
    patch: { kind: 'task' as const, data },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

const coordResolver =
  (agent: string, relayId: string, cfg: ChannelConfig = {}) =>
  (_c: ChannelId, target: string | undefined): ReplyCoordContext | undefined =>
    target === agent ? { agentKey: agent, isOwnerBot: true, cfg, relayId } : undefined

const schedOpts = (agent: string, relayId: string, cfg: ChannelConfig = {}): TaskSchedulerOpts => ({
  resolveSchedule: () => ({ agentKey: agent, cfg, relayId, isTurnLive: () => true }),
})

test('convergence: two engines on one store derive the identical task board + frontier', async () => {
  const store = new SqliteStore(':memory:')
  const engineA = new FoldEngine(store)
  const engineB = new FoldEngine(store)
  await engineA.register(taskDagFold)
  await engineB.register(taskDagFold)

  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await admit(store, taskOp('chan1', 'task.created', { id: 'B' }))
  await flush()

  const a = tasksFor(engineA.get<TaskDagFoldState>(taskDagFold.name), 'chan1')
  const b = tasksFor(engineB.get<TaskDagFoldState>(taskDagFold.name), 'chan1')
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort())
  expect(readyTasks(a).map(t => t.id)).toEqual(readyTasks(b).map(t => t.id)) // same frontier
  store.close()
})

test('convergence: projectTaskDag is order-independent (reordered NOTIFY delivery)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await admit(store, taskOp('chan1', 'task.created', { id: 'B' }))
  await flush()
  const recs = engine.get<TaskDagFoldState>(taskDagFold.name).get(taskArtifact('chan1')) ?? []
  const forward = projectTaskDag(recs)
  const reversed = projectTaskDag([...recs].reverse())
  expect([...forward.keys()].sort()).toEqual([...reversed.keys()].sort())
  store.close()
})

test('exactly-one reply across two relays — race policy', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sA = new Synchronizer(store, engine)
  const sB = new Synchronizer(store, engine)
  sA.register(replyClaim({ resolveCoord: coordResolver('bot002', 'relayA') }))
  sB.register(replyClaim({ resolveCoord: coordResolver('bot101', 'relayB') }))
  sA.start()
  sB.start()
  // Each relay's host admits its own copy for the same platform message id.
  await admit(store, channelMessage('chan1', 'msgM', 'bot002'))
  await admit(store, channelMessage('chan1', 'msgM', 'bot101'))
  await flush()
  const prompted = (await store.listByVerb('turn.prompted')).length
  expect(prompted).toBe(1)
  store.close()
})

test('exactly-one task owner across two relays — pull and push policies', async () => {
  for (const cfg of [{} as ChannelConfig, { allocation: 'push-assign' } as ChannelConfig]) {
    const store = new SqliteStore(':memory:')
    const engine = new FoldEngine(store)
    await engine.register(taskDagFold)
    const sA = new Synchronizer(store, engine)
    const sB = new Synchronizer(store, engine)
    sA.register(taskScheduler(schedOpts('bot002', 'relayA', cfg)))
    sB.register(taskScheduler(schedOpts('bot101', 'relayB', cfg)))
    sA.start()
    sB.start()
    // push-assign targets bot002; pull lets either claim — both must yield ONE owner.
    await admit(store, taskOp('chan1', 'task.created', { id: 'A', assignee: cfg.allocation ? 'bot002' : undefined }))
    await flush()
    const owners = (await store.listByVerb('task.claimed')).map(r => (r.patch.kind === 'task' ? r.patch.data.owner : '?'))
    expect(owners.length).toBe(1)
    if (cfg.allocation === 'push-assign') expect(owners[0]).toBe('bot002')
    store.close()
  }
})

test('claim is row-lock atomic, not NOTIFY-dependent: a live claim refuses a different holder', async () => {
  const store = new SqliteStore(':memory:')
  const first = await store.acquireClaim('coord:reply/chan1/msgM', 'bot002', 60_000)
  const second = await store.acquireClaim('coord:reply/chan1/msgM', 'bot101', 60_000)
  expect(first.acquired).toBe(true)
  expect(second.acquired).toBe(false)
  expect(second.currentHolder).toBe('bot002') // contention resolved by the store, no event needed
  store.close()
})
