/**
 * File-edit sync (walking skeleton): an Edit/Write tool run becomes a
 * `workspace.edit`, the versionable fold projects the merged text, and two
 * "machines" sharing one store converge to byte-identical text — the same
 * two-engines-on-one-store mirror used by cross-machine.test.ts.
 *
 * Asserted:
 *   1. parseEditIntent / applyEditIntent / id helpers (pure).
 *   2. The capture sync turns tool.requested(Write) + tool.executed into a
 *      workspace.edit, and the fold projects the written content.
 *   3. Sequential edits converge to the latest text on BOTH engines.
 *   4. Two equal-role concurrent edits are HELD (proposed), so the projection
 *      stays at the prior text on both engines and the conflict branches match.
 */

import { test, expect } from 'bun:test'
import * as Y from 'yjs'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import { hashInteraction } from '../canonical.ts'
import type { Interaction, ProposedInteraction } from '../interaction.ts'
import { captureWorkspaceEdit } from './capture-workspace-edit.ts'
import {
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  versionableFold,
  versionableArtifactId,
  parseVersionableId,
  parseEditIntent,
  applyEditIntent,
  projectVersionable,
  mutateAndEncode,
  type VersionableFoldState,
} from '../artifacts/versionable.ts'

const CH = 'scope-1'

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('parseEditIntent: Write → whole-content intent', () => {
  expect(parseEditIntent('Write', { file_path: '/ws/a.ts', content: 'hi' })).toEqual({
    kind: 'write',
    filePath: '/ws/a.ts',
    content: 'hi',
  })
})

test('parseEditIntent: Edit → old/new replacement intent', () => {
  expect(parseEditIntent('Edit', { file_path: '/ws/a.ts', old_string: 'a', new_string: 'b' })).toEqual({
    kind: 'edit',
    filePath: '/ws/a.ts',
    oldString: 'a',
    newString: 'b',
  })
})

test('parseEditIntent: non-edit tools and missing fields → undefined', () => {
  expect(parseEditIntent('Bash', { command: 'ls' })).toBeUndefined()
  expect(parseEditIntent('Write', { file_path: '/ws/a.ts' })).toBeUndefined()
})

test('applyEditIntent: write replaces; edit swaps first occurrence; absent old is a no-op', () => {
  expect(applyEditIntent('old', { kind: 'write', filePath: 'x', content: 'new' })).toBe('new')
  expect(applyEditIntent('a b a', { kind: 'edit', filePath: 'x', oldString: 'a', newString: 'Z' })).toBe('Z b a')
  expect(applyEditIntent('abc', { kind: 'edit', filePath: 'x', oldString: 'zzz', newString: 'Z' })).toBe('abc')
})

test('versionable id round-trips; rejects malformed', () => {
  expect(versionableArtifactId('scope-1', 'src/foo.ts')).toBe('vers:scope-1/src/foo.ts')
  expect(parseVersionableId('vers:scope-1/src/foo.ts')).toEqual({ scope: 'scope-1', relPath: 'src/foo.ts' })
  expect(parseVersionableId('know:scope/x')).toBeUndefined()
  expect(parseVersionableId('vers:scope-1/')).toBeUndefined()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function appendApplied(store: SqliteStore, p: ProposedInteraction): Promise<Interaction> {
  const i: Interaction = { ...p, hash: hashInteraction(p), lifecycle: 'applied', createdAt: new Date().toISOString() }
  await store.append(i)
  return i
}

function toolReq(op: string, args: unknown): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CH,
    target: { artifactId: 'extp:tool/c1', anchor: { kind: 'proxy', proxyId: 'c1' } },
    verb: 'tool.requested',
    patch: { kind: 'external', intent: { channel: 'tool', op, args } },
    effect: 'external',
    caused_by: [],
  }
}

function toolExec(parent: string): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CH,
    target: { artifactId: 'extp:tool/c1', anchor: { kind: 'proxy', proxyId: 'c1' } },
    verb: 'tool.executed',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'result', args: {} }, result: { ok: true, ref: 'c1' } },
    effect: 'external',
    caused_by: [parent],
  }
}

/** Build a whole-file workspace.edit proposal against a (shared, live) doc, the
 *  same way the capture sync does. */
function editProposal(doc: Y.Doc, newText: string, relPath: string, parents: string[]): ProposedInteraction {
  const ops = mutateAndEncode(doc, t => {
    t.delete(0, t.length)
    t.insert(0, newText)
  })
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CH,
    target: { artifactId: versionableArtifactId(CH, relPath), anchor: WHOLE_FILE_ANCHOR },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops },
    effect: 'workspace',
    caused_by: parents,
  }
}

// ─── Capture sync integration ─────────────────────────────────────────────────

test('capture sync: Write tool run → workspace.edit; fold projects the content', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)

  const sync = captureWorkspaceEdit({
    relativize: (_scope, abs) => (abs.startsWith('/ws/') ? abs.slice('/ws/'.length) : undefined),
  })
  const ctx = { store, engine, admit: (p: ProposedInteraction) => admit(store, p) }

  const req = await appendApplied(store, toolReq('Write', { file_path: '/ws/foo.ts', content: 'hello world' }))
  const exec = await appendApplied(store, toolExec(req.hash))
  await sync.fire(exec, ctx)

  const aid = versionableArtifactId(CH, 'foo.ts')
  const edits = (await store.listByArtifact(aid)).filter(e => e.verb === 'workspace.edit')
  expect(edits).toHaveLength(1)
  expect(projectVersionable(engine.get<VersionableFoldState>(VERSIONABLE_FOLD), aid).text).toBe('hello world')
})

test('capture sync: an edit outside the workspace is ignored', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(versionableFold)
  const sync = captureWorkspaceEdit({ relativize: () => undefined }) // nothing is in-workspace
  const ctx = { store, engine, admit: (p: ProposedInteraction) => admit(store, p) }

  const req = await appendApplied(store, toolReq('Write', { file_path: '/etc/passwd', content: 'x' }))
  const exec = await appendApplied(store, toolExec(req.hash))
  await sync.fire(exec, ctx)

  expect((await store.listByVerb('workspace.edit')).length).toBe(0)
})

// ─── Two-engine convergence ───────────────────────────────────────────────────

test('sequential edits converge to the latest text on both engines', async () => {
  const store = new SqliteStore(':memory:')
  const eA = new FoldEngine(store)
  const eB = new FoldEngine(store)
  await eA.register(versionableFold)
  await eB.register(versionableFold)

  const doc = new Y.Doc()
  const rel = 'a.ts'
  const e1 = await admit(store, editProposal(doc, 'line one\n', rel, []))
  const e2 = await admit(store, editProposal(doc, 'line one\nline two\n', rel, [e1.interaction.hash]))
  expect(e2.kind).toBe('admitted') // chained, not a conflict

  const aid = versionableArtifactId(CH, rel)
  const textA = projectVersionable(eA.get<VersionableFoldState>(VERSIONABLE_FOLD), aid).text
  const textB = projectVersionable(eB.get<VersionableFoldState>(VERSIONABLE_FOLD), aid).text
  expect(textA).toBe('line one\nline two\n')
  expect(textB).toBe(textA) // byte-identical across machines
})

test('two equal-role concurrent edits are held; projection stays at base on both engines', async () => {
  const store = new SqliteStore(':memory:')
  const eA = new FoldEngine(store)
  const eB = new FoldEngine(store)
  await eA.register(versionableFold)
  await eB.register(versionableFold)

  const rel = 'b.ts'
  const aid = versionableArtifactId(CH, rel)

  // A committed base edit, then two agents both edit from that same base.
  const base = new Y.Doc()
  const seed = await admit(store, editProposal(base, 'base\n', rel, []))
  expect(seed.kind).toBe('admitted')

  const docX = new Y.Doc()
  Y.applyUpdate(docX, Buffer.from((seed.interaction.patch as { ops: string }).ops, 'base64'))
  const docY = new Y.Doc()
  Y.applyUpdate(docY, Buffer.from((seed.interaction.patch as { ops: string }).ops, 'base64'))

  const rX = await admit(store, editProposal(docX, 'base\nfrom X\n', rel, [seed.interaction.hash]))
  const rY = await admit(store, editProposal(docY, 'base\nfrom Y\n', rel, [seed.interaction.hash]))

  // First lands; the second is a held equal-role conflict.
  expect(rX.kind).toBe('admitted')
  expect(rY.kind).toBe('conflict')
  if (rY.kind === 'conflict') {
    // Deterministic branch set across machines (lower-hash sort).
    expect([...rY.branches].sort()).toEqual(rY.branches)
  }

  // The held edit (proposed) is excluded from the fold, so both engines project
  // the same text — only the applied edits (seed + the winner) fold in.
  const textA = projectVersionable(eA.get<VersionableFoldState>(VERSIONABLE_FOLD), aid).text
  const textB = projectVersionable(eB.get<VersionableFoldState>(VERSIONABLE_FOLD), aid).text
  expect(textB).toBe(textA)
})
