/**
 * write-back-versionable: on an admitted workspace.edit, project the merged text
 * and write it to disk under a per-file claim, content-compared so a no-op edit
 * doesn't churn the file.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import type { ProposedInteraction } from '../interaction.ts'
import { writeBackVersionable } from './write-back-versionable.ts'
import { versionableFold, versionableArtifactId, WHOLE_FILE_ANCHOR, mutateAndEncode } from '../artifacts/versionable.ts'

const CH = 'scope-1'

function editProposal(doc: Y.Doc, newText: string, rel: string, parents: string[]): ProposedInteraction {
  const ops = mutateAndEncode(doc, t => {
    t.delete(0, t.length)
    t.insert(0, newText)
  })
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CH,
    target: { artifactId: versionableArtifactId(CH, rel), anchor: WHOLE_FILE_ANCHOR },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops },
    effect: 'workspace',
    caused_by: parents,
  }
}

async function setup() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)

  const files = new Map<string, string>()
  let writes = 0
  const sync = writeBackVersionable({
    resolvePath: artifactId => `/abs/${artifactId}`,
    readFile: async absPath => files.get(absPath),
    writeFile: async (absPath, content) => {
      writes++
      files.set(absPath, content)
    },
  })
  const ctx = { store, engine, admit: (p: ProposedInteraction) => admit(store, p) }
  return { store, engine, files, sync, ctx, writes: () => writes }
}

test('write-back: projects and writes the merged text for the edited file', async () => {
  const { store, sync, ctx, files } = await setup()
  const rel = 'a.ts'
  const r = await admit(store, editProposal(new Y.Doc(), 'hello\n', rel, []))
  await sync.fire(r.interaction, ctx)
  expect(files.get(`/abs/${versionableArtifactId(CH, rel)}`)).toBe('hello\n')
})

test('write-back: content-compare skips a redundant write', async () => {
  const { store, sync, ctx, writes } = await setup()
  const rel = 'a.ts'
  const r = await admit(store, editProposal(new Y.Doc(), 'hello\n', rel, []))
  await sync.fire(r.interaction, ctx)
  await sync.fire(r.interaction, ctx) // same projected text → no second write
  expect(writes()).toBe(1)
})

test('write-back: unserved scope (no path) is a no-op', async () => {
  const { store, ctx, writes } = await setup()
  // a write-back whose resolvePath returns undefined never writes
  const sync = writeBackVersionable({
    resolvePath: () => undefined,
    readFile: async () => undefined,
    writeFile: async () => {
      throw new Error('should not write')
    },
  })
  const r = await admit(store, editProposal(new Y.Doc(), 'x', 'b.ts', []))
  await sync.fire(r.interaction, ctx)
  expect(writes()).toBe(0)
})
