/**
 * conflict-card (§4.2): two equal-role drafts at one anchor produce one card
 * with both branches.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { conflictCard, type ConflictCardPost } from './conflict-card.ts'
import type { ProposedInteraction } from '../interaction.ts'

const ART = 'know:actor/shared/notes'

function draft(actor: string, body: string): ProposedInteraction {
  return {
    actor,
    role: 'agent', // equal roles → conflict
    channel: 'chan-A',
    target: { artifactId: ART, anchor: { kind: 'key', path: 'title' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: `${actor}-1`, body } },
    effect: 'pure',
    caused_by: [],
  }
}

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

test('conflict-card: holds two equal-role drafts and posts one card', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const cards: ConflictCardPost[] = []
  sync.register(
    conflictCard({
      getOwnerForChannel: id => (id === 'chan-A' ? 'u-alice' : undefined),
      postCard: async p => {
        cards.push(p)
      },
    }),
  )
  sync.start()

  const a = await admit(store, draft('bob-bot', 'supports 8 levels'))
  expect(a.kind).toBe('admitted')
  const b = await admit(store, draft('charlie-bot', 'limit is 8 levels'))
  expect(b.kind).toBe('conflict')
  await settle()

  expect(cards).toHaveLength(1)
  const card = cards[0]!
  expect(card.channelId).toBe('chan-A')
  expect(card.ownerId).toBe('u-alice')
  expect(card.branchHashes).toHaveLength(2)
  expect(card.text).toContain('Two drafts arrived together')
  expect(card.text).toContain('@bob-bot')
  expect(card.text).toContain('@charlie-bot')
  expect(card.text).toContain('notes §title')
  // Branch hash order matches the lettered branches (sorted by hash).
  expect(card.branchHashes).toEqual([...card.branchHashes].sort())
  sync.stop()
  engine.close()
  store.close()
})

test('conflict-card: ignores anchored non-conflicts (single draft)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const cards: ConflictCardPost[] = []
  sync.register(
    conflictCard({ getOwnerForChannel: () => 'u', postCard: async p => void cards.push(p) }),
  )
  sync.start()
  await admit(store, draft('solo-bot', 'only draft'))
  await settle()
  expect(cards).toEqual([])
  sync.stop()
  engine.close()
  store.close()
})
