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
