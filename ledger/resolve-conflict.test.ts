/**
 * resolveConflict — the headless conflict-resolution core. Records the owner's
 * merge.resolve, flips lifecycles, and surfaces the drop to each loser's inbox,
 * independent of Discord. Two equal-role concurrent notes create the conflict;
 * resolving picks one and supersedes the rest.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { Ledger } from './capture.ts'
import { admit } from './admit.ts'
import { resolveConflict } from './resolve-conflict.ts'
import { FoldEngine } from './fold.ts'
import {
  KNOWLEDGE_FOLD,
  knowledgeFold,
  activeNotes,
  type KnowledgeFoldState,
} from './artifacts/knowledge.ts'
import type { ProposedInteraction } from './interaction.ts'

const CH = 'chan-1'
const ART = 'know:scope/doc'

function note(actor: string, id: string): ProposedInteraction {
  return {
    actor,
    role: 'agent',
    channel: CH,
    target: { artifactId: ART, anchor: { kind: 'key', path: 'title' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id, body: `body-${id}` } },
    effect: 'pure',
    caused_by: [],
  }
}

async function setupConflict() {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const r1 = await admit(store, note('botA', 'n1'))
  const r2 = await admit(store, note('botB', 'n2'))
  return { store, ledger, r1, r2 }
}

test('resolveConflict: chosen → applied, others → superseded, with a merge.resolve', async () => {
  const { store, ledger, r1, r2 } = await setupConflict()
  expect(r1.kind).toBe('admitted')
  expect(r2.kind).toBe('conflict')

  const branchHashes = [r1.interaction.hash, r2.interaction.hash]
  const result = await resolveConflict(store, ledger, {
    ownerId: 'owner1',
    channel: CH,
    branchHashes,
    chosenHash: r2.interaction.hash, // owner keeps the held branch
    label: 'took 🅱',
  })

  expect(result).toBeTruthy()
  expect(result!.losers).toEqual([r1.interaction.hash])

  expect((await store.getByHash(r2.interaction.hash))!.lifecycle).toBe('applied')
  expect((await store.getByHash(r1.interaction.hash))!.lifecycle).toBe('superseded')

  const resolve = await store.getByHash(result!.resolveHash)
  expect(resolve!.verb).toBe('merge.resolve')
  expect(resolve!.actor).toBe('owner1')
  expect(resolve!.supersedes).toEqual([r1.interaction.hash])
})

test('resolveConflict: surfaces the drop to the loser inbox (so dm-on-supersede fires)', async () => {
  const { store, ledger, r1, r2 } = await setupConflict()
  await resolveConflict(store, ledger, {
    ownerId: 'owner1',
    channel: CH,
    branchHashes: [r1.interaction.hash, r2.interaction.hash],
    chosenHash: r2.interaction.hash,
  })
  // botA lost → an inbox note authored by the merge gate.
  const inbox = await store.listByArtifact('know:actor/botA/inbox')
  const notes = inbox.filter(i => i.verb === 'knowledge.append' && i.actor === 'system:merge-gate')
  expect(notes.length).toBe(1)
})

test('resolveConflict: live knowledge fold shows only the chosen branch immediately (== fresh replay)', async () => {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold)

  const r1 = await admit(store, note('botA', 'n1')) // applied → in the live fold
  const r2 = await admit(store, note('botB', 'n2')) // conflict → proposed, not in the live fold
  expect(r1.kind).toBe('admitted')
  expect(r2.kind).toBe('conflict')

  await resolveConflict(store, ledger, {
    ownerId: 'owner1',
    channel: CH,
    branchHashes: [r1.interaction.hash, r2.interaction.hash],
    chosenHash: r2.interaction.hash, // keep the held branch
  })

  // Both directions fire: n2 enters the live fold (proposed→applied), n1 leaves
  // it (applied→superseded) — without a restart.
  const live = activeNotes(engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ART)
  expect(live.map(n => n.note.id)).toEqual(['n2'])

  const fresh = new FoldEngine(store)
  await fresh.register(knowledgeFold)
  const replay = activeNotes(fresh.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ART)
  expect(replay.map(n => n.note.id)).toEqual(['n2'])

  fresh.close()
  engine.close()
  store.close()
})

test('resolveConflict: an unknown chosen branch is a no-op', async () => {
  const { store, ledger, r1, r2 } = await setupConflict()
  const result = await resolveConflict(store, ledger, {
    ownerId: 'owner1',
    channel: CH,
    branchHashes: [r1.interaction.hash, r2.interaction.hash],
    chosenHash: 'deadbeef'.repeat(8),
  })
  expect(result).toBeUndefined()
})
