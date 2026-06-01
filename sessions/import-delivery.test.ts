/**
 * Session import → delivery, at the ledger level.
 *
 * The import path admits an owner-role knowledge.append to
 * know:channel/<id>/shared-context; the knowledge fold must surface it as an
 * active note, and pickFreshContext must deliver its body once and never again.
 * This is exactly what AgentHost.handleSessionPick + pendingSharedContext do,
 * minus the Discord client.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../ledger/store-sqlite.ts'
import { FoldEngine } from '../ledger/fold.ts'
import { admit } from '../ledger/admit.ts'
import {
  KNOWLEDGE_FOLD,
  knowledgeFold,
  activeNotes,
  type KnowledgeFoldState,
} from '../ledger/artifacts/knowledge.ts'
import { wrapSharedContext, pickFreshContext } from '../lib.ts'
import type { ProposedInteraction } from '../ledger/interaction.ts'

const CHANNEL = 'chan-X'
const ARTIFACT = `know:channel/${CHANNEL}/shared-context`

function importNote(id: string, body: string): ProposedInteraction {
  return {
    actor: 'owner-1',
    role: 'owner',
    channel: CHANNEL,
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id, body, tags: ['session-import', 'claude-code'] } },
    effect: 'pure',
    caused_by: [],
  }
}

async function harness() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold)
  return { store, engine }
}

test('imported shared-context becomes an active note (anchor:none → no conflict)', async () => {
  const { store, engine } = await harness()
  const body = wrapSharedContext({ source: 'claude-code:abc', cwd: '/ws' }, '## Plan\nDo X')
  const res = await admit(store, importNote('n1', body))
  expect(res.kind).toBe('admitted') // never held as a conflict

  const notes = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.note.body).toContain('<shared-context')
  expect(notes[0]!.note.body).toContain('Do X')
})

test('pickFreshContext delivers each note once', async () => {
  const { store, engine } = await harness()
  await admit(store, importNote('n1', wrapSharedContext({ source: 'claude-code:abc' }, 'first brief')))

  const state = engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
  const toPairs = () =>
    activeNotes(state, ARTIFACT).map(n => ({ hash: n.hash, body: n.note.body }))

  const delivered = new Set<string>()
  const first = pickFreshContext(toPairs(), delivered)
  expect(first.prefix).toContain('first brief')
  for (const h of first.freshHashes) delivered.add(h)

  // Same fold state, already delivered → nothing to inject.
  const again = pickFreshContext(toPairs(), delivered)
  expect(again.prefix).toBeUndefined()
})

test('a second import after delivery is itself delivered once', async () => {
  const { store, engine } = await harness()
  await admit(store, importNote('n1', wrapSharedContext({ source: 'a' }, 'brief one')))

  const delivered = new Set<string>()
  const pairs1 = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT).map(n => ({ hash: n.hash, body: n.note.body }))
  for (const h of pickFreshContext(pairs1, delivered).freshHashes) delivered.add(h)

  // A new import lands; only the new note is fresh.
  await admit(store, importNote('n2', wrapSharedContext({ source: 'b' }, 'brief two')))
  const pairs2 = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT).map(n => ({ hash: n.hash, body: n.note.body }))
  const second = pickFreshContext(pairs2, delivered)
  expect(second.prefix).toContain('brief two')
  expect(second.prefix).not.toContain('brief one')
})
