/**
 * Mesh stress simulation — three "laptops", three separate SQLite stores, joined ONLY
 * by a shared messaging bus (encode → decode → append), no shared database. Models the
 * real topology: one person's bot + two collaborators' bots in one channel. Drives many
 * messages (directed / broadcast) and task delegations, including REORDERED bus delivery,
 * and asserts the no-Postgres guarantees hold:
 *   - a message naming one bot → exactly that bot answers (everywhere)
 *   - a message naming several → each named bot answers its own part
 *   - a broadcast → exactly one bot answers across the whole mesh
 *   - a delegated task → exactly one owner across the whole mesh
 *   - reordered delivery converges to the same result
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import { replyClaim } from '../../src/ledger/synchronizations/reply-claim.ts'
import { taskScheduler, scheduleScope, type TaskSchedulerOpts } from '../../src/ledger/synchronizations/task-scheduler.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import { coordBoardFold, boardFor, COORD_BOARD_FOLD, type CoordBoardFoldState } from '../../src/ledger/concepts/coordination-board.ts'
import { taskDagFold, taskArtifact, type TaskDagFoldState } from '../../src/ledger/concepts/task-dag.ts'
import {
  agentDirectoryFold,
  directoryFor,
  AGENT_DIRECTORY_FOLD,
  dirArtifact,
  type AgentDirectoryFoldState,
} from '../../src/ledger/concepts/agent-directory.ts'
import {
  responderElection,
  addressedAgentKeys,
  meshTaskClaimant,
  encodeMeshEvent,
  decodeMeshEvent,
  MESH_VERB_ALLOWLIST,
} from '../../src/lib.ts'

const ROOM: ChannelId = 'room1'
const flush = (ms = 250) => new Promise(r => setTimeout(r, ms))

type Bot = { key: string; userId: string }
type Machine = {
  store: SqliteStore
  engine: FoldEngine
  sync: Synchronizer
  bot: Bot
  schedOpts: TaskSchedulerOpts
}

// A shared messaging bus: every machine's locally-authored coordination event is encoded
// and delivered to every OTHER machine. `reorder` buffers + shuffles delivery to prove
// convergence is order-independent.
class Bus {
  private machines: Machine[] = []
  private queue: { line: string; from: string }[] = []
  constructor(private readonly reorder = false) {}
  attach(m: Machine): void {
    this.machines.push(m)
    m.store.subscribe(i => {
      if (i.actor !== m.bot.key) return
      if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
      if (!MESH_VERB_ALLOWLIST.includes(i.verb)) return
      const line = encodeMeshEvent(i)
      if (this.reorder) this.queue.push({ line, from: m.bot.userId })
      else this.deliver(line, m.bot.userId, m.bot.key)
    })
  }
  private deliver(line: string, fromUser: string, fromKey: string): void {
    for (const m of this.machines) {
      if (m.bot.key === fromKey) continue // don't echo to the author
      const decoded = decodeMeshEvent(line, fromUser, directoryFor(m.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)))
      if (decoded) void m.store.append(decoded)
    }
  }
  /** Flush a reordered queue in reverse (worst-case delivery order). */
  async drainReversed(): Promise<void> {
    const q = this.queue.splice(0).reverse()
    for (const { line, from } of q) {
      const fromKey = this.machines.find(m => m.bot.userId === from)!.bot.key
      this.deliver(line, from, fromKey)
    }
    await flush()
  }
}

async function makeMachine(bot: Bot, nowRef: { v: number }): Promise<Machine> {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(agentDirectoryFold)
  await engine.register(coordBoardFold)
  await engine.register(taskDagFold)
  const sync = new Synchronizer(store, engine)
  const dir = () => directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
  sync.register(
    replyClaim({
      resolveCoord: (_c, target) =>
        !target || target === bot.key ? { agentKey: bot.key, isOwnerBot: true, cfg: {}, relayId: `r-${bot.key}` } : undefined,
      resolveAddressing: (_c, _m, text) => addressedAgentKeys(dir(), ROOM, 'discord', text),
      election: {
        rankFor: (_c, messageId, text, self) => {
          const order = responderElection(dir(), ROOM, 'discord', text, messageId)
          const rank = order.indexOf(self)
          return rank < 0 ? undefined : rank
        },
        alreadyDesignated: (channel, messageId, self) =>
          boardFor(engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), channel).responders.some(
            r => r.ref === messageId && r.agentKey !== self,
          ),
        stepMs: 40,
      },
      defer: (fn, ms) => void setTimeout(fn, ms),
    }),
  )
  const schedOpts: TaskSchedulerOpts = {
    resolveSchedule: () => ({ agentKey: bot.key, cfg: {}, relayId: `r-${bot.key}`, isTurnLive: () => true }),
    now: () => nowRef.v,
    election: { eligibleClaimants: () => dir().filter(id => id.rooms.includes(ROOM)).map(id => id.agentKey), windowMs: 1000 },
  }
  sync.register(taskScheduler(schedOpts))
  return { store, engine, sync, bot, schedOpts }
}

function identity(bot: Bot) {
  return {
    actor: bot.key, role: 'agent' as Role, channel: 'agent-directory' as ChannelId,
    target: { artifactId: dirArtifact(bot.key), anchor: { kind: 'none' as const } },
    verb: 'agent.identity' as const,
    patch: { kind: 'identity' as const, data: { agentKey: bot.key, platform: 'discord', userId: bot.userId, rooms: [ROOM] } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

// Deliver a human message to EVERY machine (each bot sees it natively). `addressed` is the
// set of bot keys named; the text carries each named bot's <@userId> markup, and each
// machine stamps addressedMe for its own bot.
async function deliverHuman(machines: Machine[], messageId: string, addressed: string[]): Promise<void> {
  const named = machines.filter(m => addressed.includes(m.bot.key))
  const text = named.length ? named.map(m => `<@${m.bot.userId}>`).join(' ') + ' please help' : 'status?'
  for (const m of machines) {
    await admit(m.store, {
      actor: 'human1', role: 'human' as Role, channel: ROOM,
      target: { artifactId: discordArtifact(ROOM), anchor: { kind: 'none' as const } },
      verb: 'channel.message' as const,
      patch: {
        kind: 'external' as const,
        intent: { channel: 'discord', op: 'received', args: { text, messageId, targetAgent: m.bot.key, addressedMe: addressed.includes(m.bot.key), isReply: false } },
      },
      effect: 'external' as const, caused_by: [] as string[],
    })
  }
}

async function prompts(machines: Machine[], messageId?: string): Promise<{ actor: string }[]> {
  const out: { actor: string }[] = []
  for (const m of machines) {
    for (const p of await m.store.listByVerb('turn.prompted')) {
      // turn.prompted is NOT bridged (local), so each is a distinct logical wake.
      out.push({ actor: p.actor })
    }
  }
  return out
}

async function distinctClaims(machines: Machine[]): Promise<Set<string>> {
  const byHash = new Map<string, string>()
  for (const m of machines) {
    for (const r of await m.store.listByVerb('task.claimed')) {
      if (r.patch.kind === 'task' && r.patch.data.owner) byHash.set(r.hash, `${r.patch.data.id}:${r.patch.data.owner}`)
    }
  }
  return new Set(byHash.values())
}

const BOTS: Bot[] = [
  { key: 'cc', userId: 'U_cc' }, // person's bot (machine A)
  { key: 'd-bot', userId: 'U_db' }, // collaborator A's bot (machine B)
  { key: 'eve', userId: 'U_ev' }, // collaborator B's bot (machine C)
]

async function setupMesh(reorder = false) {
  const nowRef = { v: Date.now() }
  const machines = await Promise.all(BOTS.map(b => makeMachine(b, nowRef)))
  const bus = new Bus(reorder)
  for (const m of machines) {
    m.sync.start()
    bus.attach(m)
  }
  // Everyone publishes identity; the bus converges all three directories.
  for (const m of machines) await admit(m.store, identity(m.bot))
  if (reorder) await bus.drainReversed()
  await flush()
  return { machines, bus, nowRef }
}

test('stress: a message naming ONE bot wakes exactly that bot, across three laptops', async () => {
  const { machines } = await setupMesh()
  await deliverHuman(machines, 'm1', ['eve'])
  await flush()
  const woke = await prompts(machines)
  expect(woke.length).toBe(1)
  expect(woke[0]!.actor).toBe('eve')
  for (const m of machines) m.store.close()
})

test('stress: a message naming TWO bots wakes exactly those two (each its own part)', async () => {
  const { machines } = await setupMesh()
  await deliverHuman(machines, 'm2', ['cc', 'd-bot'])
  await flush()
  const woke = (await prompts(machines)).map(p => p.actor).sort()
  expect(woke).toEqual(['cc', 'd-bot']) // eve stays out
  for (const m of machines) m.store.close()
})

test('stress: a broadcast (no bot named) wakes EXACTLY ONE bot across the mesh', async () => {
  const { machines } = await setupMesh()
  await deliverHuman(machines, 'm3', []) // "status?"
  await flush(300)
  expect((await prompts(machines)).length).toBe(1) // one elected responder, no chorus, no silence
  for (const m of machines) m.store.close()
})

test('stress: many interleaved messages — each directed bot answers, each broadcast once', async () => {
  const { machines } = await setupMesh()
  const batch: { id: string; to: string[] }[] = [
    { id: 'a', to: ['cc'] },
    { id: 'b', to: ['d-bot', 'eve'] },
    { id: 'c', to: [] }, // broadcast
    { id: 'd', to: ['eve'] },
    { id: 'e', to: ['cc', 'd-bot', 'eve'] },
  ]
  for (const msg of batch) await deliverHuman(machines, msg.id, msg.to)
  await flush(400)
  // Expected wakes: a→1, b→2, c→1, d→1, e→3  = 8 total.
  const woke = await prompts(machines)
  expect(woke.length).toBe(8)
  // cc woke for a + e (2); d-bot for b + e (2); eve for b + d + e (3); plus one broadcast (c).
  const byActor = woke.reduce<Record<string, number>>((acc, p) => ((acc[p.actor] = (acc[p.actor] ?? 0) + 1), acc), {})
  expect(byActor['eve']).toBe(3)
  for (const m of machines) m.store.close()
})

test('stress: a delegated task gets EXACTLY ONE owner across the mesh', async () => {
  const { machines, nowRef } = await setupMesh()
  // cc seeds the task (agent-authored → bridges to the others with cc provenance).
  await admit(machines[0]!.store, {
    actor: 'cc', role: 'agent' as Role, channel: ROOM,
    target: { artifactId: taskArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'task.created' as const, patch: { kind: 'task' as const, data: { id: 'T1' } },
    effect: 'pure' as const, caused_by: [] as string[],
  })
  await flush(300)
  // Reconcile on every machine (the periodic tick) — must not create a second owner.
  for (const m of machines) await scheduleScope({ store: m.store, engine: m.engine, admit: p => admit(m.store, p), opts: m.schedOpts, scope: ROOM, allowBidClaim: true })
  await flush(200)
  expect((await distinctClaims(machines)).size).toBe(1)
  for (const m of machines) m.store.close()
})

test('stress: under REORDERED delivery, every machine computes the SAME winner + task owner', async () => {
  // The order-independent guarantee: with identities delivered in reverse, all three
  // machines still agree on WHO answers a broadcast and WHO owns a task — the deterministic
  // election that underpins exactly-once. (Live turn-taking additionally needs the winner's
  // stand-down signal to arrive within the failover window; if a slow transport delays it
  // past the window, a loser correctly fails over — a bounded, documented duplicate, not a
  // split-brain. Folds/computation never diverge.)
  const { machines } = await setupMesh(true)
  const eligibleOf = (m: Machine) =>
    directoryFor(m.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)).filter(id => id.rooms.includes(ROOM)).map(id => id.agentKey)

  const winners = machines.map(m => responderElection(directoryFor(m.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)), ROOM, 'discord', 'status?', 'mR')[0])
  expect(new Set(winners).size).toBe(1) // all three elect the same broadcast responder
  expect(winners[0]).toBeDefined()

  const owners = machines.map(m => meshTaskClaimant(eligibleOf(m), 'T1', 0, 1000))
  expect(new Set(owners).size).toBe(1) // all three agree who claims the task first
  expect(owners[0]).toBeDefined()
  for (const m of machines) m.store.close()
})

test('stress: a delegated task converges to ONE owner even under reordered delivery', async () => {
  const { machines, bus, nowRef } = await setupMesh(true)
  await admit(machines[0]!.store, {
    actor: 'cc', role: 'agent' as Role, channel: ROOM,
    target: { artifactId: taskArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'task.created' as const, patch: { kind: 'task' as const, data: { id: 'T1' } },
    effect: 'pure' as const, caused_by: [] as string[],
  })
  await flush(120)
  await bus.drainReversed() // deliver the task (and any claims) reordered
  // Advance past the claim window + reconcile everywhere; claims bridge + dedup by hash.
  nowRef.v += 4000
  for (const m of machines) await scheduleScope({ store: m.store, engine: m.engine, admit: p => admit(m.store, p), opts: m.schedOpts, scope: ROOM, allowBidClaim: true })
  await flush(120)
  await bus.drainReversed()
  await flush(200)
  expect((await distinctClaims(machines)).size).toBe(1) // never two different owners
  for (const m of machines) m.store.close()
})
