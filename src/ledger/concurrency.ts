/**
 * Concurrency queries for the merge gate. `anchorMatches` is strict equality;
 * range overlap is not modeled, so the worst case is missed conflicts, never false ones.
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

/** Concurrent-at-anchor lookup feeding `mergeProposal`. The proposed `hash` is
 *  not yet in the store; we walk its `caused_by` to detect ancestor peers. */
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

/** Is `maybeAncestor` reachable from `descendant.caused_by` via parent edges? */
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
