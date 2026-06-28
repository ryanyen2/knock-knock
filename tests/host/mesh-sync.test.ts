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
import { isMeshLine } from '../../src/lib.ts'

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

function coordNote(key: string) {
  return {
    actor: key, role: 'agent' as Role, channel: ROOM,
    target: { artifactId: coordArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'coord.note' as const,
    patch: { kind: 'coord' as const, note: { type: 'designation' as const, agentKey: key, ref: 'msgX' } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

async function harness(coResident: string[], transportScope?: string) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(agentDirectoryFold)
  const sent: { scope: string; text: string }[] = []
  const mesh = new MeshSync({
    store,
    ownKey: 'cc',
    directory: () => directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)),
    coResidentKeys: () => new Set(coResident),
    resolveRoom: () => ROOM,
    allRooms: () => [ROOM],
    ...(transportScope ? { transportScope: () => transportScope } : {}),
    send: async (scope, text) => { sent.push({ scope, text }); return { id: `m${sent.length}`, scope } },
    noteBotMsg: () => {},
    log: () => {},
  })
  mesh.start()
  return { store, engine, sent, mesh }
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
