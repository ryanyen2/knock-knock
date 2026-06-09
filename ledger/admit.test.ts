/**
 * Admission gate end-to-end: the merge function + supersession surfacing +
 * conflict holding all running through admit() against a real store.
 *
 * The rubric-defining test is "owner overrides agent — loser gets an inbox
 * note": that's how the social hierarchy stays non-destructive (rubric #4).
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { FoldEngine } from './fold.ts'
import { admit, inboxArtifact } from './admit.ts'
import {
  KNOWLEDGE_FOLD,
  knowledgeFold,
  activeNotes,
  type KnowledgeFoldState,
} from './artifacts/knowledge.ts'
import type { ProposedInteraction } from './interaction.ts'

const ARTIFACT = 'know:scratch/conflicts'

function knowledgePatch(
  actor: string,
  role: 'owner' | 'human' | 'agent',
  body: string,
  parents: string[] = [],
): ProposedInteraction {
  return {
    actor,
    role,
    channel: 'chan',
    target: {
      artifactId: ARTIFACT,
      // Use a key anchor so both writers target the same slot.
      anchor: { kind: 'key', path: 'finding' },
    },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: `note-${actor}`, body } },
    effect: 'pure',
    caused_by: parents,
  }
}

async function setupEngine() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold)
  return { store, engine }
}

test('admit: no concurrent peers → admitted, lifecycle=applied', async () => {
  const { store, engine } = await setupEngine()
  const r = await admit(store, knowledgePatch('bot1', 'agent', 'first'))
  expect(r.kind).toBe('admitted')
  expect(r.interaction.lifecycle).toBe('applied')
  expect((r as { superseded: string[] }).superseded).toEqual([])
  engine.close()
  store.close()
})

test('admit: owner overrides agent — agent superseded + receives inbox note', async () => {
  const { store, engine } = await setupEngine()
  // Agent proposes first.
  const agentResult = await admit(store, knowledgePatch('bot1', 'agent', 'my finding'))
  expect(agentResult.kind).toBe('admitted')

  // Owner proposes a competing patch at the same anchor (no caused_by → concurrent).
  const ownerResult = await admit(store, knowledgePatch('owner1', 'owner', 'actually no'))
  expect(ownerResult.kind).toBe('admitted')
  expect((ownerResult as { superseded: string[] }).superseded).toEqual([
    agentResult.interaction.hash,
  ])

  // The agent's interaction is now lifecycle: superseded.
  const agentBack = await store.getByHash(agentResult.interaction.hash)
  expect(agentBack?.lifecycle).toBe('superseded')

  // The agent's inbox got a system note explaining what happened.
  const inbox = activeNotes(
    engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD),
    inboxArtifact('bot1'),
  )
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.note.body).toContain('superseded')
  expect(inbox[0]!.note.tags).toContain('merge')
  engine.close()
  store.close()
})

test('admit: a superseded loser leaves the LIVE knowledge fold immediately (== fresh replay)', async () => {
  const { store, engine } = await setupEngine()
  await admit(store, knowledgePatch('bot1', 'agent', 'my finding'))
  await admit(store, knowledgePatch('owner1', 'owner', 'actually no'))

  // The artifact's live active notes show only the owner's note — the agent's
  // superseded note left the live fold without a restart (the live-stale fix).
  const live = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(live.map(n => n.note.body)).toEqual(['actually no'])

  // Reconstructability: a fresh engine bootstrapped from the same store agrees.
  const fresh = new FoldEngine(store)
  await fresh.register(knowledgeFold)
  const replay = activeNotes(fresh.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(replay.map(n => n.note.body)).toEqual(['actually no'])

  fresh.close()
  engine.close()
  store.close()
})

test('admit: lower-role proposal AFTER owner is rejected with reason', async () => {
  const { store, engine } = await setupEngine()
  const owner = await admit(store, knowledgePatch('owner1', 'owner', 'truth'))
  expect(owner.kind).toBe('admitted')

  const agent = await admit(store, knowledgePatch('bot1', 'agent', 'no, my version'))
  expect(agent.kind).toBe('denied')
  expect((agent as { reason: string }).reason).toBe('lower-role')

  // Rejection ALSO surfaces back to the loser's inbox (different copy than
  // supersede, same mechanism).
  const inbox = activeNotes(
    engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD),
    inboxArtifact('bot1'),
  )
  expect(inbox.length).toBeGreaterThanOrEqual(1)
  expect(inbox.some(n => n.note.body.includes('rejected'))).toBe(true)
  engine.close()
  store.close()
})

test('admit: two equal-role concurrent peers produce a conflict — both held', async () => {
  const { store, engine } = await setupEngine()
  const a = await admit(store, knowledgePatch('botA', 'agent', 'view A'))
  expect(a.kind).toBe('admitted')

  const b = await admit(store, knowledgePatch('botB', 'agent', 'view B'))
  expect(b.kind).toBe('conflict')
  expect(new Set((b as { branches: string[] }).branches)).toEqual(
    new Set([a.interaction.hash, b.interaction.hash]),
  )

  // The conflict interaction stays lifecycle: proposed (NOT applied), so the
  // knowledge fold doesn't surface it as an active note.
  const conflicted = await store.getByHash(b.interaction.hash)
  expect(conflicted?.lifecycle).toBe('proposed')

  // Only A is admitted; the active-notes view shows only A.
  const active = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(active).toHaveLength(1)
  expect(active[0]!.note.body).toBe('view A')
  engine.close()
  store.close()
})

test('admit: anchor=none never conflicts even with many concurrent peers', async () => {
  const { store, engine } = await setupEngine()
  // Simulate channel messages — anchor: none — same channel, no caused_by.
  // Several owners post "concurrently"; none should ever supersede or conflict.
  for (let n = 0; n < 5; n++) {
    const r = await admit(store, {
      actor: `user-${n}`,
      role: 'owner',
      channel: 'chan',
      target: { artifactId: 'extp:discord/chan', anchor: { kind: 'none' } },
      verb: 'channel.message',
      patch: {
        kind: 'external',
        intent: { channel: 'discord', op: 'received', args: { text: `m${n}`, messageId: `m${n}` } },
      },
      effect: 'external',
      caused_by: [],
    })
    expect(r.kind).toBe('admitted')
    expect((r as { superseded: string[] }).superseded).toEqual([])
  }
  engine.close()
  store.close()
})

test('admit: idempotent on duplicate content — same hash → same outcome', async () => {
  const { store, engine } = await setupEngine()
  const first = await admit(store, knowledgePatch('bot1', 'agent', 'same'))
  const second = await admit(store, knowledgePatch('bot1', 'agent', 'same'))
  expect(first.interaction.hash).toBe(second.interaction.hash)
  expect(second.kind).toBe('admitted')
  engine.close()
  store.close()
})

test('admit: an ancestor patch is NOT considered concurrent (no false conflict)', async () => {
  const { store, engine } = await setupEngine()
  const a = await admit(store, knowledgePatch('bot1', 'agent', 'A'))
  expect(a.kind).toBe('admitted')
  // B explicitly causes on A — it's a successor, not a concurrent peer.
  const b = await admit(
    store,
    knowledgePatch('bot1', 'agent', 'B replaces A', [a.interaction.hash]),
  )
  expect(b.kind).toBe('admitted')
  expect((b as { superseded: string[] }).superseded).toEqual([])
  engine.close()
  store.close()
})
