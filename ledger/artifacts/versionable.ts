/**
 * Versionable artifact — Yjs-backed CRDT for file/text patches, under AOCM.
 *
 * A versionable artifact (`vers:<scope>/<key>`) is a Y.Doc whose state is a
 * pure fold over the artifact's immutable `workspace.edit` operations. Every
 * edit is admitted `applied` (admit.ts does NOT lifecycle-arbitrate versionable
 * edits); dominance, exclusion, and conflict are DERIVED in `projectVersionable`
 * from a deterministic total order `(role_rank DESC, content_hash ASC)`:
 * concurrent edits whose regions interfere are resolved by authority (the
 * higher-role op excludes the lower from the folded set) or, when roles are
 * equal, surfaced as a first-class conflict. Dominance is realized by EXCLUSION
 * from the set Yjs folds — never by reordering the (order-independent) CRDT.
 *
 * See `docs/authority-ordered-convergent-merge.md` for the concept and algebra.
 * v1 retains the whole-file anchor, so different-role exclusion is whole-op
 * (interval-scoped exclusion is deferred); the interference test is already
 * region-aware, so disjoint edits still merge.
 */

import * as Y from 'yjs'
import type { Fold } from '../fold.ts'
import { ROLE_RANK } from '../interaction.ts'
import type { Anchor, ArtifactId, Hash, Interaction, Patch, VersionableIntent } from '../interaction.ts'

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
 * This shape is the integration point `capture-workspace-edit` uses — Yjs
 * updates encode operations relative to *the same doc instance's* client IDs,
 * so a portable stateless `before → after → update` helper isn't possible
 * without a shared doc (hence the per-artifact live doc kept in the capture sync).
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

/** The stable "whole file" anchor (v1). Every edit shares it; AOCM decides
 *  contention by the region-overlap interference test in the projection, not by
 *  the anchor. A fixed sentinel (not a content-length-dependent `to`) keeps the
 *  artifact id stable across edits. Interval anchors are the deferred refinement. */
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

// ─── AOCM interference test (U3) ──────────────────────────────────────────────
//
// Two concurrent edits INTERFERE iff the regions they touch in their common base
// overlap. Disjoint regions merge cleanly via the CRDT; overlapping regions are
// arbitrated by authority (higher role excludes lower) or surfaced as a conflict.
// The test is pure — a function of the immutable intents and the common-base text
// — so every replica computes the same verdict (the basis of AOCM convergence).

/** The half-open byte region a versionable intent touches in `base`. A `write`
 *  spans the whole file; an `edit` spans where its `oldString` sits; an absent
 *  `oldString` fails safe to the whole file (so it interferes with everything,
 *  never silently merges). Pure. */
export function regionOf(intent: VersionableIntent, base: string): { lo: number; hi: number } {
  if (intent.kind === 'write') return { lo: 0, hi: base.length }
  const idx = intent.oldString ? base.indexOf(intent.oldString) : -1
  if (idx < 0) return { lo: 0, hi: base.length }
  return { lo: idx, hi: idx + intent.oldString.length }
}

/** Whether two concurrent intents interfere in their common base. Two whole-file
 *  `write`s always interfere (two whole-file replaces are irreconcilable, even on
 *  an empty base); otherwise it is half-open interval intersection of their regions.
 *  Pure and replica-identical. */
export function interferes(a: VersionableIntent, b: VersionableIntent, base: string): boolean {
  if (a.kind === 'write' && b.kind === 'write') return true
  const ra = regionOf(a, base)
  const rb = regionOf(b, base)
  return ra.lo < rb.hi && rb.lo < ra.hi
}

export type VersionableFoldState = ReadonlyMap<ArtifactId, ReadonlyMap<Hash, Interaction>>

export const VERSIONABLE_FOLD = 'versionable:edits'

/** Accumulates `workspace.edit`s per artifact. Under AOCM every versionable edit
 *  is admitted `applied` (admit.ts does not lifecycle-arbitrate them), so the whole
 *  contended set reaches the slice; dominance/exclusion/conflict is then DERIVED in
 *  `projectVersionable`, not encoded in the lifecycle. The key only gates slice
 *  membership (the per-interaction predicate cannot consult other ops). */
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

/** A derived equal-role conflict: concurrent edits whose regions interfere but
 *  whose authors are the same role, so authority cannot decide. Surfaced as a
 *  first-class conflict (U5). `branches` are the contending edit hashes, sorted
 *  (deterministic across replicas). */
export type ConflictRegion = { branches: Hash[] }

export type VersionableProjection = VersionableText & { conflicts: ConflictRegion[] }

/** The normalized intent an edit carries, or a whole-file fallback when absent
 *  (pre-intent edits / non-intent fixtures). The fallback fails safe to whole-file,
 *  so such edits always interfere — matching the legacy whole-file-anchor behavior. */
function intentOf(edit: Interaction): VersionableIntent {
  if (edit.patch.kind === 'versionable' && edit.patch.intent) return edit.patch.intent
  return { kind: 'write', content: '' }
}

/** Transitive ancestors of `hash` within the slice (caused_by edges, restricted to
 *  edits present in the slice — tool.executed parents and the like fall outside). */
function ancestorsInSlice(hash: Hash, byHash: ReadonlyMap<Hash, Interaction>): Set<Hash> {
  const seen = new Set<Hash>()
  const walk = (h: Hash) => {
    const e = byHash.get(h)
    if (!e) return
    for (const p of e.caused_by) {
      if (byHash.has(p) && !seen.has(p)) {
        seen.add(p)
        walk(p)
      }
    }
  }
  walk(hash)
  return seen
}

/**
 * AOCM derived-dominance projection (U4). The live text is computed by:
 *   1. ordering edits by the total order `(role_rank DESC, content_hash ASC)`;
 *   2. greedily keeping edits, excluding any `x` for which a higher-or-equal-priority
 *      KEPT edit `y` is both CONCURRENT with `x` (neither causally precedes the other)
 *      and INTERFERES with it (region-overlap on their common base);
 *   3. folding the kept (live) set through Yjs.
 * Different-role interference excludes the lower-role edit silently; equal-role
 * interference keeps the lower-hash edit (it sorts first) and records a first-class
 * conflict. Dominance is realized by EXCLUSION from the folded set, never by
 * reordering the (order-independent) CRDT. Pure over the immutable slice → the text
 * and the conflict set are byte-identical on every replica.
 *
 * v1 simplifications (the whole-file anchor era): a missing intent fails safe to
 * whole-file; the common base is the fold of two edits' shared ancestor edits; an
 * edit chained onto a dominated concurrent edit is handled greedily (deep
 * chain-on-dominated cases are a deferred edge — see the plan's Open Questions).
 */
export function projectVersionable(state: VersionableFoldState, artifactId: ArtifactId): VersionableProjection {
  const editsMap = state.get(artifactId)
  if (!editsMap || editsMap.size === 0) return { text: '', ops: 0, conflicts: [] }

  const ancestorCache = new Map<Hash, Set<Hash>>()
  const ancestorsOf = (h: Hash): Set<Hash> => {
    let a = ancestorCache.get(h)
    if (!a) {
      a = ancestorsInSlice(h, editsMap)
      ancestorCache.set(h, a)
    }
    return a
  }
  const concurrent = (x: Interaction, y: Interaction): boolean =>
    !ancestorsOf(x.hash).has(y.hash) && !ancestorsOf(y.hash).has(x.hash)
  const commonBase = (x: Interaction, y: Interaction): string => {
    const ax = ancestorsOf(x.hash)
    const shared = [...ancestorsOf(y.hash)].filter(h => ax.has(h))
    if (shared.length === 0) return ''
    const baseEdits = shared
      .map(h => editsMap.get(h)!)
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    return applyEdits(baseEdits).text
  }

  const ordered = [...editsMap.values()].sort(
    (a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  )
  const kept: Interaction[] = []
  const conflicts: ConflictRegion[] = []
  for (const x of ordered) {
    let dominator: Interaction | undefined
    for (const y of kept) {
      if (concurrent(x, y) && interferes(intentOf(y), intentOf(x), commonBase(x, y))) {
        dominator = y
        break
      }
    }
    if (!dominator) {
      kept.push(x)
      continue
    }
    if (ROLE_RANK[dominator.role] === ROLE_RANK[x.role]) {
      conflicts.push({ branches: [dominator.hash, x.hash].sort() })
    }
    // x is excluded from the live set (dominated by a kept higher-or-equal edit).
  }

  // Fold the live set deterministically (hash order; Yjs is order-independent).
  const live = kept.slice().sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const folded = applyEdits(live)
  return { text: folded.text, ops: folded.ops, conflicts }
}

/** The hashes of the artifact's currently-applied edits — used as `caused_by`
 *  parents so a new edit chains onto them (sequential edits don't conflict),
 *  while a concurrent edit from the same base does. */
export function versionableEditHashes(state: VersionableFoldState, artifactId: ArtifactId): Hash[] {
  const edits = state.get(artifactId)
  return edits ? [...edits.keys()] : []
}
