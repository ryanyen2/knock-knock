/**
 * resolveConflict under AOCM (U6).
 *
 * A versionable conflict is DERIVED (concurrent + interfering + equal-role edits);
 * resolving it admits an owner-role copy of the chosen branch that the total order
 * floats above both agents. The assertions: the derived conflict clears, the live
 * text is the chosen branch's text, and a supersession note lands in the loser's
 * inbox (so `dm-on-supersede` still fires) — all without a lifecycle UPDATE.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import { SqliteStore } from '../../ledger/store-sqlite.ts'
import { FoldEngine } from '../../ledger/fold.ts'
import { Ledger } from '../../ledger/capture.ts'
import { admit, inboxArtifact } from '../../ledger/admit.ts'
import { resolveConflict } from '../../ledger/resolve-conflict.ts'
import {
  mutateAndEncode,
  projectVersionable,
  versionableArtifactId,
  versionableFold,
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  type VersionableFoldState,
} from '../../ledger/artifacts/versionable.ts'

test('resolveConflict (U6): owner pick clears the derived conflict + notifies the loser', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  const ledger = new Ledger(store)
  const artifactId = versionableArtifactId('chan', 'foo.ts')

  // Seed "hello world".
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

  const mkOps = (mutate: (t: Y.Text) => void) => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(seedOps, 'base64'))
    const ops = mutateAndEncode(d, mutate)
    d.destroy()
    return ops
  }
  // Two equal-role agents both edit "hello" → same region → derived conflict.
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

  const proj = () => projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), artifactId)
  expect(proj().conflicts.length).toBe(1) // pre-resolution: one derived equal-role conflict

  // Owner keeps A. Resolution = an owner-role copy of A that dominates both branches.
  const result = await resolveConflict(store, ledger, {
    ownerId: 'owner1', channel: 'chan', branchHashes: [aHash, bHash], chosenHash: aHash, label: 'took 🅰',
  })
  expect(result).toBeDefined()
  expect(result!.losers).toEqual([bHash])

  const after = proj()
  expect(after.conflicts).toEqual([]) // derived conflict cleared (owner dominates both silently)
  expect(after.text).toContain('HI') // chosen branch's text is live
  expect(after.text).not.toContain('YO') // the dropped branch is excluded

  // The loser's inbox carries a supersession note (the surface-back dm-on-supersede matches).
  const inbox = await store.listByArtifact(inboxArtifact('botB'))
  expect(inbox.some(n => n.actor === 'system:merge-gate' && n.verb === 'knowledge.append')).toBe(true)

  engine.close()
  store.close()
})
