/**
 * Phase 0 tests: hashing is deterministic, the store round-trips, idempotent
 * record() returns the same row on duplicate content, and the role snapshot
 * survives unchanged (the merge function in Phase 2 trusts this).
 */

import { test, expect } from 'bun:test'
import { canonicalJson, hashInteraction, verifyHash } from './canonical.ts'
import { SqliteStore } from './store-sqlite.ts'
import { Ledger } from './capture.ts'
import type { ProposedInteraction } from './interaction.ts'

function proposal(overrides: Partial<ProposedInteraction> = {}): ProposedInteraction {
  return {
    actor: 'owner1',
    role: 'owner',
    channel: 'chan1',
    target: { artifactId: 'extp:discord/chan1', anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [],
    ...overrides,
  }
}

// ─── canonicalJson ──────────────────────────────────────────────────────────

test('canonicalJson sorts object keys deterministically', () => {
  const a = canonicalJson({ b: 1, a: 2 })
  const b = canonicalJson({ a: 2, b: 1 })
  expect(a).toBe(b)
  expect(a).toBe('{"a":2,"b":1}')
})

test('canonicalJson nests sorted keys recursively', () => {
  expect(canonicalJson({ z: { b: 2, a: 1 }, a: [3, 2, 1] })).toBe(
    '{"a":[3,2,1],"z":{"a":1,"b":2}}',
  )
})

test('canonicalJson rejects non-finite numbers (would silently corrupt the hash)', () => {
  expect(() => canonicalJson({ x: NaN })).toThrow()
  expect(() => canonicalJson({ x: Infinity })).toThrow()
})

test('canonicalJson elides undefined fields (matches JSON.stringify semantics)', () => {
  expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
})

// ─── hashInteraction ────────────────────────────────────────────────────────

test('hashInteraction: same content → same hash, regardless of field order', () => {
  const a = hashInteraction({
    actor: 'u',
    role: 'owner',
    channel: 'c',
    target: { artifactId: 'extp:x', anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: ['z', 'a'],
  })
  const b = hashInteraction({
    caused_by: ['a', 'z'], // different order
    target: { anchor: { kind: 'none' }, artifactId: 'extp:x' },
    actor: 'u',
    role: 'owner',
    channel: 'c',
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
  })
  expect(a).toBe(b)
  expect(a).toHaveLength(64) // sha256 hex
})

test('hashInteraction: different content → different hash', () => {
  const a = hashInteraction(proposal())
  const b = hashInteraction(proposal({ actor: 'owner2' }))
  expect(a).not.toBe(b)
})

test('hashInteraction: caused_by is order-independent', () => {
  const a = hashInteraction(proposal({ caused_by: ['aaa', 'bbb', 'ccc'] }))
  const b = hashInteraction(proposal({ caused_by: ['ccc', 'aaa', 'bbb'] }))
  expect(a).toBe(b)
})

test('hashInteraction: duplicate causes are deduped', () => {
  const a = hashInteraction(proposal({ caused_by: ['aaa', 'bbb'] }))
  const b = hashInteraction(proposal({ caused_by: ['aaa', 'aaa', 'bbb'] }))
  expect(a).toBe(b)
})

// ─── Role snapshot ─────────────────────────────────────────────────────────

test('role snapshot: changing role changes the hash (snapshot is load-bearing)', () => {
  const owner = hashInteraction(proposal({ role: 'owner' }))
  const human = hashInteraction(proposal({ role: 'human' }))
  const agent = hashInteraction(proposal({ role: 'agent' }))
  expect(new Set([owner, human, agent]).size).toBe(3)
})

// ─── SqliteStore round-trip ────────────────────────────────────────────────

test('SqliteStore: append + getByHash round-trips a full Interaction', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const i = await ledger.record(proposal({ verb: 'turn.prompted', role: 'agent', actor: 'bot' }))

  const back = await store.getByHash(i.hash)
  expect(back).toBeDefined()
  expect(back!.hash).toBe(i.hash)
  expect(back!.verb).toBe('turn.prompted')
  expect(back!.role).toBe('agent')
  expect(verifyHash(back!)).toBe(true)
  store.close()
})

test('SqliteStore: append is idempotent on same content', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)

  const first = await ledger.record(proposal())
  const second = await ledger.record(proposal())

  expect(first.hash).toBe(second.hash)
  const all = await store.listByChannel('chan1')
  expect(all).toHaveLength(1) // dedup
  store.close()
})

test('SqliteStore: latestInChannel returns the most-recent insertion', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  await ledger.record(proposal({ actor: 'a' }))
  await ledger.record(proposal({ actor: 'b' }))
  const latest = await store.latestInChannel('chan1')
  expect(latest?.actor).toBe('b')
  store.close()
})

test('SqliteStore: listByChannel scopes by channel and respects sinceSeq', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  await ledger.record(proposal({ channel: 'c1', actor: 'a' }))
  await ledger.record(proposal({ channel: 'c2', actor: 'b' }))
  await ledger.record(proposal({ channel: 'c1', actor: 'c' }))

  const c1 = await store.listByChannel('c1')
  expect(c1.map(i => i.actor)).toEqual(['a', 'c'])
  const c2 = await store.listByChannel('c2')
  expect(c2.map(i => i.actor)).toEqual(['b'])
  store.close()
})

test('SqliteStore: caused_by parent edges populate interaction_parent', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const root = await ledger.record(proposal({ actor: 'root' }))
  const child = await ledger.record(proposal({ actor: 'child', caused_by: [root.hash] }))

  expect(await store.isAncestor(root.hash, child.hash)).toBe(true)
  expect(await store.isAncestor(child.hash, root.hash)).toBe(false)
  store.close()
})

test('SqliteStore: subscribe fires on insert, not on duplicate', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const seen: string[] = []
  store.subscribe(i => seen.push(i.actor))

  await ledger.record(proposal({ actor: 'a' }))
  await ledger.record(proposal({ actor: 'a' })) // duplicate — same hash
  await ledger.record(proposal({ actor: 'b' }))

  expect(seen).toEqual(['a', 'b'])
  store.close()
})

test('SqliteStore: isAncestor is bounded by maxDepth (returns false on overflow)', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  // Build a 5-deep chain
  let prevHash: string | undefined
  const hashes: string[] = []
  for (let n = 0; n < 5; n++) {
    const i = await ledger.record(
      proposal({ actor: `n${n}`, caused_by: prevHash ? [prevHash] : [] }),
    )
    hashes.push(i.hash)
    prevHash = i.hash
  }
  // Bound depth at 2 — root is unreachable from leaf.
  expect(await store.isAncestor(hashes[0]!, hashes[4]!, 2)).toBe(false)
  expect(await store.isAncestor(hashes[0]!, hashes[4]!, 64)).toBe(true)
  store.close()
})

// ─── Frontier ──────────────────────────────────────────────────────────────

test('SqliteStore: channelFrontier returns heads with no admitted children', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const a = await ledger.record(proposal({ actor: 'a' }))
  const b = await ledger.record(proposal({ actor: 'b', caused_by: [a.hash] }))
  // c is concurrent with b (both reference a)
  const c = await ledger.record(proposal({ actor: 'c', caused_by: [a.hash] }))

  const frontier = await store.channelFrontier('chan1')
  expect(new Set(frontier)).toEqual(new Set([b.hash, c.hash]))
  store.close()
})
