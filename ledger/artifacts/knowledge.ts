/**
 * Knowledge artifact — append-only notes with tombstone-cascade staleness.
 *
 * A knowledge artifact is identified by `artifactId: know:<scope>/<name>`,
 * e.g. `know:agent/clauderelay/inbox`. Notes are journaled as
 * `knowledge.append` Interactions; the patch carries `{id, body, tags?}`.
 * Reversal is `knowledge.invalidate` — a forward Interaction whose patch
 * names the target note's hash. We never delete; the note stays in the
 * ledger but is filtered out of "active knowledge" views.
 *
 * Staleness cascades: if note A is tombstoned, every knowledge append in
 * the same artifact whose `caused_by` transitively reaches A is also stale.
 * That's how the "you wrote §3 because of my evidence in §2; I retracted §2"
 * loop closes — the downstream §3 is automatically flagged for re-derivation.
 *
 * Phase 2 scope: cascade is intra-artifact only. Cross-verb propagation (a
 * tool.executed caused_by an invalidated knowledge.append also marked stale)
 * is Phase 2.1 — knowledge already handles itself first.
 */

import type { Fold } from '../fold.ts'
import type {
  ActorId,
  ArtifactId,
  Hash,
  KnowledgeNote,
  Role,
} from '../interaction.ts'

export type StoredNote = {
  /** Hash of the knowledge.append Interaction. */
  hash: Hash
  note: KnowledgeNote
  /** Other notes in the same artifact that THIS note's interaction was caused by. */
  parentNotes: Hash[]
  actor: ActorId
  role: Role
  createdAt: string
}

export type ArtifactKnowledge = {
  notes: ReadonlyMap<Hash, StoredNote>
  tombstoned: ReadonlySet<Hash>
}

export type KnowledgeFoldState = ReadonlyMap<ArtifactId, ArtifactKnowledge>

export const KNOWLEDGE_FOLD = 'knowledge:notes'

const EMPTY_ARTIFACT: ArtifactKnowledge = {
  notes: new Map(),
  tombstoned: new Set(),
}

export const knowledgeFold: Fold<KnowledgeFoldState> = {
  name: KNOWLEDGE_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.target.artifactId.startsWith('know:') &&
    (i.verb === 'knowledge.append' || i.verb === 'knowledge.invalidate'),
  step: (state, i) => {
    if (i.patch.kind !== 'knowledge') return state
    const prior = state.get(i.target.artifactId) ?? EMPTY_ARTIFACT
    const next = new Map(state)

    if (i.verb === 'knowledge.append' && i.patch.append) {
      const notes = new Map(prior.notes)
      const parentNotes = i.caused_by.filter(h => prior.notes.has(h))
      notes.set(i.hash, {
        hash: i.hash,
        note: i.patch.append,
        parentNotes,
        actor: i.actor,
        role: i.role,
        createdAt: i.createdAt,
      })
      next.set(i.target.artifactId, { notes, tombstoned: prior.tombstoned })
      return next
    }

    if (i.verb === 'knowledge.invalidate' && i.patch.invalidate) {
      const tombstoned = new Set(prior.tombstoned)
      tombstoned.add(i.patch.invalidate.hash)
      next.set(i.target.artifactId, { notes: prior.notes, tombstoned })
      return next
    }

    return state
  },
}

/**
 * Active notes for an artifact: live notes (not tombstoned) AND not stale
 * (no ancestor in the same artifact is tombstoned). Returned oldest-first.
 */
export function activeNotes(
  state: KnowledgeFoldState,
  artifactId: ArtifactId,
): StoredNote[] {
  const all = annotateWithStaleness(state, artifactId)
  return all.filter(({ stale }) => !stale).map(({ note }) => note)
}

/**
 * Every note in the artifact annotated with `stale: boolean`. Used by the
 * dual-audience renderer (rubric #3): the human auditor sees the full
 * history; the agent's prompt context filters by `!stale`.
 */
export function annotateWithStaleness(
  state: KnowledgeFoldState,
  artifactId: ArtifactId,
): Array<{ note: StoredNote; stale: boolean }> {
  const artifact = state.get(artifactId) ?? EMPTY_ARTIFACT
  return [...artifact.notes.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(n => ({ note: n, stale: isStale(artifact, n.hash) }))
}

/**
 * A note is stale if it is itself tombstoned OR any ancestor (intra-artifact)
 * is tombstoned. BFS through parentNotes; bounded by the artifact size, no
 * unbounded recursion since parentNotes only references known notes.
 */
function isStale(artifact: ArtifactKnowledge, hash: Hash): boolean {
  if (artifact.tombstoned.has(hash)) return true
  const seen = new Set<Hash>([hash])
  const frontier: Hash[] = [hash]
  while (frontier.length > 0) {
    const node = frontier.pop()!
    const stored = artifact.notes.get(node)
    if (!stored) continue
    for (const parent of stored.parentNotes) {
      if (artifact.tombstoned.has(parent)) return true
      if (!seen.has(parent)) {
        seen.add(parent)
        frontier.push(parent)
      }
    }
  }
  return false
}
