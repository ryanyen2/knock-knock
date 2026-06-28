/**
 * State I/O for the inert discovery stores (U2): the relay-owned pending.json and the
 * terminal-owned trust anchors in access.json. Uses a temp KNOCK_KNOCK_STATE_DIR so nothing
 * touches the developer's real ~/.knock-knock. These exercise the disk boundary — the pure
 * decision rules are covered in lib.test.ts.
 */

import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Point STATE_DIR at a throwaway dir BEFORE importing state.ts (it reads the env at module load).
const dir = mkdtempSync(join(tmpdir(), 'kk-state-'))
process.env.KNOCK_KNOCK_STATE_DIR = dir

const {
  PENDING_FILE,
  ACCESS_FILE,
  readPending,
  appendPending,
  reconcilePending,
  readTrustAnchors,
  addTombstone,
  addTrustedPair,
  saveAuthoringAccess,
  readAuthoringAccess,
} = await import('../src/state.ts')
const { defaultAuthoringAccess } = await import('../src/lib.ts')
import type { Proposal } from '../src/lib.ts'

const prop = (over: Partial<Proposal> = {}): Proposal => ({
  kind: 'peer',
  platform: 'discord',
  targetId: 'U_peer',
  claimed: { agentKey: 'k1', userId: 'U_peer', label: 'peer', blurb: 'b' },
  discoveredAt: '2026-06-28T00:00:00.000Z',
  status: 'proposed',
  ...over,
})

beforeEach(() => {
  for (const f of [PENDING_FILE, ACCESS_FILE]) if (existsSync(f)) rmSync(f)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('readPending: missing file → empty store', () => {
  expect(readPending()).toEqual({ proposals: [] })
})

test('appendPending: a proposal round-trips through save/read unchanged, incl discoveredAt', () => {
  appendPending(prop())
  const out = readPending()
  expect(out.proposals).toHaveLength(1)
  expect(out.proposals[0]!.discoveredAt).toBe('2026-06-28T00:00:00.000Z')
  expect(out.proposals[0]!.targetId).toBe('U_peer')
})

test('appendPending: honors terminal-owned tombstones from access.json', () => {
  addTombstone({ agentKey: 'k1', userId: 'U_peer', declinedAt: '2026-06-28T00:00:00.000Z' })
  appendPending(prop()) // same pair → suppressed
  expect(readPending().proposals).toHaveLength(0)
})

test('appendPending: sanitizes oversized / control-char beacon strings on store (R26)', () => {
  appendPending(prop({ claimed: { agentKey: 'k1', userId: 'U_peer', label: 'a\nb', blurb: 'x'.repeat(500) } }))
  const stored = readPending().proposals[0]!
  expect(stored.claimed.label).toBe('a b')
  expect(stored.claimed.blurb!.length).toBe(200)
})

test('reconcilePending: drops entries now confirmed in access.json and stamps lastScanAt', () => {
  appendPending(prop({ targetId: 'U_peer', claimed: { agentKey: 'k1', userId: 'U_peer' } }))
  appendPending(prop({ targetId: 'U_other', claimed: { agentKey: 'k2', userId: 'U_other' } }))
  // Confirm U_peer into the roster.
  const a = defaultAuthoringAccess()
  a.roster.peers.p1 = { platform: 'discord', userId: 'U_peer', blurb: 'b' }
  saveAuthoringAccess(a)
  const out = reconcilePending('2026-06-28T12:00:00.000Z')
  expect(out.proposals.map(p => p.targetId)).toEqual(['U_other'])
  expect(out.lastScanAt).toBe('2026-06-28T12:00:00.000Z')
})

test('corrupt pending.json is quarantined and treated as empty', () => {
  writeFileSync(PENDING_FILE, '{not json', { mode: 0o600 })
  expect(readPending()).toEqual({ proposals: [] })
  // the torn file was moved aside, not left in place to crash the next read
  expect(readdirSync(dir).some(f => f.startsWith('pending.json.corrupt-'))).toBe(true)
})

test('trust anchors survive a save/read round-trip and are terminal-owned', () => {
  addTombstone({ agentKey: 'k', userId: 'u', declinedAt: 't1' })
  addTrustedPair({ agentKey: 'k2', userId: 'u2', trustedAt: 't2' })
  const trust = readTrustAnchors()
  expect(trust.tombstones).toEqual([{ agentKey: 'k', userId: 'u', declinedAt: 't1' }])
  expect(trust.trustedPairs).toEqual([{ agentKey: 'k2', userId: 'u2', trustedAt: 't2' }])
  // idempotent per pair
  addTombstone({ agentKey: 'k', userId: 'u', declinedAt: 'later' })
  expect(readTrustAnchors().tombstones).toHaveLength(1)
})

test('U9: a relay discovery pass (append + reconcile) records proposals without touching access.json', () => {
  // Seed a confirming access.json the relay must NOT overwrite.
  const a = defaultAuthoringAccess()
  a.bots.cc = { platform: 'discord', tokenEnv: 'T', runtime: 'claude-sdk' }
  saveAuthoringAccess(a)
  const accessBefore = require('fs').readFileSync(ACCESS_FILE, 'utf8')

  appendPending(prop({ kind: 'peer', targetId: 'U_remote', claimed: { agentKey: 'rk', userId: 'U_remote' } }))
  reconcilePending('2026-06-28T00:00:00.000Z')
  expect(readPending().proposals.map(p => p.targetId)).toEqual(['U_remote'])
  // access.json is byte-for-byte unchanged — the relay is not its writer.
  expect(require('fs').readFileSync(ACCESS_FILE, 'utf8')).toBe(accessBefore)

  // Once the owner confirms the peer into the roster, the next reconcile drops it.
  const a2 = readAuthoringAccess()
  a2.roster.peers.remote = { platform: 'discord', userId: 'U_remote', blurb: 'b', agentKey: 'rk' }
  saveAuthoringAccess(a2)
  reconcilePending('2026-06-28T00:05:00.000Z')
  expect(readPending().proposals).toHaveLength(0)
})

test('parseAuthoringAccess preserves trust across a raw read (not stripped)', () => {
  writeFileSync(
    ACCESS_FILE,
    JSON.stringify({ bots: {}, channels: {}, roster: { people: {}, peers: {} }, trust: { tombstones: [{ agentKey: 'k', userId: 'u', declinedAt: 't' }], trustedPairs: [] } }),
    { mode: 0o600 },
  )
  expect(readAuthoringAccess().trust?.tombstones).toEqual([{ agentKey: 'k', userId: 'u', declinedAt: 't' }])
})
