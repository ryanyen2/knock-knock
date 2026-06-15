/**
 * Fold engine tests: incremental updates equal a full recompute, the
 * subscribe path delivers initial state + deltas, and the seen-set guards
 * against double-application when register and subscribe race.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import { SqliteStore } from './store-sqlite.ts'
import { Ledger } from './capture.ts'
import { hashInteraction } from './canonical.ts'
import { FoldEngine, type Fold } from './fold.ts'
import type { Interaction, ProposedInteraction } from './interaction.ts'
import {
  mutateAndEncode,
  projectVersionable,
  versionableArtifactId,
  versionableFold,
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  type VersionableFoldState,
} from './artifacts/versionable.ts'

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

test('AOCM (U7): separate stores converge to identical projection under shuffled INSERT delivery', async () => {
  // R6: the merge re-projects from INSERTs alone — no lifecycle UPDATE. Build a
  // fixed op-set, deliver it to two independent stores in DIFFERENT orders, and
  // assert both engines project byte-identical text + identical derived conflicts.
  // (Convergence is by construction: projectVersionable orders by (role,hash), so
  // insertion order cannot change the result. This pins that property in-process.)
  const seedDoc = new Y.Doc()
  const seedOps = mutateAndEncode(seedDoc, t => t.insert(0, 'hello world'))
  seedDoc.destroy()
  const mkOps = (mutate: (t: Y.Text) => void) => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(seedOps, 'base64'))
    const ops = mutateAndEncode(d, mutate)
    d.destroy()
    return ops
  }
  const artifactId = versionableArtifactId('chan', 'foo.ts')
  const mk = (
    actor: string,
    role: 'owner' | 'agent',
    ops: string,
    intent: { kind: 'edit'; oldString: string; newString: string },
    parents: string[],
  ): Interaction => {
    const p: ProposedInteraction = {
      actor, role, channel: 'chan',
      target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
      patch: { kind: 'versionable', ops, intent },
      effect: 'workspace', caused_by: parents,
    }
    return { ...p, hash: hashInteraction(p), lifecycle: 'applied', createdAt: new Date().toISOString() }
  }
  const seed: Interaction = (() => {
    const p: ProposedInteraction = {
      actor: 'seedbot', role: 'agent', channel: 'chan',
      target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
      patch: { kind: 'versionable', ops: seedOps, intent: { kind: 'write', content: 'hello world' } },
      effect: 'workspace', caused_by: [],
    }
    return { ...p, hash: hashInteraction(p), lifecycle: 'applied', createdAt: new Date().toISOString() }
  })()
  const a = mk('botA', 'agent', mkOps(t => { t.delete(0, 5); t.insert(0, 'HI') }), { kind: 'edit', oldString: 'hello', newString: 'HI' }, [seed.hash])
  const b = mk('botB', 'agent', mkOps(t => { t.delete(0, 5); t.insert(0, 'YO') }), { kind: 'edit', oldString: 'hello', newString: 'YO' }, [seed.hash])
  // An owner edit that dominates both (concurrent sibling, owner role) → resolves.
  const owner = mk('owner1', 'owner', mkOps(t => { t.delete(0, 5); t.insert(0, 'HI') }), { kind: 'edit', oldString: 'hello', newString: 'HI' }, [seed.hash])

  const ops = [seed, a, b, owner]
  const project = async (order: Interaction[]) => {
    const store = new SqliteStore(':memory:')
    const engine = new FoldEngine(store)
    await engine.register(versionableFold)
    for (const i of order) await store.append(i)
    const r = projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
    engine.close()
    store.close()
    return r
  }

  const forward = await project(ops)
  const shuffled = await project([owner, b, seed, a]) // different store, different order
  expect(shuffled.text).toBe(forward.text)
  expect(shuffled.conflicts).toEqual(forward.conflicts)
  expect(forward.conflicts).toEqual([]) // owner dominates both agents silently → no surviving conflict
  expect(forward.text).toContain('HI')
})
