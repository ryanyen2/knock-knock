/**
 * Knowledge artifact: append + invalidate + tombstone-cascade staleness.
 *
 * The cascade is the load-bearing property: invalidating an upstream note
 * MUST mark every transitively-downstream note stale, so the agent's
 * "what do I know" projection naturally drops superseded conclusions.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import {
  KNOWLEDGE_FOLD,
  knowledgeFold,
  activeNotes,
  annotateWithStaleness,
  type KnowledgeFoldState,
} from './knowledge.ts'
import type { ProposedInteraction } from '../interaction.ts'

const ARTIFACT = 'know:agent/bot1/notes'

function note(id: string, body: string, parents: string[] = []): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id, body } },
    effect: 'pure',
    caused_by: parents,
  }
}

function invalidate(targetHash: string, actor = 'owner1', role: 'owner' | 'agent' = 'owner'): ProposedInteraction {
  return {
    actor,
    role,
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.invalidate',
    patch: { kind: 'knowledge', invalidate: { hash: targetHash } },
    effect: 'pure',
    caused_by: [targetHash],
  }
}

async function setupEngine() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold)
  return { store, engine }
}

test('knowledge: append + activeNotes returns the note', async () => {
  const { store, engine } = await setupEngine()
  await admit(store, note('n1', 'first note'))
  const notes = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.note.body).toBe('first note')
  engine.close()
  store.close()
})

test('knowledge: invalidate tombstones the target — activeNotes filters it out', async () => {
  const { store, engine } = await setupEngine()
  const a = await admit(store, note('n1', 'evidence'))
  expect(a.kind).toBe('admitted')
  await admit(store, invalidate(a.interaction.hash))

  const notes = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(notes).toHaveLength(0)

  const annotated = annotateWithStaleness(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(annotated).toHaveLength(1)
  expect(annotated[0]!.stale).toBe(true)
  engine.close()
  store.close()
})

test('knowledge: tombstone cascades down caused_by — descendants become stale', async () => {
  const { store, engine } = await setupEngine()
  // Chain: n1 → n2 → n3 (n2 caused_by n1, n3 caused_by n2)
  const n1 = await admit(store, note('n1', 'root evidence'))
  expect(n1.kind).toBe('admitted')
  const n2 = await admit(store, note('n2', 'derived from n1', [n1.interaction.hash]))
  expect(n2.kind).toBe('admitted')
  const n3 = await admit(store, note('n3', 'derived from n2', [n2.interaction.hash]))
  expect(n3.kind).toBe('admitted')

  // Invalidate the root.
  await admit(store, invalidate(n1.interaction.hash))

  // ALL three should be stale — the tombstone cascades.
  const annotated = annotateWithStaleness(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(annotated).toHaveLength(3)
  expect(annotated.every(a => a.stale)).toBe(true)

  // activeNotes returns nothing — every chain reaches the tombstone.
  expect(activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)).toEqual([])
  engine.close()
  store.close()
})

test('knowledge: sibling not caused-by a tombstoned note stays active', async () => {
  const { store, engine } = await setupEngine()
  const a = await admit(store, note('a', 'A'))
  const b = await admit(store, note('b', 'B (independent)'))
  expect(b.kind).toBe('admitted')
  await admit(store, invalidate(a.interaction.hash))

  const active = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(active.map(n => n.note.id)).toEqual(['b'])
  engine.close()
  store.close()
})

test('knowledge: invalidate is idempotent (multiple invalidations of the same note)', async () => {
  const { store, engine } = await setupEngine()
  const a = await admit(store, note('a', 'A'))
  await admit(store, invalidate(a.interaction.hash))
  await admit(store, invalidate(a.interaction.hash)) // same — dedups by hash
  const active = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(active).toEqual([])
  engine.close()
  store.close()
})

test('knowledge: notes are ordered by createdAt (stable for the renderer)', async () => {
  const { store, engine } = await setupEngine()
  const n1 = await admit(store, note('n1', 'first'))
  // Force a measurable ts gap so the sort key actually differs.
  await new Promise(r => setTimeout(r, 5))
  const n2 = await admit(store, note('n2', 'second', [n1.interaction.hash]))
  await new Promise(r => setTimeout(r, 5))
  await admit(store, note('n3', 'third', [n2.interaction.hash]))
  const active = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(active.map(n => n.note.id)).toEqual(['n1', 'n2', 'n3'])
  engine.close()
  store.close()
})
