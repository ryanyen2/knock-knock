/**
 * AOCM property-test battery — the R9 ship gate.
 *
 * Three layers, none of which re-implements the fold:
 *  1. CORPUS (AE1–AE7): named acceptance examples with HAND-AUTHORED expected
 *     resolved text/conflicts. The expectations are constants the author asserts
 *     are correct, never `projectVersionable(...)` compared to itself.
 *  2. SKEW FUZZ: K≥2 replicas as SEPARATE in-memory stores; the same op-set is
 *     delivered to each in a different (seeded-shuffled) order. The oracle is
 *     CONVERGENCE — every replica must project byte-identical text + identical
 *     derived conflicts — plus a hand-authored authority invariant (a higher-role
 *     edit's text must win over an interfering lower-role one). Coverage of the
 *     three interference categories (disjoint / same-region-different-role /
 *     same-region-equal-role) is enforced; a trivial all-disjoint generator fails.
 *  3. TEETH: a deliberately role-BLIND projector must disagree with the authority
 *     outcome on the corpus — proving the assertions would catch a broken merge.
 *
 * AE4 (owner resolves) and AE6 (override notice fires) run the real admit +
 * resolveConflict flow and are covered in resolve-conflict.test.ts; AE4 is also
 * exercised here end-to-end for convergence.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import { SqliteStore } from './store-sqlite.ts'
import { FoldEngine } from './fold.ts'
import { Ledger } from './capture.ts'
import { admit, inboxArtifact } from './admit.ts'
import { resolveConflict } from './resolve-conflict.ts'
import { hashInteraction } from './canonical.ts'
import { ROLE_RANK } from './interaction.ts'
import type { Interaction, ProposedInteraction, Role, VersionableIntent } from './interaction.ts'
import {
  interferes,
  mutateAndEncode,
  projectVersionable,
  versionableArtifactId,
  versionableFold,
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  type ConflictRegion,
  type VersionableFoldState,
} from './artifacts/versionable.ts'

// ─── Fixture: a flat op-set (seed + concurrent children) over a 4-word base ──────
const BASE = 'alpha bravo charlie delta' // alpha[0,5] bravo[6,11] charlie[12,19] delta[20,25]
const artifactId = versionableArtifactId('chan', 'foo.ts')

const SEED_OPS = (() => {
  const d = new Y.Doc()
  const o = mutateAndEncode(d, t => t.insert(0, BASE))
  d.destroy()
  return o
})()
function finalize(p: ProposedInteraction): Interaction {
  return { ...p, hash: hashInteraction(p), lifecycle: 'applied', createdAt: new Date().toISOString() }
}
const SEED = finalize({
  actor: 'seedbot', role: 'agent', channel: 'chan',
  target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
  patch: { kind: 'versionable', ops: SEED_OPS, intent: { kind: 'write', content: BASE } },
  effect: 'workspace', caused_by: [],
})

/** A concurrent edit replacing `oldString` (a word in BASE) with `newString`. */
function mkEdit(actor: string, role: Role, oldString: string, newString: string): Interaction {
  const d = new Y.Doc()
  Y.applyUpdate(d, Buffer.from(SEED_OPS, 'base64'))
  const idx = BASE.indexOf(oldString)
  const ops = mutateAndEncode(d, t => { t.delete(idx, oldString.length); t.insert(idx, newString) })
  d.destroy()
  return finalize({
    actor, role, channel: 'chan',
    target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
    patch: { kind: 'versionable', ops, intent: { kind: 'edit', oldString, newString } },
    effect: 'workspace', caused_by: [SEED.hash],
  })
}
/** A concurrent whole-file write. */
function mkWrite(actor: string, role: Role, content: string): Interaction {
  const d = new Y.Doc()
  Y.applyUpdate(d, Buffer.from(SEED_OPS, 'base64'))
  const ops = mutateAndEncode(d, t => { t.delete(0, t.length); t.insert(0, content) })
  d.destroy()
  return finalize({
    actor, role, channel: 'chan',
    target: { artifactId, anchor: WHOLE_FILE_ANCHOR }, verb: 'workspace.edit',
    patch: { kind: 'versionable', ops, intent: { kind: 'write', content } },
    effect: 'workspace', caused_by: [SEED.hash],
  })
}

/** Project a flat op-set on a fresh, independent store. */
async function projectFresh(ops: Interaction[]) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  for (const i of ops) await store.append(i)
  const r = projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  engine.close()
  store.close()
  return r
}

// ─── 1. Corpus (AE1–AE7), hand-authored expectations ────────────────────────────

test('AOCM corpus AE1: disjoint edits both apply, no card', async () => {
  const r = await projectFresh([SEED, mkEdit('botA', 'agent', 'alpha', 'AAAAA'), mkEdit('botB', 'agent', 'delta', 'DDDDD')])
  expect(r.text).toBe('AAAAA bravo charlie DDDDD') // hand-authored: both disjoint replacements land
  expect(r.conflicts).toEqual([])
})

test('AOCM corpus AE2: owner interferes with agent → agent excluded, silently', async () => {
  const agent = mkEdit('botA', 'agent', 'bravo', 'AGENTV')
  const owner = mkEdit('owner1', 'owner', 'bravo', 'OWNERV')
  const r = await projectFresh([SEED, agent, owner])
  expect(r.text).toBe('alpha OWNERV charlie delta') // owner wins
  expect(r.text).not.toContain('AGENTV')
  expect(r.conflicts).toEqual([]) // authority decided → NO conflict surfaced
})

test('AOCM corpus AE3: same-region equal-role → first-class conflict (deterministic winner)', async () => {
  const a = mkEdit('botA', 'agent', 'charlie', 'AAA')
  const b = mkEdit('botB', 'agent', 'charlie', 'BBB')
  const r = await projectFresh([SEED, a, b])
  expect(r.conflicts.length).toBe(1)
  expect(r.conflicts[0]!.branches).toEqual([a.hash, b.hash].sort())
  // Live text is exactly one branch (lower hash sorts first in the total order).
  const winner = a.hash < b.hash ? 'AAA' : 'BBB'
  const loser = a.hash < b.hash ? 'BBB' : 'AAA'
  expect(r.text).toBe(`alpha bravo ${winner} delta`)
  expect(r.text).not.toContain(loser)
})

test('AOCM corpus AE5: three concurrent equal-role siblings → identical resolution on every replica', async () => {
  const a = mkEdit('botA', 'agent', 'charlie', 'AAA')
  const b = mkEdit('botB', 'agent', 'charlie', 'BBB')
  const c = mkEdit('botC', 'agent', 'charlie', 'CCC')
  const ops = [SEED, a, b, c]
  // Lowest-hash sibling is the deterministic winner; the others conflict against it.
  const sorted = [a, b, c].sort((x, y) => (x.hash < y.hash ? -1 : 1))
  const winnerMarker = sorted[0]!.patch.kind === 'versionable' ? (sorted[0]!.patch.intent as VersionableIntent & { newString: string }).newString : ''
  const r1 = await projectFresh(ops)
  const r2 = await projectFresh([c, a, SEED, b]) // separate store, different order
  expect(r1.text).toBe(`alpha bravo ${winnerMarker} delta`)
  expect(r2.text).toBe(r1.text)
  expect(r2.conflicts).toEqual(r1.conflicts)
  expect(r1.conflicts.length).toBe(2) // b-vs-winner and c-vs-winner (whichever sort lower stays)
})

test('AOCM corpus AE7: Write vs Edit interfere; equal-role conflicts, owner-write dominates', async () => {
  // Whole-file write spans every region → always interferes with a concurrent edit.
  const edit = mkEdit('botA', 'agent', 'bravo', 'EDITED')
  const write = mkWrite('botB', 'agent', 'totally new')
  const equal = await projectFresh([SEED, edit, write])
  expect(equal.conflicts.length).toBe(1) // equal role → surfaced
  const writeWins = write.hash < edit.hash
  expect(equal.text).toBe(writeWins ? 'totally new' : 'alpha EDITED charlie delta')

  // Same edit, but the WRITE is the owner → authority resolves silently to the write.
  const ownerWrite = mkWrite('owner1', 'owner', 'owner rewrite')
  const dom = await projectFresh([SEED, edit, ownerWrite])
  expect(dom.text).toBe('owner rewrite')
  expect(dom.conflicts).toEqual([])
})

test('AOCM corpus AE4/AE6: owner resolution dominates + notifies, peer re-derives identical state', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  const ledger = new Ledger(store)
  await store.append(SEED)
  const a = mkEdit('botA', 'agent', 'charlie', 'AAA')
  const b = mkEdit('botB', 'agent', 'charlie', 'BBB')
  await store.append(a)
  await store.append(b)
  const proj = () => projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  expect(proj().conflicts.length).toBe(1)

  // Owner keeps A.
  await resolveConflict(store, ledger, { ownerId: 'owner1', channel: 'chan', branchHashes: [a.hash, b.hash], chosenHash: a.hash })
  const resolved = proj()
  expect(resolved.conflicts).toEqual([]) // AE4: derived conflict cleared
  expect(resolved.text).toBe('alpha bravo AAA delta')
  // AE6: the loser's inbox carries the supersession note (dm-on-supersede matches it).
  const inbox = await store.listByArtifact(inboxArtifact('botB'))
  expect(inbox.some(n => n.actor === 'system:merge-gate')).toBe(true)

  // A peer replica fed the SAME op-set (incl. the resolution) re-derives the same text.
  const all = await store.listByArtifact(artifactId)
  const peer = await projectFresh(all)
  expect(peer.text).toBe(resolved.text)
  expect(peer.conflicts).toEqual(resolved.conflicts)
  engine.close()
  store.close()
})

// ─── 2. Skew fuzz: separate stores, shuffled delivery, convergence oracle ────────

function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

type Scenario = { cat: 'disjoint' | 'diff-role' | 'equal-role'; ops: Interaction[]; authorityWins?: string; authorityLoses?: string }

test('AOCM fuzz: K replicas over separate stores converge under shuffled delivery (all categories)', async () => {
  const scenarios: Scenario[] = [
    { cat: 'disjoint', ops: [SEED, mkEdit('botA', 'agent', 'alpha', 'AAAAA'), mkEdit('botB', 'agent', 'delta', 'DDDDD')] },
    {
      cat: 'diff-role',
      ops: [SEED, mkEdit('botA', 'agent', 'bravo', 'AGENTV'), mkEdit('owner1', 'owner', 'bravo', 'OWNERV')],
      authorityWins: 'OWNERV',
      authorityLoses: 'AGENTV',
    },
    { cat: 'equal-role', ops: [SEED, mkEdit('botA', 'agent', 'charlie', 'AAA'), mkEdit('botB', 'agent', 'charlie', 'BBB')] },
  ]
  const seenCats = new Set<string>()
  const K = 4 // replicas

  for (const sc of scenarios) {
    seenCats.add(sc.cat)
    const baseline = await projectFresh(sc.ops)
    const rnd = mulberry32(0xc0ffee ^ sc.cat.length)
    for (let replica = 0; replica < K; replica++) {
      const order = shuffle(sc.ops, rnd) // each replica gets a different delivery order
      const r = await projectFresh(order)
      expect(r.text).toBe(baseline.text) // convergence: identical projected text
      expect(r.conflicts).toEqual(baseline.conflicts) // identical derived conflicts
    }
    if (sc.authorityWins) {
      // Hand-authored invariant: the higher-role edit's text wins, the lower-role's vanishes, silently.
      expect(baseline.text).toContain(sc.authorityWins)
      expect(baseline.text).not.toContain(sc.authorityLoses!)
      expect(baseline.conflicts).toEqual([])
    }
  }

  // Coverage gate: all three interference categories must be exercised. A trivial
  // low-overlap generator (only disjoint) fails this assertion.
  expect([...seenCats].sort()).toEqual(['diff-role', 'disjoint', 'equal-role'])
})

// ─── 3. Teeth: a role-BLIND projector must disagree with the authority outcome ───

/** INTENTIONALLY WRONG reference projector: identical greedy exclusion but the
 *  total order ignores ROLE (hash only) and treats every interfering pair as an
 *  equal-role conflict. It is scoped to the flat corpus shape (seed + concurrent
 *  children). If AOCM's authority outcome matched this, the merge would be broken
 *  — so the corpus must DISAGREE with it on the different-role case. */
function projectRoleBlind(ops: Interaction[], base: string): { conflicts: ConflictRegion[] } {
  const intentOf = (e: Interaction): VersionableIntent =>
    e.patch.kind === 'versionable' && e.patch.intent ? e.patch.intent : { kind: 'write', content: '' }
  const ordered = ops.slice().sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const kept: Interaction[] = []
  const conflicts: ConflictRegion[] = []
  for (const x of ordered) {
    let dom: Interaction | undefined
    for (const y of kept) {
      const concurrent = !x.caused_by.includes(y.hash) && !y.caused_by.includes(x.hash)
      if (concurrent && interferes(intentOf(y), intentOf(x), base)) {
        dom = y
        break
      }
    }
    if (!dom) kept.push(x)
    else conflicts.push({ branches: [dom.hash, x.hash].sort() }) // role ignored → always "conflict"
  }
  return { conflicts }
}

test('AOCM teeth: role-blind exclusion disagrees with authority outcome (corpus has bite)', async () => {
  const agent = mkEdit('botA', 'agent', 'bravo', 'AGENTV')
  const owner = mkEdit('owner1', 'owner', 'bravo', 'OWNERV')
  const ops = [SEED, agent, owner]

  // The two edits genuinely interfere (same word region) — so role is the ONLY thing
  // that can make AOCM resolve silently here.
  expect(interferes(
    { kind: 'edit', oldString: 'bravo', newString: 'AGENTV' },
    { kind: 'edit', oldString: 'bravo', newString: 'OWNERV' },
    BASE,
  )).toBe(true)

  const correct = await projectFresh(ops)
  const broken = projectRoleBlind(ops, BASE)

  // Authority resolves with NO conflict; the role-blind reference WRONGLY surfaces one.
  expect(correct.conflicts).toEqual([])
  expect(broken.conflicts.length).toBe(1)
  expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.agent) // the rank that does the work
})
