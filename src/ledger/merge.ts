/**
 * The role-ordered merge (owner > human > agent; role snapshotted at admission). PURE — no I/O.
 * `{kind: 'none'}` anchor never conflicts; external.* bypasses the merge (serialized by external_claim).
 */

import { ROLE_RANK, type Interaction, type Role, type Hash } from './interaction.ts'

export type MergeOutcome =
  /** Proposed is admitted; the named peers lose their lifecycle to 'superseded'. */
  | { kind: 'admit'; supersede: Hash[] }
  /** Equal-role concurrent peers; both proposed and peers stay visible until a higher-role actor resolves. */
  | { kind: 'conflict'; branches: Hash[] }
  /** Proposed loses to a higher-role peer at the same anchor. */
  | { kind: 'reject'; reason: 'lower-role'; winner: Hash }

/**
 * Decide a proposed Interaction's fate given the already-admitted peers concurrent at the same anchor.
 * No anchor/no peers/external → admit; higher-role peer → reject; equal-role → conflict; lower → supersede.
 */
export function mergeProposal(
  proposed: Interaction,
  concurrentAtAnchor: Interaction[],
): MergeOutcome {
  // No anchor → no merge.
  if (proposed.target.anchor.kind === 'none') {
    return { kind: 'admit', supersede: [] }
  }
  // No concurrent peers → straight admit.
  if (concurrentAtAnchor.length === 0) {
    return { kind: 'admit', supersede: [] }
  }
  // External effects bypass role-ordered merge.
  if (
    proposed.effect === 'external' ||
    concurrentAtAnchor.some(c => c.effect === 'external')
  ) {
    return { kind: 'admit', supersede: [] }
  }

  // Role-ordered partition. Sort by hash so a higher-role tie resolves to the same winner cross-machine.
  const pRank = roleRank(proposed.role)
  const sortedPeers = [...concurrentAtAnchor].sort((a, b) =>
    a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
  )
  const conflict: Hash[] = []
  const supersede: Hash[] = []
  for (const c of sortedPeers) {
    const cRank = roleRank(c.role)
    if (cRank > pRank) {
      // Strictly higher-role peer wins; ties break to the lower hash (cross-machine consistent).
      return { kind: 'reject', reason: 'lower-role', winner: c.hash }
    }
    if (cRank === pRank) {
      conflict.push(c.hash)
    } else {
      supersede.push(c.hash)
    }
  }

  // Sort outputs so two machines compute byte-equal MergeOutcomes regardless of local store order.
  supersede.sort()
  if (conflict.length > 0) {
    const branches = [proposed.hash, ...conflict].sort()
    return { kind: 'conflict', branches }
  }
  return { kind: 'admit', supersede }
}

function roleRank(role: Role): number {
  return ROLE_RANK[role]
}
