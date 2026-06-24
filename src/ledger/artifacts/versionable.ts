/**
 * Versionable artifact — Yjs-backed CRDT for file/text patches, under AOCM.
 * Every edit is admitted applied; dominance/exclusion/conflict derived in projectVersionable.
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

/** Apply every versionable update against a fresh Y.Doc and return the text. */
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

/** Encode a single Y.update as the base64 string a `workspace.edit` patch carries. */
export function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString('base64')
}

/** Produce a portable Y.update for a single text mutation against a caller-owned Y.Doc. */
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

// ─── Wiring into the real edit flow ───────────────────────────────────────────

/** Artifact id for a file in a scope: `vers:<scope>/<workspace-relative-path>`. */
export function versionableArtifactId(scope: string, relPath: string): ArtifactId {
  return `vers:${scope}/${relPath}`
}

/** Split a `vers:<scope>/<relPath>` id back into its parts. Undefined if malformed. */
export function parseVersionableId(artifactId: ArtifactId): { scope: string; relPath: string } | undefined {
  if (!artifactId.startsWith('vers:')) return undefined
  const rest = artifactId.slice('vers:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { scope: rest.slice(0, slash), relPath: rest.slice(slash + 1) }
}

/** The stable whole-file anchor. Contention is decided by the interference test, not the anchor. */
export const WHOLE_FILE_ANCHOR: Anchor = { kind: 'range', from: 0, to: 0 }

/** The edit a tool call expresses, normalized across Edit/Write shapes. */
export type EditIntent =
  | { kind: 'write'; filePath: string; content: string }
  | { kind: 'edit'; filePath: string; oldString: string; newString: string }

/** Pull an EditIntent out of an Edit/Write tool's name + args; undefined for any other tool. Pure. */
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

/** Apply an EditIntent to the current text. Write replaces wholesale; Edit replaces first occurrence. Pure. */
export function applyEditIntent(currentText: string, intent: EditIntent): string {
  if (intent.kind === 'write') return intent.content
  if (!intent.oldString) return currentText
  const idx = currentText.indexOf(intent.oldString)
  if (idx < 0) return currentText
  return currentText.slice(0, idx) + intent.newString + currentText.slice(idx + intent.oldString.length)
}

// ─── AOCM interference test ───────────────────────────────────────────────────
// Two concurrent edits interfere iff their regions in the common base overlap. Pure → replica-identical.

/** Half-open byte region an intent touches in `base`; absent `oldString` fails safe to whole-file. Pure. */
export function regionOf(intent: VersionableIntent, base: string): { lo: number; hi: number } {
  if (intent.kind === 'write') return { lo: 0, hi: base.length }
  const idx = intent.oldString ? base.indexOf(intent.oldString) : -1
  if (idx < 0) return { lo: 0, hi: base.length }
  return { lo: idx, hi: idx + intent.oldString.length }
}

/** Whether two concurrent intents interfere. Two whole-file writes always interfere. Pure, replica-identical. */
export function interferes(a: VersionableIntent, b: VersionableIntent, base: string): boolean {
  if (a.kind === 'write' && b.kind === 'write') return true
  const ra = regionOf(a, base)
  const rb = regionOf(b, base)
  return ra.lo < rb.hi && rb.lo < ra.hi
}

export type VersionableFoldState = ReadonlyMap<ArtifactId, ReadonlyMap<Hash, Interaction>>

export const VERSIONABLE_FOLD = 'versionable:edits'

/** Membership predicate for a versionable edit: admitted/applied `workspace.edit` with a
 *  `versionable` patch on a `vers:` artifact. Shared by fold, conflict card, and write-back. */
export function isVersionableEdit(i: Interaction): boolean {
  return (
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.verb === 'workspace.edit' &&
    i.target.artifactId.startsWith('vers:') &&
    i.patch.kind === 'versionable'
  )
}

export const versionableFold: Fold<VersionableFoldState> = {
  name: VERSIONABLE_FOLD,
  init: () => new Map(),
  key: isVersionableEdit,
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

/** A derived equal-role conflict: interfering concurrent edits authority cannot decide.
 *  `branches` are the contending edit hashes, sorted (deterministic across replicas). */
export type ConflictRegion = { branches: Hash[] }

export type VersionableProjection = VersionableText & {
  conflicts: ConflictRegion[]
  /** Hashes of the LIVE (kept, non-excluded) edits; a new edit chains `caused_by` onto these. */
  live: Hash[]
}

/** The edit's normalized intent, or a whole-file fallback when absent (fails safe → always interferes). */
function intentOf(edit: Interaction): VersionableIntent {
  if (edit.patch.kind === 'versionable' && edit.patch.intent) return edit.patch.intent
  return { kind: 'write', content: '' }
}

/** Transitive ancestors of `hash` within the slice (caused_by edges restricted to slice edits). */
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
 * AOCM derived-dominance projection: order by `(role_rank DESC, content_hash ASC)`, greedily keep
 * edits excluding any `x` a higher-or-equal kept edit is concurrent-with AND interferes-with, then
 * fold the kept set. Different-role interference excludes silently; equal-role records a conflict.
 * Dominance is EXCLUSION from the folded set, not CRDT reordering. Pure → byte-identical per replica.
 */
export function projectVersionable(state: VersionableFoldState, artifactId: ArtifactId): VersionableProjection {
  const editsMap = state.get(artifactId)
  if (!editsMap || editsMap.size === 0) return { text: '', ops: 0, conflicts: [], live: [] }

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
    // x excluded: dominated by a kept higher-or-equal edit.
  }

  // Fold the live set deterministically (hash order; Yjs is order-independent).
  const live = kept.slice().sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const folded = applyEdits(live)
  return { text: folded.text, ops: folded.ops, conflicts, live: live.map(e => e.hash) }
}

/** Every edit hash in the artifact's slice — live AND excluded/conflicting. */
export function allVersionableEditHashes(state: VersionableFoldState, artifactId: ArtifactId): Hash[] {
  const edits = state.get(artifactId)
  return edits ? [...edits.keys()] : []
}

/** The artifact's LIVE (kept) edit hashes — used as `caused_by` parents for a new edit. */
export function liveVersionableEditHashes(state: VersionableFoldState, artifactId: ArtifactId): Hash[] {
  return projectVersionable(state, artifactId).live
}
