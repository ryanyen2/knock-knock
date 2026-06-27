/**
 * MeshSync publish-gating — the fix for "two co-resident bots flood the human channel
 * with ⟦kk-mesh⟧ base64". Co-resident siblings share one ledger, so coordination events
 * must NOT be broadcast to the channel; only a genuine REMOTE peer (a directory bot this
 * relay does not host) makes mesh gossip worthwhile. Identity beacons are the exception:
 * they go out unconditionally so two relays can discover each other.
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

function coordNote(key: string) {
  return {
    actor: key, role: 'agent' as Role, channel: ROOM,
    target: { artifactId: coordArtifact(ROOM), anchor: { kind: 'none' as const } },
    verb: 'coord.note' as const,
    patch: { kind: 'coord' as const, note: { type: 'designation' as const, agentKey: key, ref: 'msgX' } },
    effect: 'pure' as const, caused_by: [] as string[],
  }
}

async function harness(coResident: string[]) {
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
    send: async (scope, text) => { sent.push({ scope, text }); return { id: `m${sent.length}`, scope } },
    noteBotMsg: () => {},
    log: () => {},
  })
  mesh.start()
  return { store, engine, sent, mesh }
}

test('co-resident only: identity beacons go out, but coordination events are NOT broadcast', async () => {
  const { store, sent } = await harness(['cc', 'd-bot']) // both siblings, no remote peer
  await admit(store, identity('cc', 'U_cc'))
  await admit(store, identity('d-bot', 'U_db')) // sibling identity lands in the directory
  await flush()
  await admit(store, coordNote('cc')) // cc takes a message
  await flush()

  // cc's own identity beacon was sent (bootstrap); d-bot's was not (cc only publishes its own).
  const lines = sent.filter(s => isMeshLine(s.text))
  expect(lines.length).toBe(1)
  // The lone coordination event produced NO channel post — the flood is gone.
  expect(sent.some(s => s.text.includes('coord'))).toBe(false)
  store.close()
})

test('remote peer present: coordination events ARE broadcast', async () => {
  const { store, sent } = await harness(['cc']) // cc is the only co-resident; eve is remote
  await admit(store, identity('cc', 'U_cc'))
  await admit(store, identity('eve', 'U_ev')) // a peer this relay does NOT host
  await flush()
  await admit(store, coordNote('cc'))
  await flush()

  // The identity beacon AND the coordination event both go out (a real peer needs them).
  expect(sent.filter(s => isMeshLine(s.text)).length).toBeGreaterThanOrEqual(2)
  store.close()
})
