/**
 * Concurrency queries for the merge gate.
 *
 * `findConcurrentAtAnchor(store, proposed)` returns the set of admitted (or
 * applied) Interactions that:
 *   - target the same artifactId,
 *   - have an anchor that matches proposed's,
 *   - are concurrent with proposed (neither is a transitive ancestor of the
 *     other in `caused_by`).
 *
 * `anchorMatches` is currently strict equality on the structural fields.
 * Range overlap (a real edit at byte 0..10 should conflict with another edit
 * at 5..15) is Phase 2.1 — for now we treat range anchors as exact slots, so
 * concurrent edits to slightly different ranges fall through and the merge
 * is a no-op. The worst case is missed conflicts, never false ones.
 */

import type { Store } from './store.ts'
import type { Anchor, Hash, Interaction } from './interaction.ts'

export function anchorMatches(a: Anchor, b: Anchor): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'none':
      return true
    case 'range': {
      const r = b as Extract<Anchor, { kind: 'range' }>
      return a.from === r.from && a.to === r.to
    }
    case 'crdt': {
      const r = b as Extract<Anchor, { kind: 'crdt' }>
      return a.rgaPos === r.rgaPos
    }
    case 'key': {
      const r = b as Extract<Anchor, { kind: 'key' }>
      return a.path === r.path
    }
    case 'proxy': {
      const r = b as Extract<Anchor, { kind: 'proxy' }>
      return a.proxyId === r.proxyId
    }
  }
}

/**
 * Concurrent-at-anchor lookup. Used by the admission gate (admit.ts) to
 * supply `concurrentAtAnchor` to `mergeProposal`. The proposed interaction's
 * `hash` is NOT yet in the store; we walk its `caused_by` to decide whether
 * a stored peer is one of its ancestors.
 */
export async function findConcurrentAtAnchor(
  store: Store,
  proposed: Interaction,
): Promise<Interaction[]> {
  if (proposed.target.anchor.kind === 'none') return []

  const peers = await store.listByArtifact(proposed.target.artifactId)
  const candidates = peers.filter(
    p =>
      p.hash !== proposed.hash &&
      (p.lifecycle === 'admitted' || p.lifecycle === 'applied') &&
      anchorMatches(p.target.anchor, proposed.target.anchor),
  )

  const out: Interaction[] = []
  for (const p of candidates) {
    if (await isAncestor(store, p.hash, proposed)) continue // p is ancestor of proposed
    if (await store.isAncestor(proposed.hash, p.hash)) continue // proposed is ancestor of p
    out.push(p)
  }
  return out
}

/**
 * "Is `maybeAncestor` reachable from `descendant.caused_by` via parent edges?"
 * The descendant isn't in the store yet — we walk from its caused_by.
 */
async function isAncestor(
  store: Store,
  maybeAncestor: Hash,
  descendant: Interaction,
): Promise<boolean> {
  for (const parent of descendant.caused_by) {
    if (parent === maybeAncestor) return true
    if (await store.isAncestor(maybeAncestor, parent)) return true
  }
  return false
}
