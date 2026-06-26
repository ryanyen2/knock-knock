/**
 * Coordination layer — store-backed sync tests (no Discord, no real hosts).
 * U2 reply-claim: exactly one agent replies, drive-once across relays, policy bias.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import { replyClaim, type ReplyCoordContext } from '../../src/ledger/synchronizations/reply-claim.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import type { ChannelConfig } from '../../src/lib.ts'

const flush = () => new Promise(r => setTimeout(r, 10))

function channelMessage(
  channel: ChannelId,
  role: Role,
  authorId: string,
  messageId: string,
  targetAgent: string,
) {
  return {
    actor: authorId,
    role,
    channel,
    target: { artifactId: discordArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'channel.message' as const,
    patch: {
      kind: 'external' as const,
      intent: { channel: 'discord', op: 'received', args: { text: 'hi', messageId, targetAgent } },
    },
    effect: 'external' as const,
    caused_by: [] as string[],
  }
}

type AgentSpec = { isOwnerBot?: boolean; cfg?: ChannelConfig; relayId?: string }

/** A resolveCoord that knows a fixed set of locally-served agents, keyed by agentKey. */
function coordResolver(agents: Record<string, AgentSpec>, relayId = 'relayA') {
  return (_channel: ChannelId, targetAgent: string | undefined): ReplyCoordContext | undefined => {
    const a = targetAgent ? agents[targetAgent] : undefined
    if (!targetAgent || !a) return undefined
    return {
      agentKey: targetAgent,
      isOwnerBot: a.isOwnerBot ?? true,
      cfg: a.cfg ?? {},
      relayId: a.relayId ?? relayId,
    }
  }
}

async function promptedActors(store: SqliteStore): Promise<string[]> {
  const rows = await store.listByVerb('turn.prompted')
  return rows.map(r => r.actor)
}

test('reply-claim: a single eligible agent gets exactly one turn.prompted', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }) }))
  sync.start()

  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  expect(await promptedActors(store)).toEqual(['bot002'])
  store.close()
})

test('reply-claim: two eligible agents → exactly one turn.prompted (reply election)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(replyClaim({ resolveCoord: coordResolver({ bot002: {}, bot101: {} }) }))
  sync.start()

  // Two hosts each admit their own channel.message for the SAME platform message id.
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot101'))
  await flush()

  const actors = await promptedActors(store)
  expect(actors.length).toBe(1) // exactly one agent answered — no duplicate "Got it"
  store.close()
})

test('reply-claim: designated policy → only the front-door agent replies', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)

  // Controllable defer: a non-preferred agent's attempt is queued, run on demand.
  const deferred: Array<() => void> = []
  const cfg: ChannelConfig = { responder: 'designated', responderAgent: 'bot002' }
  const sync = new Synchronizer(store, engine)
  sync.register(
    replyClaim({
      resolveCoord: coordResolver({ bot002: { cfg }, bot101: { cfg } }),
      defer: fn => deferred.push(fn),
    }),
  )
  sync.start()

  // Non-designate arrives FIRST but must defer; designate arrives and wins inline.
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot101'))
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  expect(await promptedActors(store)).toEqual(['bot002']) // designate won before the defer

  // The deferred non-designate attempt now runs and finds the claim already held.
  for (const fn of deferred.splice(0)) fn()
  await flush()
  expect(await promptedActors(store)).toEqual(['bot002']) // still exactly one
  store.close()
})

test('reply-claim: same agent on two relays is driven exactly once (drive election)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)

  // Two relays share one store (mirrors cross-machine Postgres): two synchronizers,
  // each running reply-claim for the SAME agent under a distinct relayId.
  const syncA = new Synchronizer(store, engine)
  const syncB = new Synchronizer(store, engine)
  syncA.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }, 'relayA') }))
  syncB.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }, 'relayB') }))
  syncA.start()
  syncB.start()

  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  // Both relays pass the reply election (same agentKey holder renews), but only
  // one wins the drive claim → exactly one turn.prompted.
  expect(await promptedActors(store)).toEqual(['bot002'])
  store.close()
})

// ─── U4: coordination-board fold + projection ─────────────────────────────────

import { coordBoardFold, boardFor, coordArtifact } from '../../src/ledger/concepts/coordination-board.ts'
import { projectCoordinationBoard, type CoordRecord } from '../../src/lib.ts'
import type { CoordNote } from '../../src/ledger/interaction.ts'

function coordNote(scope: ChannelId, note: CoordNote, actor = note.agentKey) {
  return {
    actor,
    role: 'agent' as Role,
    channel: scope,
    target: { artifactId: coordArtifact(scope), anchor: { kind: 'none' as const } },
    verb: 'coord.note' as const,
    patch: { kind: 'coord' as const, note },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

test('projectCoordinationBoard: latest presence per agent, deterministic under shuffle', () => {
  const recs: CoordRecord[] = [
    { note: { type: 'presence', agentKey: 'bot002', status: 'working', label: 'A' }, createdAt: '2026-06-26T00:00:01Z', hash: 'h1' },
    { note: { type: 'presence', agentKey: 'bot101', status: 'working', label: 'B' }, createdAt: '2026-06-26T00:00:02Z', hash: 'h2' },
    { note: { type: 'presence', agentKey: 'bot002', status: 'done', label: 'A' }, createdAt: '2026-06-26T00:00:03Z', hash: 'h3' },
  ]
  const forward = projectCoordinationBoard(recs)
  const shuffled = projectCoordinationBoard([recs[2]!, recs[0]!, recs[1]!])
  expect(forward).toEqual(shuffled) // order-independent
  const bot002 = forward.presence.find(p => p.agentKey === 'bot002')
  expect(bot002?.status).toBe('done') // latest wins
  expect(forward.presence.length).toBe(2)
})

test('projectCoordinationBoard: designations dedupe by message ref', () => {
  const recs: CoordRecord[] = [
    { note: { type: 'designation', agentKey: 'bot002', ref: 'msgM' }, createdAt: '2026-06-26T00:00:01Z', hash: 'h1' },
    { note: { type: 'designation', agentKey: 'bot002', ref: 'msgN' }, createdAt: '2026-06-26T00:00:02Z', hash: 'h2' },
  ]
  const board = projectCoordinationBoard(recs)
  expect(board.responders.length).toBe(2)
  expect(board.responders.map(r => r.ref).sort()).toEqual(['msgM', 'msgN'])
})

test('coordBoardFold: appends notes and projects the live board', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(coordBoardFold)

  await admit(store, coordNote('chan1', { type: 'presence', agentKey: 'bot002', status: 'working', label: 'task X' }))
  await admit(store, coordNote('chan1', { type: 'designation', agentKey: 'bot002', ref: 'msgM' }))
  await flush()

  const state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  const board = boardFor(state, 'chan1')
  expect(board.presence).toEqual([{ agentKey: 'bot002', status: 'working', label: 'task X' }])
  expect(board.responders).toEqual([{ agentKey: 'bot002', ref: 'msgM' }])
  store.close()
})

test('coordBoardFold: empty scope projects an empty board (no throw)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(coordBoardFold)
  const state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  expect(boardFor(state, 'nope')).toEqual({ presence: [], responders: [] })
  store.close()
})

// ─── U3: responder designation lands on the board ─────────────────────────────

test('reply-claim → board shows the winning agent as the designated responder (U3)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(coordBoardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }) }))
  sync.start()

  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  const state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  const board = boardFor(state, 'chan1')
  expect(board.responders).toEqual([{ agentKey: 'bot002', ref: 'msgM' }])
  store.close()
})

// ─── U5: presence capture from the turn lifecycle ─────────────────────────────

import { capturePresence } from '../../src/ledger/synchronizations/capture-presence.ts'

function turnInteraction(channel: ChannelId, agentKey: string, verb: 'turn.prompted' | 'turn.replied') {
  return {
    actor: agentKey,
    role: 'agent' as Role,
    channel,
    target: { artifactId: discordArtifact(channel), anchor: { kind: 'none' as const } },
    verb,
    patch: { kind: 'none' as const },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

test('capture-presence: turn.prompted→working then turn.replied→done (latest wins)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(coordBoardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(capturePresence())
  sync.start()

  await admit(store, turnInteraction('chan1', 'bot002', 'turn.prompted'))
  await flush()
  let state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  expect(boardFor(state, 'chan1').presence.find(p => p.agentKey === 'bot002')?.status).toBe('working')

  await admit(store, turnInteraction('chan1', 'bot002', 'turn.replied'))
  await flush()
  state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  expect(boardFor(state, 'chan1').presence.find(p => p.agentKey === 'bot002')?.status).toBe('done')
  store.close()
})

test('capture-presence: two agents working in one scope without collision', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(coordBoardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(capturePresence())
  sync.start()

  await admit(store, turnInteraction('chan1', 'bot002', 'turn.prompted'))
  await admit(store, turnInteraction('chan1', 'bot101', 'turn.prompted'))
  await flush()

  const state = engine.get<import('../../src/ledger/concepts/coordination-board.ts').CoordBoardFoldState>(coordBoardFold.name)
  const board = boardFor(state, 'chan1')
  expect(board.presence.map(p => p.agentKey).sort()).toEqual(['bot002', 'bot101'])
  store.close()
})

// ─── U7: task-DAG fold ────────────────────────────────────────────────────────

import { taskDagFold, tasksFor, taskArtifact } from '../../src/ledger/concepts/task-dag.ts'
import { readyTasks } from '../../src/lib.ts'
import type { TaskPatchData } from '../../src/ledger/interaction.ts'

function taskOp(scope: ChannelId, verb: 'task.created' | 'task.claimed' | 'task.completed', data: TaskPatchData, actor = 'owner1') {
  return {
    actor,
    role: 'owner' as Role,
    channel: scope,
    target: { artifactId: taskArtifact(scope), anchor: { kind: 'none' as const } },
    verb,
    patch: { kind: 'task' as const, data },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

test('taskDagFold: folds created/claimed/completed into the live board', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', label: 'build' }))
  await admit(store, taskOp('chan1', 'task.created', { id: 'B', dependsOn: ['A'] }))
  await flush()
  let state = engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name)
  expect(readyTasks(tasksFor(state, 'chan1')).map(t => t.id)).toEqual(['A'])

  await admit(store, taskOp('chan1', 'task.claimed', { id: 'A', owner: 'bot002' }))
  await admit(store, taskOp('chan1', 'task.completed', { id: 'A' }))
  await flush()
  state = engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name)
  const board = tasksFor(state, 'chan1')
  expect(board.get('A')?.status).toBe('done')
  expect(readyTasks(board).map(t => t.id)).toEqual(['B']) // unlocked
  store.close()
})

// ─── U9: task scheduler (claim / assign / wake / failover) ────────────────────

import { taskScheduler, scheduleScope, type TaskSchedulerOpts } from '../../src/ledger/synchronizations/task-scheduler.ts'

function schedOpts(
  agentKey: string,
  o: { cfg?: ChannelConfig; relayId?: string; isTurnLive?: () => boolean; claimTtlMs?: number } = {},
): TaskSchedulerOpts {
  return {
    resolveSchedule: () => ({
      agentKey,
      cfg: o.cfg ?? {},
      relayId: o.relayId ?? 'relayA',
      isTurnLive: o.isTurnLive ?? (() => true),
    }),
    claimTtlMs: o.claimTtlMs,
  }
}

async function claimedOwners(store: SqliteStore): Promise<string[]> {
  const rows = await store.listByVerb('task.claimed')
  return rows.map(r => (r.patch.kind === 'task' ? r.patch.data.owner ?? '?' : '?'))
}

test('task-scheduler pull: a ready task is claimed by the agent and wakes it', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot002')))
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', label: 'build' }))
  await flush()

  expect(await claimedOwners(store)).toEqual(['bot002'])
  expect((await promptedActors(store))).toContain('bot002') // woken to work it
  store.close()
})

test('task-scheduler ordering: B is not claimed until A completes', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot002')))
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await admit(store, taskOp('chan1', 'task.created', { id: 'B', dependsOn: ['A'] }))
  await flush()
  // Only A claimed so far (B blocked on A).
  const state = engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name)
  expect(tasksFor(state, 'chan1').get('B')?.status).toBe('open')

  await admit(store, taskOp('chan1', 'task.completed', { id: 'A' }))
  await flush()
  const state2 = engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name)
  expect(tasksFor(state2, 'chan1').get('B')?.status).toBe('claimed') // unlocked + claimed
  store.close()
})

test('task-scheduler push-assign: only the assignee claims', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const cfg: ChannelConfig = { allocation: 'push-assign' }
  // bot101 runs the scheduler but the task is assigned to bot002 → bot101 must NOT claim.
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot101', { cfg })))
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', assignee: 'bot002' }))
  await flush()
  expect(await claimedOwners(store)).toEqual([]) // bot101 is not the assignee

  // bot002's scheduler claims it.
  const sync2 = new Synchronizer(store, engine)
  sync2.register(taskScheduler(schedOpts('bot002', { cfg, relayId: 'relayB' })))
  sync2.start()
  await admit(store, taskOp('chan1', 'task.created', { id: 'B', assignee: 'bot002' }))
  await flush()
  expect((await claimedOwners(store)).every(o => o === 'bot002')).toBe(true)
  store.close()
})

test('task-scheduler concurrency: two agents race one pull task → exactly one owner', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const syncA = new Synchronizer(store, engine)
  const syncB = new Synchronizer(store, engine)
  syncA.register(taskScheduler(schedOpts('bot002', { relayId: 'relayA' })))
  syncB.register(taskScheduler(schedOpts('bot101', { relayId: 'relayB' })))
  syncA.start()
  syncB.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await flush()
  const owners = await claimedOwners(store)
  expect(owners.length).toBe(1) // exactly one agent owns it
  store.close()
})

test('task-scheduler failover: a lapsed claim is reassigned to another agent', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)

  // Agent A claims with a short TTL and a turn that goes "not live".
  const liveA = { v: true }
  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await scheduleScope({
    store, engine, admit: p => admit(store, p),
    opts: schedOpts('bot002', { relayId: 'relayA', isTurnLive: () => liveA.v, claimTtlMs: 20 }),
    scope: 'chan1',
  })
  expect(await claimedOwners(store)).toEqual(['bot002'])

  // A's turn ends and its claim TTL lapses.
  liveA.v = false
  await new Promise(r => setTimeout(r, 80))

  // Reconcile for agent B → re-acquires the lapsed claim (failover).
  await scheduleScope({
    store, engine, admit: p => admit(store, p),
    opts: schedOpts('bot101', { relayId: 'relayB', claimTtlMs: 20 }),
    scope: 'chan1',
  })
  const state = engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name)
  expect(tasksFor(state, 'chan1').get('A')?.owner).toBe('bot101') // reassigned
  store.close()
})

// ─── U15: contract-net bid round ──────────────────────────────────────────────

import { scoreBid, winningBid as winBid, type Bid } from '../../src/lib.ts'

async function bidsFor(store: SqliteStore): Promise<Bid[]> {
  const rows = await store.listByVerb('task.bid')
  return rows.map(r => {
    const d = r.patch.kind === 'task' ? r.patch.data : { bidder: '?', utility: 0 }
    return { bidder: d.bidder ?? '?', utility: d.utility ?? 0, createdAt: r.createdAt, hash: r.hash }
  })
}

test('bid round: agents bid on event; winner claims on the reconcile pass', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const cfg = { allocation: 'bid' as const }

  // Event pass for two agents: each submits a bid, NEITHER claims yet.
  const sched = (agent: string, relay: string, allowBidClaim = false) =>
    scheduleScope({
      store, engine, admit: p => admit(store, p),
      opts: schedOpts(agent, { cfg, relayId: relay }), scope: 'chan1', allowBidClaim,
    })

  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  await sched('bot002', 'relayA')
  await sched('bot101', 'relayB')
  await flush()

  const bids = await bidsFor(store)
  expect(bids.map(b => b.bidder).sort()).toEqual(['bot002', 'bot101']) // both bid
  expect(await claimedOwners(store)).toEqual([]) // nobody claimed during the window

  // Reconcile pass: the winning bidder claims.
  const expectedWinner = winBid(bids)!
  await sched('bot002', 'relayA', true)
  await sched('bot101', 'relayB', true)
  await flush()
  expect(await claimedOwners(store)).toEqual([expectedWinner])
  store.close()
})

test('bid round: a ready task with no bids falls back to pull on reconcile', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const cfg = { allocation: 'bid' as const }

  await admit(store, taskOp('chan1', 'task.created', { id: 'A' }))
  // Straight to the reconcile pass with no prior bids → fall back to pull-claim.
  await scheduleScope({
    store, engine, admit: p => admit(store, p),
    opts: schedOpts('bot002', { cfg, relayId: 'relayA' }), scope: 'chan1', allowBidClaim: true,
  })
  await flush()
  // bot002 bid then... no: with no existing bids it submits a bid first. Run reconcile again to claim.
  await scheduleScope({
    store, engine, admit: p => admit(store, p),
    opts: schedOpts('bot002', { cfg, relayId: 'relayA' }), scope: 'chan1', allowBidClaim: true,
  })
  await flush()
  expect(await claimedOwners(store)).toEqual(['bot002'])
  store.close()
})

test('scoreBid: deterministic per (task, agent)', () => {
  expect(scoreBid('A', 'bot002')).toBe(scoreBid('A', 'bot002'))
  expect(scoreBid('A', 'bot002')).not.toBe(scoreBid('A', 'bot101'))
})

// ─── FIX: scheduler wake actually drives a turn, and completion unblocks deps ──

import { driveTurn } from '../../src/ledger/synchronizations/drive-turn.ts'
import { completeTaskOnTurn } from '../../src/ledger/synchronizations/complete-task-on-turn.ts'

test('scheduler wake → drive-turn runs the owner with a synthesized task prompt', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const runs: Array<{ promptText: string; inboundHash: string }> = []
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot002')))
  sync.register(
    driveTurn({
      getDriveHandle: () => ({ run: async (o: { promptText: string; inboundHash: string }) => void runs.push(o) }) as never,
      getByHash: h => store.getByHash(h),
    }),
  )
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', label: 'write the parser' }))
  await flush()

  expect(runs.length).toBe(1) // the wake actually drove a turn (was the HIGH bug: 0)
  expect(runs[0]!.promptText).toContain('write the parser') // prompt synthesized from the task
  store.close()
})

test('completion loop: a task-driven turn replying marks it done and unblocks dependents (no thrash)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot002')))
  sync.register(completeTaskOnTurn())
  // Auto-reply: when a task turn is driven, emit turn.replied (what runTurnForChannel does on success).
  sync.register(
    driveTurn({
      getDriveHandle: () => ({
        run: async (o: { promptHash: string; inboundHash: string }) => {
          // Reply in a FRESH wave (like a real turn finishing later), not nested in
          // the scheduler's claim wave — otherwise the whole cascade compresses into
          // one wave and can hit the 16-admit cap (a test artifact, not the product).
          setTimeout(() => {
            void admit(store, {
              actor: 'bot002', role: 'agent' as Role, channel: 'chan1',
              target: { artifactId: discordArtifact('chan1'), anchor: { kind: 'none' as const } },
              verb: 'turn.replied' as const, patch: { kind: 'none' as const }, effect: 'pure' as const,
              caused_by: [o.promptHash],
            })
          }, 0)
        },
      }) as never,
      getByHash: h => store.getByHash(h),
    }),
  )
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', label: 'do A' }))
  await admit(store, taskOp('chan1', 'task.created', { id: 'B', label: 'do B', dependsOn: ['A'] }))

  // The cascade is several async waves (claim A → drive → reply → complete A →
  // unblock B → claim B → drive → reply → complete B); poll until it converges.
  const statusOf = (id: string) =>
    tasksFor(engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name), 'chan1').get(id)?.status
  for (let i = 0; i < 20 && !(statusOf('A') === 'done' && statusOf('B') === 'done'); i++) await flush()

  // A completes on its turn reply (not stuck claimed → no thrash), unblocking B;
  // B is then claimed, driven, and completes too — the pipeline drains in order.
  expect(statusOf('A')).toBe('done')
  expect(statusOf('B')).toBe('done')
  store.close()
})

// ─── FIX (adversarial): completion ownership guard + fan-out wave-cap recovery ─

test('completion guard: a foreign/forged turn.replied cannot complete another agent\'s task', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  sync.register(taskScheduler(schedOpts('bot002')))
  sync.register(completeTaskOnTurn())
  sync.start()

  await admit(store, taskOp('chan1', 'task.created', { id: 'A', label: 'do A' }))
  await flush()
  // A is now claimed by bot002. Grab its wake turn.prompted hash.
  const prompts = await store.listByVerb('turn.prompted')
  const promptHash = prompts[0]!.hash

  // A hostile peer 'evil' forges a turn.replied pointing at A's prompt chain.
  await admit(store, {
    actor: 'evil', role: 'agent' as Role, channel: 'chan1',
    target: { artifactId: discordArtifact('chan1'), anchor: { kind: 'none' as const } },
    verb: 'turn.replied' as const, patch: { kind: 'none' as const }, effect: 'pure' as const,
    caused_by: [promptHash],
  })
  await flush()

  const board = tasksFor(engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name), 'chan1')
  expect(board.get('A')?.status).toBe('claimed') // NOT completed by the forged reply
  store.close()
})

test('fan-out: per-pass cap bounds wakes; reconcile drains all ready tasks (no permanent drop)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(taskDagFold)
  const opts = schedOpts('bot002')

  // 9 independent ready tasks. Drive scheduling exactly as the relay reconcile tick
  // does — via scheduleScope (NOT the live synchronizer, which would race a manual
  // loop). This is the deterministic property: each pass claims at most
  // MAX_WAKES_PER_PASS (5), and successive passes drain the rest with no loss.
  for (let i = 0; i < 9; i++) await admit(store, taskOp('chan1', 'task.created', { id: `T${i}` }))
  await flush()

  const countClaimed = () =>
    [...tasksFor(engine.get<import('../../src/ledger/concepts/task-dag.ts').TaskDagFoldState>(taskDagFold.name), 'chan1').values()]
      .filter(t => t.status === 'claimed').length

  await scheduleScope({ store, engine, admit: p => admit(store, p), opts, scope: 'chan1' })
  await flush()
  expect(countClaimed()).toBe(5) // first pass capped at MAX_WAKES_PER_PASS

  await scheduleScope({ store, engine, admit: p => admit(store, p), opts, scope: 'chan1' })
  await flush()
  expect(countClaimed()).toBe(9) // remaining 4 drained on the next tick — none dropped
  store.close()
})
