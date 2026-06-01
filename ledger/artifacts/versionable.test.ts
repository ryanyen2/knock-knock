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
} from './versionable.ts'
import { hashInteraction } from '../canonical.ts'
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
