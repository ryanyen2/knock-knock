/**
 * Mesh coordination — NO shared database. The honest cross-machine test: two relays
 * on SEPARATE stores (two laptops), bridged ONLY by the messaging transport (encode →
 * decode → append). Here `acquireClaim` is process-local and useless across stores, so
 * exactly-one turn-taking rests entirely on DETERMINISTIC ELECTION + the mesh-synced
 * designation stand-down — the no-Postgres path.
 *
 * Contrast tests/ledger/coordination-cross-machine.test.ts, which shares ONE store so
 * the row-lock claim does the work (the Postgres-equivalent path).
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import { replyClaim, type MeshElection } from '../../src/ledger/synchronizations/reply-claim.ts'
import { taskScheduler, scheduleScope, type TaskSchedulerOpts } from '../../src/ledger/synchronizations/task-scheduler.ts'
import { taskDagFold, tasksFor, taskArtifact, TASK_DAG_FOLD, type TaskDagFoldState } from '../../src/ledger/concepts/task-dag.ts'
import type { ChannelConfig } from '../../src/lib.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import {
  coordBoardFold,
  boardFor,
  COORD_BOARD_FOLD,
  type CoordBoardFoldState,
} from '../../src/ledger/concepts/coordination-board.ts'
import {
  agentDirectoryFold,
  directoryFor,
  AGENT_DIRECTORY_FOLD,
  dirArtifact,
  type AgentDirectoryFoldState,
} from '../../src/ledger/concepts/agent-directory.ts'
import {
  responderElection,
  encodeMeshEvent,
  decodeMeshEvent,
  MESH_VERB_ALLOWLIST,
} from '../../src/lib.ts'

const flush = (ms = 120) => new Promise(r => setTimeout(r, ms))
const ROOM: ChannelId = 'room1'

function channelMessage(messageId: string, targetAgent: string, text: string) {
  return {
    actor: 'human1',
    role: 'human' as Role,
    channel: ROOM,
    target: { artifactId: discordArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'channel.message' as const,
    patch: { kind: 'external' as const, intent: { channel: 'discord', op: 'received', args: { text, messageId, targetAgent } } },
    effect: 'external' as const,
    caused_by: [] as string[],
  }
}

function identity(botKey: string, userId: string) {
  return {
    actor: botKey,
    role: 'agent' as Role,
    channel: 'agent-directory' as ChannelId,
    target: { artifactId: dirArtifact(botKey), anchor: { kind: 'none' as const } },
    verb: 'agent.identity' as const,
    patch: { kind: 'identity' as const, data: { agentKey: botKey, platform: 'discord', userId, rooms: [ROOM] } },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

type Machine = Awaited<ReturnType<typeof makeMachine>>

/** One laptop: its own store + engine + a single bot whose reply-claim uses mesh election. */
async function makeMachine(botKey: string, userId: string, relayId: string) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(agentDirectoryFold)
  await engine.register(coordBoardFold)
  const sync = new Synchronizer(store, engine)
  const election: MeshElection = {
    rankFor: (channel, messageId, text, self) => {
      const dir = directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
      const order = responderElection(dir, channel, 'discord', text, messageId)
      const rank = order.indexOf(self)
      return rank < 0 ? undefined : rank
    },
    alreadyDesignated: (channel, messageId, self) =>
      boardFor(engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), channel).responders.some(
        r => r.ref === messageId && r.agentKey !== self,
      ),
    stepMs: 50, // comfortably larger than the in-process bridge latency
  }
  sync.register(
    replyClaim({
      resolveCoord: (_c, target) =>
        !target || target === botKey ? { agentKey: botKey, isOwnerBot: true, cfg: {}, relayId } : undefined,
      election,
      defer: (fn, ms) => void setTimeout(fn, ms),
    }),
  )
  sync.start()
  return { store, engine, sync, botKey, userId }
}

/** The messaging channel: carry each locally-authored coordination event from src to
 *  dst, exactly as MeshSync does (encode → decode-with-provenance → append). */
function bridge(src: Machine, dst: Machine): void {
  src.store.subscribe(i => {
    if (i.actor !== src.botKey) return // publish only my own events (no echo)
    if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
    if (!MESH_VERB_ALLOWLIST.includes(i.verb)) return
    const line = encodeMeshEvent(i)
    const decoded = decodeMeshEvent(line, src.userId, directoryFor(dst.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)))
    if (decoded) void dst.store.append(decoded)
  })
}

async function totalPrompted(machines: Machine[]): Promise<number> {
  let n = 0
  for (const m of machines) n += (await m.store.listByVerb('turn.prompted')).length
  return n
}

test('two laptops, separate stores, no shared lock: deterministic election yields EXACTLY ONE reply', async () => {
  const a = await makeMachine('cc', 'U_cc', 'relayA')
  const b = await makeMachine('d-bot', 'U_db', 'relayB')
  bridge(a, b)
  bridge(b, a)

  // Each bot publishes its identity; the mesh carries it so both directories converge.
  await admit(a.store, identity('cc', 'U_cc'))
  await admit(b.store, identity('d-bot', 'U_db'))
  await flush()

  // The human addresses BOTH bots in one message. Each machine sees it natively (no
  // bridging of chat) and admits its own copy targeting its own bot.
  const text = 'hey <@U_cc> <@U_db> please collaborate'
  await admit(a.store, channelMessage('msgM', 'cc', text))
  await admit(b.store, channelMessage('msgM', 'd-bot', text))
  await flush(250) // let the loser's failover window elapse

  expect(await totalPrompted([a, b])).toBe(1) // exactly one — no double-reply, no silence
  a.store.close()
  b.store.close()
})

test('failover: if the elected winner never acts, the next rank steps in (no shared lock)', async () => {
  // Determine who election makes the winner, then run ONLY the loser's machine — the
  // winner is "offline". The loser must still reply once its rank delay elapses.
  const dir = [
    { agentKey: 'cc', platform: 'discord', userId: 'U_cc', rooms: [ROOM] },
    { agentKey: 'd-bot', platform: 'discord', userId: 'U_db', rooms: [ROOM] },
  ]
  const order = responderElection(dir, ROOM, 'discord', '<@U_cc> <@U_db> go', 'msgF')
  const loserKey = order[1]! // rank 1
  const loserUser = loserKey === 'cc' ? 'U_cc' : 'U_db'

  const loser = await makeMachine(loserKey, loserUser, 'relayLoser')
  // Seed BOTH identities so the loser's election sees the full eligible set (winner present
  // in the directory but its relay is down — nothing ever posts a designation).
  await admit(loser.store, identity(loserKey, loserUser))
  await admit(loser.store, identity(order[0]!, order[0] === 'cc' ? 'U_cc' : 'U_db'))
  await flush()

  await admit(loser.store, channelMessage('msgF', loserKey, '<@U_cc> <@U_db> go'))
  await flush(250) // past the rank-1 failover step

  expect((await loser.store.listByVerb('turn.prompted')).length).toBe(1) // promoted, no silence
  loser.store.close()
})

test('mesh ingest preserves createdAt + is idempotent → boards converge', async () => {
  const a = await makeMachine('cc', 'U_cc', 'relayA')
  const b = await makeMachine('d-bot', 'U_db', 'relayB')
  bridge(a, b)
  await admit(a.store, identity('cc', 'U_cc')) // so b can verify cc's provenance
  await flush()

  // cc posts a presence note on machine A; it bridges to B.
  const note = {
    actor: 'cc',
    role: 'agent' as Role,
    channel: ROOM,
    target: { artifactId: `coord:channel/${ROOM}`, anchor: { kind: 'none' as const } },
    verb: 'coord.note' as const,
    patch: { kind: 'coord' as const, note: { type: 'presence' as const, agentKey: 'cc', status: 'working' as const, label: 'scanning' } },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
  await admit(a.store, note)
  await flush()

  const recsA = a.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD).get(`coord:channel/${ROOM}`) ?? []
  const recsB = b.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD).get(`coord:channel/${ROOM}`) ?? []
  expect(recsB.length).toBe(1) // bridged once (idempotent — the bridge subscriber appended exactly one)
  expect(recsB[0]!.createdAt).toBe(recsA[0]!.createdAt) // createdAt survived → folds order identically
  expect(boardFor(b.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), ROOM).presence).toEqual(
    boardFor(a.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), ROOM).presence,
  )
  a.store.close()
  b.store.close()
})

// ─── Phase 2: task allocation across separate stores (no shared lock) ─────────

function taskCreated(botKey: string, id: string, extra: { assignee?: string } = {}) {
  return {
    actor: botKey, // agent-authored so it bridges with directory provenance
    role: 'agent' as Role,
    channel: ROOM,
    target: { artifactId: taskArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'task.created' as const,
    patch: { kind: 'task' as const, data: { id, ...extra } },
    effect: 'pure' as const,
    caused_by: [] as string[],
  }
}

type TaskMachine = Awaited<ReturnType<typeof makeTaskMachine>>

async function makeTaskMachine(botKey: string, userId: string, cfg: ChannelConfig, nowRef: { v: number }) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(agentDirectoryFold)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  const opts: TaskSchedulerOpts = {
    resolveSchedule: () => ({ agentKey: botKey, cfg, relayId: `relay-${botKey}`, isTurnLive: () => true }),
    now: () => nowRef.v,
    election: {
      eligibleClaimants: () =>
        directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
          .filter(id => id.rooms.includes(ROOM))
          .map(id => id.agentKey),
      windowMs: 1000,
    },
  }
  sync.register(taskScheduler(opts))
  sync.start()
  return { store, engine, sync, botKey, userId, opts }
}

function bridgeTask(src: TaskMachine, dst: TaskMachine): void {
  src.store.subscribe(i => {
    if (i.actor !== src.botKey) return
    if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
    if (!MESH_VERB_ALLOWLIST.includes(i.verb)) return
    const line = encodeMeshEvent(i)
    const decoded = decodeMeshEvent(line, src.userId, directoryFor(dst.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)))
    if (decoded) void dst.store.append(decoded)
  })
}

// Distinct claims across the mesh, deduped by content hash — a winner's task.claimed
// bridges to every store (correctly!), so the SAME claim appears in each. Counting
// distinct hashes gives the number of LOGICAL claims (the exactly-one we care about).
async function totalClaimed(ms: TaskMachine[]): Promise<{ owner: string }[]> {
  const byHash = new Map<string, { owner: string }>()
  for (const m of ms) {
    for (const r of await m.store.listByVerb('task.claimed')) {
      if (r.patch.kind === 'task' && r.patch.data.owner) byHash.set(r.hash, { owner: r.patch.data.owner })
    }
  }
  return [...byHash.values()]
}

test('pull-claim: two laptops, separate stores → EXACTLY ONE task owner (election ladder)', async () => {
  const nowRef = { v: Date.now() }
  const a = await makeTaskMachine('cc', 'U_cc', {}, nowRef)
  const b = await makeTaskMachine('d-bot', 'U_db', {}, nowRef)
  bridgeTask(a, b)
  bridgeTask(b, a)
  await admit(a.store, identity('cc', 'U_cc'))
  await admit(b.store, identity('d-bot', 'U_db'))
  await flush()

  // cc seeds the task (agent-authored → bridges to B with cc's provenance).
  await admit(a.store, taskCreated('cc', 'T1'))
  await flush(200)

  const owners = await totalClaimed([a, b])
  expect(owners.length).toBe(1) // no double-claim despite separate stores + local-only acquireClaim
  a.store.close()
  b.store.close()
})

test('pull-claim failover: the elected winner is offline → the next rank claims after a window', async () => {
  const nowRef = { v: Date.now() }
  // Run ONLY the loser's machine; seed both identities so its election sees the full set.
  const dir = [
    { agentKey: 'cc', platform: 'discord', userId: 'U_cc', rooms: [ROOM] },
    { agentKey: 'd-bot', platform: 'discord', userId: 'U_db', rooms: [ROOM] },
  ]
  // Which key is rank 1 for T1? (the loser/failover claimant)
  const { electOrder } = await import('../../src/lib.ts')
  const order = electOrder(['cc', 'd-bot'], 'T1')
  const loserKey = order[1]!
  const loserUser = loserKey === 'cc' ? 'U_cc' : 'U_db'

  const loser = await makeTaskMachine(loserKey, loserUser, {}, nowRef)
  await admit(loser.store, identity('cc', 'U_cc'))
  await admit(loser.store, identity('d-bot', 'U_db'))
  await flush()
  await admit(loser.store, taskCreated(loserKey, 'T1'))
  await flush(100)

  // Window 0 belongs to the (absent) winner — the loser must NOT claim yet.
  expect((await totalClaimed([loser])).length).toBe(0)

  // Advance past the window; the reconcile pass now promotes rank 1 (the loser).
  nowRef.v += 2000 // > windowMs (1000)
  await scheduleScope({ store: loser.store, engine: loser.engine, admit: p => admit(loser.store, p), opts: loser.opts, scope: ROOM, allowBidClaim: true })
  await flush(100)
  const owners = await totalClaimed([loser])
  expect(owners.length).toBe(1)
  expect(owners[0]!.owner).toBe(loserKey) // failover promoted the next rank — no stall
  loser.store.close()
})

test('bid policy converges to one deterministic winner across separate stores', async () => {
  const nowRef = { v: Date.now() }
  const a = await makeTaskMachine('cc', 'U_cc', { allocation: 'bid' }, nowRef)
  const b = await makeTaskMachine('d-bot', 'U_db', { allocation: 'bid' }, nowRef)
  bridgeTask(a, b)
  bridgeTask(b, a)
  await admit(a.store, identity('cc', 'U_cc'))
  await admit(b.store, identity('d-bot', 'U_db'))
  await flush()
  await admit(a.store, taskCreated('cc', 'T1'))
  await flush(200)

  // Both bid (bids bridge); the reconcile pass on each machine claims for the winner.
  await scheduleScope({ store: a.store, engine: a.engine, admit: p => admit(a.store, p), opts: a.opts, scope: ROOM, allowBidClaim: true })
  await scheduleScope({ store: b.store, engine: b.engine, admit: p => admit(b.store, p), opts: b.opts, scope: ROOM, allowBidClaim: true })
  await flush(200)

  const owners = await totalClaimed([a, b])
  expect(owners.length).toBe(1) // deterministic winningBid → exactly one owner
  a.store.close()
  b.store.close()
})

// ─── Phase 3: directed addressing across separate stores (no Postgres) ────────
// The broadcast tests above use mesh election to pick ONE winner. Directed messages
// are different: each NAMED bot answers its own part (per-agent claim key), and the
// mesh election is bypassed — no contention, no delay, no stand-down. Each bot's
// relay sees one channel.message (its own, stamped targetAgent=self), and
// resolveAddressing gates who engages via the markupAddressed check.

async function makeMachineDirected(botKey: string, userId: string, relayId: string, addressing: (channel: string, msgId: string, text: string) => string[]) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(agentDirectoryFold)
  await engine.register(coordBoardFold)
  const sync = new Synchronizer(store, engine)
  const election: MeshElection = {
    rankFor: (channel, messageId, text, self) => {
      const dir = directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
      const order = responderElection(dir, channel, 'discord', text, messageId)
      const rank = order.indexOf(self)
      return rank < 0 ? undefined : rank
    },
    alreadyDesignated: (channel, messageId, self) =>
      boardFor(engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), channel).responders.some(
        r => r.ref === messageId && r.agentKey !== self,
      ),
    stepMs: 50,
  }
  sync.register(
    replyClaim({
      resolveCoord: (_c, target) =>
        !target || target === botKey ? { agentKey: botKey, isOwnerBot: true, cfg: {}, relayId } : undefined,
      election,
      resolveAddressing: addressing,
      defer: (fn, ms) => void setTimeout(fn, ms),
    }),
  )
  sync.start()
  return { store, engine, sync, botKey, userId }
}

test('directed (mesh): @both bots across separate stores → each answers their own part', async () => {
  // Both bots are mentioned; each relay's resolveAddressing returns ['cc', 'd-bot'].
  // Per-agent claim keys mean no contention — both engage without racing or silencing.
  // Distinct from the broadcast test at line 126: here election is BYPASSED (directed=true).
  const addressing = () => ['cc', 'd-bot']
  const a = await makeMachineDirected('cc', 'U_cc', 'relayA', addressing)
  const b = await makeMachineDirected('d-bot', 'U_db', 'relayB', addressing)
  bridge(a, b)
  bridge(b, a)
  await admit(a.store, identity('cc', 'U_cc'))
  await admit(b.store, identity('d-bot', 'U_db'))
  await flush()
  const text = 'hey <@U_cc> <@U_db> split this'
  await admit(a.store, channelMessage('msgD', 'cc', text))
  await admit(b.store, channelMessage('msgD', 'd-bot', text))
  await flush(100)
  // Both named → per-agent claims on each store → BOTH answer (not one winner).
  expect(await totalPrompted([a, b])).toBe(2)
  a.store.close()
  b.store.close()
})

test('directed (mesh): @one bot only → the other stays silent with separate stores', async () => {
  // Only cc is named. d-bot's relay sees markupAddressed=['cc']; since 'd-bot' is not
  // in the list, replyClaim returns without acquiring a claim. No fallback to election.
  const ccOnly = () => ['cc']
  const a = await makeMachineDirected('cc', 'U_cc', 'relayA', ccOnly)
  const b = await makeMachineDirected('d-bot', 'U_db', 'relayB', ccOnly)
  bridge(a, b)
  bridge(b, a)
  await admit(a.store, identity('cc', 'U_cc'))
  await admit(b.store, identity('d-bot', 'U_db'))
  await flush()
  const text = 'hey <@U_cc> only you handle this'
  await admit(a.store, channelMessage('msgE', 'cc', text))
  await admit(b.store, channelMessage('msgE', 'd-bot', text)) // d-bot relay sees this but stands down
  await flush(100)
  const prompted = await totalPrompted([a, b])
  expect(prompted).toBe(1) // only cc — d-bot silenced by resolveAddressing guard
  a.store.close()
  b.store.close()
})
