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
import type { Fold } from '../fold.ts'
import type { Anchor, ArtifactId, Hash, Interaction, Patch } from '../interaction.ts'

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

// ─── Wiring into the real edit flow (walking skeleton) ────────────────────────
//
// The pieces below connect an agent's Edit/Write tool calls to the versionable
// CRDT so two agents editing the same file converge over the ledger and conflicts
// resolve through the role-ordered merge gate — no Discord conversation. The
// capture synchronization turns an edit into a `workspace.edit`; this fold projects
// the merged text; the write-back synchronization lands it on disk under a claim.
//
// Skeleton scope: whole-file replace/append, one stable whole-file anchor. Yjs
// `applyUpdate` is a CRDT merge, so the projection converges regardless of the
// order the fold accumulated the updates. Fine-grained ranges are deferred.

/** Artifact id for a file in a scope: `vers:<scope>/<workspace-relative-path>`. */
export function versionableArtifactId(scope: string, relPath: string): ArtifactId {
  return `vers:${scope}/${relPath}`
}

/** Split a `vers:<scope>/<relPath>` id back into its parts (scope = up to the
 *  first slash; a Discord scope id never contains one). Undefined if malformed. */
export function parseVersionableId(artifactId: ArtifactId): { scope: string; relPath: string } | undefined {
  if (!artifactId.startsWith('vers:')) return undefined
  const rest = artifactId.slice('vers:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { scope: rest.slice(0, slash), relPath: rest.slice(slash + 1) }
}

/** The stable "whole file" anchor. Every whole-file edit shares it, so two
 *  concurrent whole-file edits contend at the merge gate (anchorMatches is strict
 *  equality, so a content-length-dependent `to` would never match). */
export const WHOLE_FILE_ANCHOR: Anchor = { kind: 'range', from: 0, to: 0 }

/** The edit a tool call expresses, normalized across Edit/Write shapes. */
export type EditIntent =
  | { kind: 'write'; filePath: string; content: string }
  | { kind: 'edit'; filePath: string; oldString: string; newString: string }

/** Pull an EditIntent out of an Edit/Write tool's name + args. Returns undefined
 *  for any other tool (the capture sync then ignores it). Pure. */
export function parseEditIntent(toolName: string, args: unknown): EditIntent | undefined {
  if (!args || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof a[k] === 'string') return a[k] as string
    return undefined
  }
  const name = toolName.toLowerCase()
  const filePath = str('file_path', 'filePath', 'path')
  if (!filePath) return undefined
  if (name === 'write') {
    const content = str('content', 'contents', 'file_text', 'text')
    return content !== undefined ? { kind: 'write', filePath, content } : undefined
  }
  if (name === 'edit' || name === 'multiedit') {
    const oldString = str('old_string', 'oldString')
    const newString = str('new_string', 'newString')
    return oldString !== undefined && newString !== undefined
      ? { kind: 'edit', filePath, oldString, newString }
      : undefined
  }
  return undefined
}

/** Apply an EditIntent to the current file text, returning the new text. A
 *  Write replaces wholesale; an Edit replaces the first occurrence of oldString
 *  (no-op if absent — the capture sync then skips). Pure. */
export function applyEditIntent(currentText: string, intent: EditIntent): string {
  if (intent.kind === 'write') return intent.content
  if (!intent.oldString) return currentText
  const idx = currentText.indexOf(intent.oldString)
  if (idx < 0) return currentText
  return currentText.slice(0, idx) + intent.newString + currentText.slice(idx + intent.oldString.length)
}

export type VersionableFoldState = ReadonlyMap<ArtifactId, ReadonlyMap<Hash, Interaction>>

export const VERSIONABLE_FOLD = 'versionable:edits'

/** Accumulates admitted `workspace.edit`s per artifact. The projection
 *  (`projectVersionable`) folds them through `applyEdits`; superseded/proposed
 *  edits never reach here (the key filters to admitted|applied), so the merge
 *  gate's arbitration is honored automatically. */
export const versionableFold: Fold<VersionableFoldState> = {
  name: VERSIONABLE_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.verb === 'workspace.edit' &&
    i.target.artifactId.startsWith('vers:') &&
    i.patch.kind === 'versionable',
  step: (state, i) => {
    const prior = state.get(i.target.artifactId) ?? new Map<Hash, Interaction>()
    if (prior.has(i.hash)) return state
    const edits = new Map(prior)
    edits.set(i.hash, i)
    const next = new Map(state)
    next.set(i.target.artifactId, edits)
    return next
  },
}

/** Project the merged text for one artifact. Edits are applied in hash order for
 *  determinism; Yjs convergence makes the final text order-independent anyway. */
export function projectVersionable(state: VersionableFoldState, artifactId: ArtifactId): VersionableText {
  const edits = state.get(artifactId)
  if (!edits || edits.size === 0) return { text: '', ops: 0 }
  const ordered = [...edits.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  return applyEdits(ordered)
}

/** The hashes of the artifact's currently-applied edits — used as `caused_by`
 *  parents so a new edit chains onto them (sequential edits don't conflict),
 *  while a concurrent edit from the same base does. */
export function versionableEditHashes(state: VersionableFoldState, artifactId: ArtifactId): Hash[] {
  const edits = state.get(artifactId)
  return edits ? [...edits.keys()] : []
}
