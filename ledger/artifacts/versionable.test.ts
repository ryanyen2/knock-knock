/**
 * Versionable artifact: Y.update apply, encode, and the diffAsUpdate helper.
 *
 * Phase 2 scope is the algorithm in isolation — the relay's file-edit flow
 * doesn't yet produce these patches. Tests here prove the building blocks
 * are correct so the integration in Phase 2+ doesn't have to debug them.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import {
  applyEdits,
  mutateAndEncode,
  encodeUpdate,
  versionableArtifactId,
  projectVersionable,
  versionableFold,
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  interferes,
  regionOf,
  type VersionableFoldState,
} from './versionable.ts'
import type { VersionableIntent } from '../interaction.ts'
import { hashInteraction } from '../canonical.ts'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import type { Interaction, ProposedInteraction } from '../interaction.ts'

function editFromOps(opsBase64: string, parents: string[] = []): Interaction {
  const p: ProposedInteraction = {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan',
    target: { artifactId: 'vers:repo/foo.ts', anchor: { kind: 'crdt', rgaPos: '0' } },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops: opsBase64 },
    effect: 'workspace',
    caused_by: parents,
  }
  return {
    ...p,
    hash: hashInteraction(p),
    lifecycle: 'applied',
    createdAt: new Date().toISOString(),
  }
}

test('versionable: applying an empty edit list returns empty text', () => {
  const r = applyEdits([])
  expect(r.text).toBe('')
  expect(r.ops).toBe(0)
})

test('versionable: a single insert update produces the expected text', () => {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'hello')
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  const edit = editFromOps(encodeUpdate(update))
  expect(applyEdits([edit]).text).toBe('hello')
})

test('versionable: a sequence of updates composes in order', () => {
  // Build a chain of three edits, each from the previous state, applied in order.
  const doc = new Y.Doc()
  const text = doc.getText('content')

  text.insert(0, 'A')
  const u1 = encodeUpdate(Y.encodeStateAsUpdate(doc))

  const baseline2 = Y.encodeStateVector(doc)
  text.insert(text.length, 'B')
  const u2 = encodeUpdate(Y.encodeStateAsUpdate(doc, baseline2))

  const baseline3 = Y.encodeStateVector(doc)
  text.insert(text.length, 'C')
  const u3 = encodeUpdate(Y.encodeStateAsUpdate(doc, baseline3))

  doc.destroy()

  const e1 = editFromOps(u1)
  const e2 = editFromOps(u2, [e1.hash])
  const e3 = editFromOps(u3, [e2.hash])
  const r = applyEdits([e1, e2, e3])
  expect(r.text).toBe('ABC')
  expect(r.ops).toBe(3)
})

test('versionable: mutateAndEncode captures a delta against the doc state vector', () => {
  // mutateAndEncode runs the mutation on the live doc and returns a Y.update
  // that contains ONLY the new operations (relative to the pre-mutation state
  // vector). Replaying the snapshot + the delta against a fresh doc that
  // started empty reproduces the final text.
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'the quick brown fox')
  const snapshot = encodeUpdate(Y.encodeStateAsUpdate(doc))
  const delta = mutateAndEncode(doc, text => {
    text.delete(4, 5)
    text.insert(4, 'LAZY')
  })
  expect(doc.getText('content').toString()).toBe('the LAZY brown fox')

  // Snapshot + delta applied in order to a fresh doc yields the final text.
  const fresh = new Y.Doc()
  Y.applyUpdate(fresh, Buffer.from(snapshot, 'base64'))
  Y.applyUpdate(fresh, Buffer.from(delta, 'base64'))
  expect(fresh.getText('content').toString()).toBe('the LAZY brown fox')
  doc.destroy()
  fresh.destroy()
})

test('versionable: patches missing ops are skipped (defensive)', () => {
  const broken = editFromOps('')
  const r = applyEdits([broken])
  expect(r.ops).toBe(0)
  expect(r.text).toBe('')
})

test('versionable: concurrent edits to non-overlapping ranges Yjs-merge naturally', () => {
  // Both writers start from the same base and edit different positions.
  const base = new Y.Doc()
  base.getText('content').insert(0, 'hello world')
  const baseVec = Y.encodeStateVector(base)

  const writerA = new Y.Doc()
  Y.applyUpdate(writerA, Y.encodeStateAsUpdate(base))
  writerA.getText('content').insert(0, 'XX ')
  const opsA = encodeUpdate(Y.encodeStateAsUpdate(writerA, baseVec))

  const writerB = new Y.Doc()
  Y.applyUpdate(writerB, Y.encodeStateAsUpdate(base))
  writerB.getText('content').insert(writerB.getText('content').length, ' YY')
  const opsB = encodeUpdate(Y.encodeStateAsUpdate(writerB, baseVec))

  const seed = editFromOps(encodeUpdate(Y.encodeStateAsUpdate(base)))
  const a = editFromOps(opsA, [seed.hash])
  const b = editFromOps(opsB, [seed.hash])

  const result = applyEdits([seed, a, b]).text
  // The Yjs merge should contain both prefix and suffix; order may vary
  // by client id but both contributions are present.
  expect(result).toContain('XX ')
  expect(result).toContain(' YY')
  expect(result).toContain('hello world')

  base.destroy()
  writerA.destroy()
  writerB.destroy()
})

async function aocmSetup() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  const artifactId = versionableArtifactId('chan', 'foo.ts')
  // Seed base text "hello world".
  const seedDoc = new Y.Doc()
  const seedOps = mutateAndEncode(seedDoc, t => t.insert(0, 'hello world'))
  seedDoc.destroy()
  const seed = await admit(store, {
    actor: 'seedbot', role: 'agent', channel: 'chan',
    target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
    patch: { kind: 'versionable', ops: seedOps, intent: { kind: 'write', content: 'hello world' } },
    effect: 'workspace', caused_by: [],
  })
  const seedHash = (seed as { interaction: { hash: string } }).interaction.hash
  // Build a delta edit against the seed state (concurrent edits share seedHash as parent).
  const mkOps = (mutate: (t: Y.Text) => void) => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(seedOps, 'base64'))
    const ops = mutateAndEncode(d, mutate)
    d.destroy()
    return ops
  }
  const proj = () => projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  const cleanup = () => { engine.close(); store.close() }
  return { store, engine, artifactId, seedHash, mkOps, proj, cleanup }
}

test('versionable (U4): disjoint equal-role edits both survive, no conflict', async () => {
  const { store, artifactId, seedHash, mkOps, proj, cleanup } = await aocmSetup()
  // A edits "hello" → "HELLO" (region [0,5]); B edits "world" → "WORLD" (region [6,11]) — disjoint.
  const mkEdit = (actor: string, ops: string, oldString: string, newString: string) =>
    admit(store, {
      actor, role: 'agent' as const, channel: 'chan',
      target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit' as const,
      patch: { kind: 'versionable' as const, ops, intent: { kind: 'edit' as const, oldString, newString } },
      effect: 'workspace' as const, caused_by: [seedHash],
    })
  await mkEdit('botA', mkOps(t => { t.delete(0, 5); t.insert(0, 'HELLO') }), 'hello', 'HELLO')
  await mkEdit('botB', mkOps(t => { t.delete(6, 5); t.insert(6, 'WORLD') }), 'world', 'WORLD')
  const r = proj()
  expect(r.conflicts).toEqual([]) // disjoint regions → no interference
  expect(r.text).toContain('HELLO')
  expect(r.text).toContain('WORLD')
  cleanup()
})

test('versionable (U4): same-region equal-role edits record a conflict (deterministic live text)', async () => {
  const { store, artifactId, seedHash, mkOps, proj, cleanup } = await aocmSetup()
  // Both edit "hello" → interference; equal role → first-class conflict, lower-hash kept.
  const mkEdit = (actor: string, ops: string, newString: string) =>
    admit(store, {
      actor, role: 'agent' as const, channel: 'chan',
      target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit' as const,
      patch: { kind: 'versionable' as const, ops, intent: { kind: 'edit' as const, oldString: 'hello', newString } },
      effect: 'workspace' as const, caused_by: [seedHash],
    })
  const a = await mkEdit('botA', mkOps(t => { t.delete(0, 5); t.insert(0, 'HI') }), 'HI')
  const b = await mkEdit('botB', mkOps(t => { t.delete(0, 5); t.insert(0, 'YO') }), 'YO')
  const aHash = (a as { interaction: { hash: string } }).interaction.hash
  const bHash = (b as { interaction: { hash: string } }).interaction.hash
  const r = proj()
  expect(r.conflicts.length).toBe(1)
  expect(r.conflicts[0]!.branches.slice().sort()).toEqual([aHash, bHash].sort())
  // Live text reflects exactly one branch (deterministic lower-hash winner), never an interleave.
  const winner = aHash < bHash ? 'HI' : 'YO'
  const loser = aHash < bHash ? 'YO' : 'HI'
  expect(r.text).toContain(winner)
  expect(r.text).not.toContain(loser)
  cleanup()
})

test('versionable (U3): interference is region-overlap on the common base', () => {
  const base = 'the quick brown fox jumps'
  const editFox: VersionableIntent = { kind: 'edit', oldString: 'fox', newString: 'cat' } // region [16,19]
  const editFox2: VersionableIntent = { kind: 'edit', oldString: 'fox', newString: 'dog' } // same region [16,19]
  const editThe: VersionableIntent = { kind: 'edit', oldString: 'the', newString: 'a' } // region [0,3]
  const write: VersionableIntent = { kind: 'write', content: 'totally new' }
  const writeB: VersionableIntent = { kind: 'write', content: 'other new' }

  // Same region → interfere.
  expect(interferes(editFox, editFox2, base)).toBe(true)
  // Disjoint regions → no interference.
  expect(interferes(editFox, editThe, base)).toBe(false)
  // Write spans the whole file → interferes with any edit.
  expect(interferes(write, editFox, base)).toBe(true)
  expect(interferes(editThe, write, base)).toBe(true)
  // Two whole-file writes always interfere (irreconcilable) — even on an empty base.
  expect(interferes(write, writeB, base)).toBe(true)
  expect(interferes(write, writeB, '')).toBe(true)
  // Absent oldString fails safe to the whole file → interferes.
  const editMissing: VersionableIntent = { kind: 'edit', oldString: 'zzz', newString: 'q' }
  expect(regionOf(editMissing, base)).toEqual({ lo: 0, hi: base.length })
  expect(interferes(editMissing, editThe, base)).toBe(true)
  // Adjacent regions that only touch at a boundary do not interfere (half-open).
  const editQuick: VersionableIntent = { kind: 'edit', oldString: 'quick', newString: 'slow' } // [4,9]
  const editSpace: VersionableIntent = { kind: 'edit', oldString: ' brown', newString: '' } // [9,15]
  expect(interferes(editQuick, editSpace, base)).toBe(false)
})

test('versionable (U2): the normalized intent round-trips and participates in the content hash', () => {
  // AOCM retains the path-free EditIntent on the patch for the interference test.
  // It must be in the hash (so two replicas building the same edit agree) and
  // distinct intents must hash distinctly.
  const withEdit: ProposedInteraction = {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan',
    target: { artifactId: 'vers:repo/foo.ts', anchor: WHOLE_FILE_ANCHOR },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops: 'AA==', intent: { kind: 'edit', oldString: 'a', newString: 'b' } },
    effect: 'workspace',
    caused_by: [],
  }
  // Identical content → identical hash (deterministic, plain-JSON intent).
  expect(hashInteraction(withEdit)).toBe(hashInteraction({ ...withEdit }))
  // Different intent → different hash (intent is in the hashed patch).
  const withOtherIntent: ProposedInteraction = {
    ...withEdit,
    patch: { kind: 'versionable', ops: 'AA==', intent: { kind: 'edit', oldString: 'a', newString: 'c' } },
  }
  expect(hashInteraction(withOtherIntent)).not.toBe(hashInteraction(withEdit))
  // Intent present vs absent → different hash (the field is part of identity).
  const withoutIntent: ProposedInteraction = { ...withEdit, patch: { kind: 'versionable', ops: 'AA==' } }
  expect(hashInteraction(withoutIntent)).not.toBe(hashInteraction(withEdit))
})

test('versionable: a superseded edit leaves the live projection immediately (== fresh replay)', async () => {
  // The motivating case for the lifecycle re-fold: two concurrent whole-file
  // edits contend at WHOLE_FILE_ANCHOR; the owner's edit supersedes the agent's,
  // and the agent's edit must drop from the LIVE projection without a restart.
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)

  const artifactId = versionableArtifactId('chan', 'foo.ts')
  const versProposal = (actor: string, role: 'owner' | 'agent', ops: string): ProposedInteraction => ({
    actor,
    role,
    channel: 'chan',
    target: { artifactId, anchor: WHOLE_FILE_ANCHOR },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops },
    effect: 'workspace',
    caused_by: [], // concurrent — neither is the other's ancestor
  })

  const docA = new Y.Doc()
  const opsA = mutateAndEncode(docA, t => t.insert(0, 'AAA'))
  docA.destroy()
  const docB = new Y.Doc()
  const opsB = mutateAndEncode(docB, t => t.insert(0, 'BBB'))
  docB.destroy()

  await admit(store, versProposal('bot1', 'agent', opsA)) // applied
  const owner = await admit(store, versProposal('owner1', 'owner', opsB)) // owner > agent → supersedes
  expect(owner.kind).toBe('admitted')

  // Live: only the owner's edit remains; the agent's superseded edit is gone now.
  const live = projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  expect(live.text).toBe('BBB')

  const fresh = new FoldEngine(store)
  await fresh.register(versionableFold)
  const replay = projectVersionable(fresh.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  expect(replay.text).toBe('BBB')

  fresh.close()
  engine.close()
  store.close()
})

// ─── U14: shared predicate + live-hash exposure ─────────────────────────────

test('isVersionableEdit: accepts admitted|applied versionable edits, rejects others', async () => {
  const { isVersionableEdit } = await import('./versionable.ts')
  const base = {
    verb: 'workspace.edit',
    target: { artifactId: 'vers:repo/x.ts', anchor: WHOLE_FILE_ANCHOR },
    patch: { kind: 'versionable', ops: '' },
  }
  expect(isVersionableEdit({ ...base, lifecycle: 'applied' } as any)).toBe(true)
  expect(isVersionableEdit({ ...base, lifecycle: 'admitted' } as any)).toBe(true)
  expect(isVersionableEdit({ ...base, lifecycle: 'proposed' } as any)).toBe(false)
  // wrong verb / non-vers artifact / wrong patch kind are all rejected
  expect(isVersionableEdit({ ...base, lifecycle: 'applied', verb: 'turn.replied' } as any)).toBe(false)
  expect(
    isVersionableEdit({ ...base, lifecycle: 'applied', target: { artifactId: 'know:x', anchor: WHOLE_FILE_ANCHOR } } as any),
  ).toBe(false)
  expect(isVersionableEdit({ ...base, lifecycle: 'applied', patch: { kind: 'none' } } as any)).toBe(false)
})

test('projectVersionable.live lists the kept edits (single edit → itself)', async () => {
  const { liveVersionableEditHashes } = await import('./versionable.ts')
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  const artifactId = 'vers:repo/foo.ts'

  const doc = new Y.Doc()
  const ops = mutateAndEncode(doc, t => t.insert(0, 'hello'))
  doc.destroy()
  const res = await admit(store, {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan',
    target: { artifactId, anchor: WHOLE_FILE_ANCHOR },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops },
    effect: 'workspace',
    caused_by: [],
  })
  expect(res.kind).toBe('admitted')
  const hash = res.kind === 'admitted' ? res.interaction.hash : ''

  const state = engine.get<VersionableFoldState>(VERSIONABLE_FOLD)
  const proj = projectVersionable(state, artifactId)
  expect(proj.live).toEqual([hash])
  expect(liveVersionableEditHashes(state, artifactId)).toEqual([hash])

  engine.close()
  store.close()
})
