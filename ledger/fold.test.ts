/**
 * Fold engine tests: incremental updates equal a full recompute, the
 * subscribe path delivers initial state + deltas, and the seen-set guards
 * against double-application when register and subscribe race.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { Ledger } from './capture.ts'
import { hashInteraction } from './canonical.ts'
import { FoldEngine, type Fold } from './fold.ts'
import type { Interaction, ProposedInteraction } from './interaction.ts'

const COUNT_FOLD: Fold<{ count: number }> = {
  name: 'count',
  init: () => ({ count: 0 }),
  step: s => ({ count: s.count + 1 }),
}

function proposal(o: Partial<ProposedInteraction> = {}): ProposedInteraction {
  return {
    actor: 'a',
    role: 'agent',
    channel: 'c',
    target: { artifactId: 'extp:x', anchor: { kind: 'none' } },
    verb: 'turn.prompted',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [],
    ...o,
  }
}

test('FoldEngine: incremental updates match a full re-fold from scratch', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  await ledger.record(proposal({ actor: 'a' }))
  await ledger.record(proposal({ actor: 'b' }))

  const engineA = new FoldEngine(store)
  await engineA.register(COUNT_FOLD)
  await ledger.record(proposal({ actor: 'c' }))
  expect(engineA.get<{ count: number }>('count').count).toBe(3)

  // Build a second engine on the same store — bootstrap from scratch.
  const engineB = new FoldEngine(store)
  await engineB.register(COUNT_FOLD)
  expect(engineB.get<{ count: number }>('count').count).toBe(3)

  engineA.close()
  engineB.close()
  store.close()
})

test('FoldEngine: key filter is honored — non-matching interactions do not step', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  await ledger.record(proposal({ verb: 'turn.prompted' }))
  await ledger.record(proposal({ verb: 'channel.message', actor: 'b' }))

  const engine = new FoldEngine(store)
  await engine.register({
    name: 'only-prompts',
    init: () => ({ count: 0 }),
    key: i => i.verb === 'turn.prompted',
    step: s => ({ count: s.count + 1 }),
  })
  expect(engine.get<{ count: number }>('only-prompts').count).toBe(1)
  engine.close()
  store.close()
})

test('FoldEngine: subscribe delivers initial state and then deltas', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  await ledger.record(proposal({ actor: 'a' }))

  const engine = new FoldEngine(store)
  await engine.register(COUNT_FOLD)

  const seen: number[] = []
  const unsub = engine.subscribe<{ count: number }>('count', (s, delta) => {
    seen.push(s.count)
    // delta is `undefined` for the initial push, an Interaction afterwards
    if (delta) expect(delta.hash).toBeDefined()
  })
  expect(seen).toEqual([1]) // initial state
  await ledger.record(proposal({ actor: 'b' }))
  expect(seen).toEqual([1, 2])
  unsub()
  await ledger.record(proposal({ actor: 'c' }))
  expect(seen).toEqual([1, 2]) // no callback after unsubscribe
  engine.close()
  store.close()
})

test('FoldEngine: a fold whose step throws does not corrupt state', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register({
    name: 'angry',
    init: () => ({ count: 0 }),
    step: (s, i) => {
      if (i.actor === 'b') throw new Error('boom')
      return { count: s.count + 1 }
    },
  })
  await ledger.record(proposal({ actor: 'a' }))
  await ledger.record(proposal({ actor: 'b' })) // throws inside step
  await ledger.record(proposal({ actor: 'c' }))
  expect(engine.get<{ count: number }>('angry').count).toBe(2) // a + c counted, b skipped
  engine.close()
  store.close()
})

test('FoldEngine: re-registering the same fold name throws (rubric #2 sanity)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(COUNT_FOLD)
  await expect(engine.register(COUNT_FOLD)).rejects.toThrow()
  engine.close()
  store.close()
})

// ─── Re-fold on lifecycle change (close the live-stale gap) ──────────────────

/** A lifecycle-keyed fold that collects the hashes it has folded in. */
const HASHES_FOLD: Fold<{ hashes: string[] }> = {
  name: 'lc-hashes',
  init: () => ({ hashes: [] }),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') && i.verb === 'knowledge.append',
  step: (s, i) => ({ hashes: [...s.hashes, i.hash] }),
}

function note(id: string): ProposedInteraction {
  return proposal({
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id, body: id } },
    target: { artifactId: 'know:x/y', anchor: { kind: 'key', path: 'k' } },
  })
}

test('FoldEngine: a superseded interaction leaves the live fold immediately (== fresh replay)', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register(HASHES_FOLD)

  const p = note('n1')
  await ledger.record(p)
  const h = hashInteraction(p)
  expect(engine.get<{ hashes: string[] }>('lc-hashes').hashes).toEqual([h])

  await store.updateLifecycle(h, 'superseded')
  // Live fold drops it without a restart — the bug this fix closes.
  expect(engine.get<{ hashes: string[] }>('lc-hashes').hashes).toEqual([])

  // And it matches a fresh engine bootstrapped from the same store.
  const fresh = new FoldEngine(store)
  await fresh.register(HASHES_FOLD)
  expect(fresh.get<{ hashes: string[] }>('lc-hashes').hashes).toEqual([])

  fresh.close()
  engine.close()
  store.close()
})

test('FoldEngine: a proposed→applied flip enters the live fold immediately', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(HASHES_FOLD)

  // Append directly as a held (proposed) interaction — excluded by the key.
  const p = note('n1')
  const h = hashInteraction(p)
  await store.append({ ...p, hash: h, lifecycle: 'proposed', createdAt: '2026-06-09T00:00:00Z' })
  expect(engine.get<{ hashes: string[] }>('lc-hashes').hashes).toEqual([])

  // Resolve it live → it enters the live fold.
  await store.updateLifecycle(h, 'applied')
  expect(engine.get<{ hashes: string[] }>('lc-hashes').hashes).toEqual([h])

  engine.close()
  store.close()
})

test('FoldEngine: re-fold fires the affected fold subscribers exactly once', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register(HASHES_FOLD)

  const p = note('n1')
  await ledger.record(p)
  const h = hashInteraction(p)

  const sizes: number[] = []
  engine.subscribe<{ hashes: string[] }>('lc-hashes', s => sizes.push(s.hashes.length))
  expect(sizes).toEqual([1]) // initial delivery

  await store.updateLifecycle(h, 'superseded')
  expect(sizes).toEqual([1, 0]) // exactly one more call, with the rebuilt state

  engine.close()
  store.close()
})

test('FoldEngine: a lifecycle change does not re-notify folds whose verdict is lifecycle-independent for it', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register(HASHES_FOLD)
  await engine.register({
    name: 'prompts',
    init: () => ({ count: 0 }),
    key: i => i.verb === 'turn.prompted',
    step: s => ({ count: s.count + 1 }),
  })

  await ledger.record(proposal({ verb: 'turn.prompted' })) // feeds 'prompts' only
  const p = note('n1')
  await ledger.record(p)
  const h = hashInteraction(p)

  const promptFires: number[] = []
  engine.subscribe<{ count: number }>('prompts', s => promptFires.push(s.count))
  expect(promptFires).toEqual([1]) // initial only

  // Superseding a knowledge.append must not refold (or re-notify) the prompts fold.
  await store.updateLifecycle(h, 'superseded')
  expect(promptFires).toEqual([1]) // no extra fire

  engine.close()
  store.close()
})
