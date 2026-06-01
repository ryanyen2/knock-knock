/**
 * Versionable artifact — Yjs-backed CRDT for file/text patches.
 *
 * A versionable artifact (`vers:<scope>/<key>`) is a Y.Doc whose state is
 * computed by applying every admitted `workspace.edit` interaction's Y.update
 * in causal (`caused_by`-topological) order. Concurrent edits at
 * non-overlapping anchors merge automatically via Yjs; overlapping
 * different-role edits are arbitrated by `mergeProposal` BEFORE they reach
 * the doc (the lower-role op is `superseded` and never applied here).
 *
 * Phase 2 scope: the algorithm exists and is tested. Integration with the
 * relay's file-edit flow comes when TurnRecorder learns to diff `Edit`/
 * `Write` tool outputs into Y.updates; for now this module is consumed by
 * tests and by future synchronizations.
 */

import * as Y from 'yjs'
import type { Interaction, Patch } from '../interaction.ts'

export type VersionableText = {
  /** Current text. */
  text: string
  /** Number of admitted edits folded in. */
  ops: number
}

/**
 * Build a fresh Y.Doc, apply every versionable update in the given order,
 * and return the resulting text. Caller is responsible for ordering — the
 * fold engine topologically sorts by `caused_by` before calling here.
 */
export function applyEdits(edits: Interaction[]): VersionableText {
  const doc = new Y.Doc()
  let count = 0
  for (const edit of edits) {
    if (edit.patch.kind !== 'versionable' || !edit.patch.ops) continue
    const update = Buffer.from(edit.patch.ops, 'base64')
    Y.applyUpdate(doc, update)
    count++
  }
  const text = doc.getText('content').toString()
  doc.destroy()
  return { text, ops: count }
}

/**
 * Encode a single Y.update as the base64 string a `workspace.edit` patch
 * carries. Used by the (future) file-diff capture in TurnRecorder.
 */
export function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString('base64')
}

/**
 * Produce a portable Y.update for a single text mutation against an existing
 * Y.Doc. The caller owns the Doc (one per artifact, kept alive across edits);
 * we mutate it in place, return the update bytes, and the caller appends them
 * as a `workspace.edit` patch.
 *
 * This shape is the realistic integration point — Yjs updates encode
 * operations relative to *the same doc instance's* client IDs, so a portable
 * stateless `before → after → update` helper isn't possible without a shared
 * doc. Phase 2+ wires this up; the Phase 2 module ships the algorithm only.
 */
export function mutateAndEncode(
  doc: Y.Doc,
  mutate: (text: Y.Text) => void,
): string {
  const baseline = Y.encodeStateVector(doc)
  mutate(doc.getText('content'))
  return encodeUpdate(Y.encodeStateAsUpdate(doc, baseline))
}

/** Convenience: a typed guard for versionable patches. */
export function isVersionablePatch(p: Patch): p is Extract<Patch, { kind: 'versionable' }> {
  return p.kind === 'versionable'
}
