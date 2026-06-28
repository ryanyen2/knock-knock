/**
 * MeshSync publish-gating — the fix for "two co-resident bots flood the human channel
 * with ⟦kk-mesh⟧ base64". Co-resident siblings share one ledger, so coordination events
 * must NOT be broadcast to the channel; only a genuine REMOTE peer (a directory bot this
 * relay does not host) makes mesh gossip worthwhile. Identity beacons are the exception:
 * they go out unconditionally — but via `announceIdentity` (an explicit per-connect call),
 * NOT the store subscriber, because the identity admit is content-addressed and idempotent,
 * so a reconnect produces no insert and the subscriber would never fire (the beacon would
 * silently never go out after the first run).
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { admit } from '../../src/ledger/admit.ts'
import { MeshSync } from '../../src/host/mesh-sync.ts'
import { type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import {
  agentDirectoryFold,
  directoryFor,
  dirArtifact,
  AGENT_DIRECTORY_FOLD,
  type AgentDirectoryFoldState,
} from '../../src/ledger/concepts/agent-directory.ts'
import { coordArtifact } from '../../src/ledger/concepts/coordination-board.ts'
import {
  taskDagFold,
  taskArtifact,
  taskRecordsFor,
  TASK_DAG_FOLD,
  type TaskDagFoldState,
} from '../../src/ledger/concepts/task-dag.ts'
import { isMeshLine, encodeMeshEvent, meshTaskClaimant, projectTaskDag, readyTasks } from '../../src/lib.ts'

type Recent = { authorId: string; text: string }

const ROOM: ChannelId = 'room1'
const TRANSPORT: ChannelId = 'transport1'
const flush = (ms = 60) => new Promise(r => setTimeout(r, ms))

function identity(key: string, userId: string) {
  return {
    actor: key, role: 'agent' as Role, channel: 'agent-directory' as ChannelId,
    target: { artifactId: dirArtifact(key), anchor: { kind: 'none' as const } },
    verb: 'agent.identity' as const,
    patch: { kind: 'identity' as const, data: { agentKey: key, platform: 'discord', userId, rooms: [ROOM] } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

/** Like `identity` but advertises a specific room set — mirrors a peer whose beacon lists
 *  the dedicated transport channel (every relay puts it in its agent.rooms). */
function identityInRooms(key: string, userId: string, rooms: ChannelId[]) {
  return { ...identity(key, userId), patch: { kind: 'identity' as const, data: { agentKey: key, platform: 'discord', userId, rooms } } }
}

function coordNote(key: string, channel: ChannelId = ROOM) {
  return {
    actor: key, role: 'agent' as Role, channel,
    target: { artifactId: coordArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'coord.note' as const,
    patch: { kind: 'coord' as const, note: { type: 'designation' as const, agentKey: key, ref: 'msgX' } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

async function harness(
  coResident: string[],
  transportScope?: string,
  resolveRoom: (scope: string) => string | undefined = () => ROOM,
  fetchRecent?: (scope: string, limit: number) => Promise<Recent[]>,
) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(agentDirectoryFold)
  await engine.register(taskDagFold)
  const sent: { scope: string; text: string }[] = []
  const mesh = new MeshSync({
    store,
    ownKey: 'cc',
    directory: () => directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)),
    coResidentKeys: () => new Set(coResident),
    resolveRoom,
    allRooms: () => [ROOM],
    ...(transportScope ? { transportScope: () => transportScope } : {}),
    ...(fetchRecent ? { fetchRecent } : {}),
    send: async (scope, text) => { sent.push({ scope, text }); return { id: `m${sent.length}`, scope } },
    noteBotMsg: () => {},
    log: () => {},
  })
  mesh.start()
  return { store, engine, sent, mesh }
}

/** Task-op proposal builders for replay windows (verbs in MESH_VERB_ALLOWLIST). */
function taskCreated(key: string, id: string, channel: ChannelId = ROOM) {
  return {
    actor: key, role: 'agent' as Role, channel,
    target: { artifactId: taskArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'task.created' as const,
    patch: { kind: 'task' as const, data: { id, label: id } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}
function taskClaimed(key: string, id: string, owner: string, channel: ChannelId = ROOM) {
  return {
    actor: key, role: 'agent' as Role, channel,
    target: { artifactId: taskArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'task.claimed' as const,
    patch: { kind: 'task' as const, data: { id, owner } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}
function taskCompleted(key: string, id: string, channel: ChannelId = ROOM) {
  return {
    actor: key, role: 'agent' as Role, channel,
    target: { artifactId: taskArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'task.completed' as const,
    patch: { kind: 'task' as const, data: { id } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

/** Author an interaction on a SEPARATE sender store and return its wire line — mirrors a
 *  peer relay encoding a locally-authored event for the channel. The sender's userId is the
 *  provenance the receiver checks, so ingest must be called with the same `senderUserId`.
 *  `createdAtOverride` back-dates the event (createdAt is NOT in the content hash, so the hash
 *  still validates) — used to prove replay preserves the ORIGINAL post time, not ingest time. */
async function wireLineFrom(
  proposal: Parameters<typeof admit>[1],
  createdAtOverride?: string,
): Promise<string> {
  const sender = new SqliteStore(':memory:')
  try {
    const r = await admit(sender, proposal)
    if (r.kind !== 'admitted') throw new Error(`could not author wire line: ${r.kind}`)
    const i = createdAtOverride ? { ...r.interaction, createdAt: createdAtOverride } : r.interaction
    return encodeMeshEvent(i)
  } finally {
    sender.close()
  }
}

/** Admit an identity AND announce it over the mesh, mirroring what AgentHost.publishIdentity
 *  now does on connect (admit → announceIdentity). */
async function publishIdentity(store: SqliteStore, mesh: MeshSync, key: string, userId: string) {
  const r = await admit(store, identity(key, userId))
  if (r.kind === 'admitted') await mesh.announceIdentity(r.interaction)
}

test('co-resident only: identity beacons go out, but coordination events are NOT broadcast', async () => {
  const { store, sent, mesh } = await harness(['cc', 'd-bot']) // both siblings, no remote peer
  await publishIdentity(store, mesh, 'cc', 'U_cc')
  await admit(store, identity('d-bot', 'U_db')) // sibling identity lands in the directory
  await flush()
  await admit(store, coordNote('cc')) // cc takes a message
  await flush()

  // cc's own identity beacon was sent (bootstrap); d-bot's was not (cc only announces its own).
  const lines = sent.filter(s => isMeshLine(s.text))
  expect(lines.length).toBe(1)
  // The lone coordination event produced NO channel post — the flood is gone.
  expect(sent.some(s => s.text.includes('coord'))).toBe(false)
  store.close()
})

test('remote peer present: coordination events ARE broadcast', async () => {
  const { store, sent, mesh } = await harness(['cc']) // cc is the only co-resident; eve is remote
  await publishIdentity(store, mesh, 'cc', 'U_cc')
  await admit(store, identity('eve', 'U_ev')) // a peer this relay does NOT host
  await flush()
  await admit(store, coordNote('cc'))
  await flush()

  // The identity beacon AND the coordination event both go out (a real peer needs them).
  expect(sent.filter(s => isMeshLine(s.text)).length).toBeGreaterThanOrEqual(2)
  store.close()
})

test('transport set: identity + coordination post to the transport scope, not the human room', async () => {
  // cc is the only co-resident; eve is a remote peer whose beacon lists the transport channel.
  const { store, sent, mesh } = await harness(['cc'], TRANSPORT)
  await publishIdentity(store, mesh, 'cc', 'U_cc')
  await admit(store, identityInRooms('eve', 'U_ev', [ROOM, TRANSPORT]))
  await flush()
  await admit(store, coordNote('cc'))
  await flush()

  const lines = sent.filter(s => isMeshLine(s.text))
  // Both the beacon and the coordination event went out (a real peer needs them)...
  expect(lines.length).toBeGreaterThanOrEqual(2)
  // ...and every mesh line landed on the transport channel, never the human room.
  expect(lines.every(s => s.scope === TRANSPORT)).toBe(true)
  expect(lines.some(s => s.scope === ROOM)).toBe(false)
  store.close()
})

test('transport bootstrap: the first beacon goes to transport with no peer known', async () => {
  // No remote peer yet — announceIdentity is unconditional, so bootstrap still reaches transport.
  const { store, sent, mesh } = await harness(['cc'], TRANSPORT)
  await publishIdentity(store, mesh, 'cc', 'U_cc')
  await flush()

  const lines = sent.filter(s => isMeshLine(s.text))
  expect(lines.length).toBe(1)
  expect(lines[0]!.scope).toBe(TRANSPORT)
  store.close()
})

test('identity beacon is announced on every connect, even when the admit is idempotent', async () => {
  // Regression: the beacon used to ride the store subscriber, so a reconnect (idempotent,
  // content-addressed admit → no insert) emitted nothing and cross-machine discovery died.
  const { store, sent, mesh } = await harness(['cc'])
  await admit(store, identity('cc', 'U_cc')) // first admit inserts, but the subscriber must NOT broadcast
  await flush()
  expect(sent.filter(s => isMeshLine(s.text)).length).toBe(0)

  const r1 = await admit(store, identity('cc', 'U_cc')) // idempotent (already present)
  expect(r1.kind).toBe('admitted')
  if (r1.kind === 'admitted') await mesh.announceIdentity(r1.interaction)
  expect(sent.filter(s => isMeshLine(s.text)).length).toBe(1) // announce sent it despite the no-op admit

  const r2 = await admit(store, identity('cc', 'U_cc')) // reconnect: still idempotent
  if (r2.kind === 'admitted') await mesh.announceIdentity(r2.interaction)
  expect(sent.filter(s => isMeshLine(s.text)).length).toBe(2) // and again on the next connect
  store.close()
})

// ─── Phase 1a: scope-isolated ingest (no cross-channel / cross-project pollution) ───────

const H2: ChannelId = 'h2-other-project'

test('ingest drops a foreign-channel coordination event but keeps a served-channel one', async () => {
  // cc serves ROOM only; H2 is another project sharing the same transport channel.
  const { store, mesh } = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined))
  // eve is a real peer; its identity beacon (agent-directory) must always be ingested so
  // provenance for its coordination resolves — even though cc doesn't "serve" agent-directory.
  expect(await mesh.ingest(await wireLineFrom(identity('eve', 'U_ev')), 'U_ev')).toBe(true)

  // A coord.note on H2 (a project cc does NOT serve) rides the shared transport channel and
  // must be DROPPED — folding it would pollute cc's ledger with another project's state.
  const foreign = await mesh.ingest(await wireLineFrom(coordNote('eve', H2)), 'U_ev')
  expect(foreign).toBe(false)
  expect(await store.listByChannel(H2)).toHaveLength(0)

  // A coord.note on ROOM (which cc serves) is ingested normally.
  const served = await mesh.ingest(await wireLineFrom(coordNote('eve', ROOM)), 'U_ev')
  expect(served).toBe(true)
  expect(await store.listByChannel(ROOM)).toHaveLength(1)
  store.close()
})

test('ingest always keeps an agent.identity beacon, even though agent-directory is not a served room', async () => {
  // resolveRoom returns undefined for everything — the only thing that survives is the
  // agent-directory exemption. Without it, a relay could never learn about peers.
  const { store, mesh } = await harness(['cc'], TRANSPORT, () => undefined)
  const ok = await mesh.ingest(await wireLineFrom(identity('eve', 'U_ev')), 'U_ev')
  expect(ok).toBe(true)
  expect(await store.listByChannel('agent-directory')).toHaveLength(1)
  store.close()
})

// ─── Phase 1b: history replay on reconnect (recovers the offline gap) ───────────────────

test('regression-first: a coord event missed while offline never appears WITHOUT replay, and DOES after', async () => {
  // eve (a remote peer) posted an identity beacon + a coord.note to the transport channel
  // while cc was offline. Both sit in the channel history fetchRecent reads back.
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const note = await wireLineFrom(coordNote('eve', ROOM))
  const window: Recent[] = [
    { authorId: 'U_ev', text: beacon },
    { authorId: 'U_ev', text: note },
  ]

  // No fetchRecent dep ⇒ reconcile is a no-op; the missed note never lands (today's behavior).
  const a = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined))
  await a.mesh.reconcileOnConnect()
  expect(await a.store.listByChannel(ROOM)).toHaveLength(0)
  a.store.close()

  // With fetchRecent, reconcile reads the window back and the missed note converges — no new
  // live message needed.
  const b = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)
  await b.mesh.reconcileOnConnect()
  expect(await b.store.listByChannel(ROOM)).toHaveLength(1)
  b.store.close()
})

test('identity-first: a window with a fresh peer beacon AND its coord.note ingests BOTH', async () => {
  // The coord.note depends on eve's identity for provenance. The window is ordered note-FIRST
  // to prove the two-pass reorders it: pass 1 lands the beacon, pass 2 then accepts the note.
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const note = await wireLineFrom(coordNote('eve', ROOM))
  const window: Recent[] = [
    { authorId: 'U_ev', text: note }, // out of order on purpose
    { authorId: 'U_ev', text: beacon },
  ]
  const { store, mesh } = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)
  await mesh.reconcileOnConnect()
  expect(await store.listByChannel(ROOM)).toHaveLength(1) // note NOT dropped for an unknown actor
  expect(await store.listByChannel('agent-directory')).toHaveLength(1)
  store.close()
})

test('task-fold terminality: replaying created+claimed WITHOUT completed does not resurrect a claimable task', async () => {
  // The dangerous case (plan Critical detail 2): the terminal task.completed lies OUTSIDE the
  // window, so replay sees only created+claimed. The task must settle as `claimed` (owned) —
  // never bounce back to `open`/ready where a fresh peer could re-claim and re-drive it.
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const created = await wireLineFrom(taskCreated('eve', 'T1'))
  const claimed = await wireLineFrom(taskClaimed('eve', 'T1', 'eve'))
  const window: Recent[] = [beacon, created, claimed].map(text => ({ authorId: 'U_ev', text }))

  const { store, engine, mesh } = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)
  await mesh.reconcileOnConnect()

  const records = taskRecordsFor(engine.get<TaskDagFoldState>(TASK_DAG_FOLD), ROOM)
  const board = projectTaskDag(records)
  expect(board.get('T1')?.status).toBe('claimed')
  expect(readyTasks(board).some(t => t.id === 'T1')).toBe(false) // not claimable
  store.close()
})

test('election agreement: replay preserves the original createdAt, so two relays elect the same claimant', async () => {
  // Two eligible claimants. A task.created authored 10 minutes ago (back-dated) is replayed
  // into two independent relays. Each must derive the SAME claimant slot at the same wall
  // clock — which only holds if replay keeps the ORIGINAL createdAt (age from post time, not
  // ingest time; plan Critical detail 3).
  const oldCreatedAt = '2026-06-28T12:00:00.000Z'
  const now = Date.parse('2026-06-28T12:10:00.000Z') // 10 min later
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const created = await wireLineFrom(taskCreated('eve', 'T9'), oldCreatedAt)
  const window: Recent[] = [beacon, created].map(text => ({ authorId: 'U_ev', text }))
  const eligible = ['cc', 'eve']
  const windowMs = 45_000

  const replayInto = async () => {
    const h = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)
    await h.mesh.reconcileOnConnect()
    const rec = taskRecordsFor(h.engine.get<TaskDagFoldState>(TASK_DAG_FOLD), ROOM).find(r => r.verb === 'task.created' && r.data.id === 'T9')
    h.store.close()
    return rec!.createdAt
  }

  const createdAtA = await replayInto()
  const createdAtB = await replayInto()
  expect(createdAtA).toBe(oldCreatedAt) // preserved, not re-stamped to ingest time
  expect(createdAtB).toBe(oldCreatedAt)

  const ageMs = now - Date.parse(createdAtA)
  const claimantA = meshTaskClaimant(eligible, 'T9', ageMs, windowMs)
  const claimantB = meshTaskClaimant(eligible, 'T9', now - Date.parse(createdAtB), windowMs)
  expect(claimantA).toBe(claimantB) // both relays agree on the single claimant — no double-claim
  expect(claimantA).toBeDefined()
})

test('sender parity: a replayed coord line whose author does not own the actor is rejected', async () => {
  // eve's identity is in the directory under U_ev. A coord.note for actor eve arriving from a
  // DIFFERENT platform account (U_imposter) fails decodeMeshEvent provenance — exactly as it
  // would on the live path. Replay applies the identical gate (it routes through ingest()).
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const note = await wireLineFrom(coordNote('eve', ROOM))
  const window: Recent[] = [
    { authorId: 'U_ev', text: beacon },
    { authorId: 'U_imposter', text: note }, // wrong sender for actor eve
  ]
  const { store, mesh } = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)
  await mesh.reconcileOnConnect()
  expect(await store.listByChannel(ROOM)).toHaveLength(0) // spoofed note rejected
  store.close()
})

test('idempotent + backward-compat: replaying an already-held window adds nothing; absent fetchRecent is a no-op', async () => {
  const beacon = await wireLineFrom(identity('eve', 'U_ev'))
  const note = await wireLineFrom(coordNote('eve', ROOM))
  const window: Recent[] = [beacon, note].map(text => ({ authorId: 'U_ev', text }))
  const { store, mesh } = await harness(['cc'], TRANSPORT, scope => (scope === ROOM ? ROOM : undefined), async () => window)

  await mesh.reconcileOnConnect()
  const after1 = (await store.listByChannel(ROOM)).length + (await store.listByChannel('agent-directory')).length
  await mesh.reconcileOnConnect() // replay the SAME window again
  const after2 = (await store.listByChannel(ROOM)).length + (await store.listByChannel('agent-directory')).length
  expect(after2).toBe(after1) // content-addressed ⇒ re-ingest is a no-op
  store.close()
})
