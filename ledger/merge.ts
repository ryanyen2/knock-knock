/**
 * The role-ordered merge — the part of knock-knock that is genuinely ours.
 *
 * A plain CRDT can't give the owner-overrides-agent affordance a social
 * application needs: it has no notion of role, so two writers always merge
 * symmetrically. Our merge takes the same patch shape but applies it through
 * the lens of "who is doing it in this channel" (owner > human > agent,
 * per channel — Role is snapshotted onto the Interaction at admission).
 *
 * This module is PURE — no I/O. It takes a proposed Interaction and the set
 * of concurrent-at-anchor interactions already admitted, and returns the
 * outcome. The caller (admit.ts) does the store writes, the supersession
 * surfacing, and the conflict-annotation journaling.
 *
 * Anchor semantics: `{kind: 'none'}` means "this interaction has no anchor"
 * and therefore can never conflict — channel.message, turn.prompted,
 * tool.requested all use this and the gate is a no-op for them. Anchored
 * verbs (workspace.edit, knowledge.append/invalidate) are where this fires.
 *
 * External effects bypass the role-ordered merge: two `external.*` patches
 * targeting the same proxy can both have completed, so we cannot supersede
 * one with the other. They are instead serialized by `external_claim`
 * (artifacts/external.ts). This is the Phase 2 admission floor for side
 * effects: nothing crosses the boundary without a held claim.
 */

import { ROLE_RANK, type Interaction, type Role, type Hash } from './interaction.ts'

export type MergeOutcome =
  /** Proposed is admitted; the named peers lose their lifecycle to 'superseded'. */
  | { kind: 'admit'; supersede: Hash[] }
  /**
   * Equal-role concurrent peers exist; both proposed and the named peers
   * stay visible. The gate writes a `merge.resolve` annotation pointing at
   * the branches; resolution = a higher-role actor proposes a patch that
   * supersedes the unchosen branches.
   */
  | { kind: 'conflict'; branches: Hash[] }
  /** Proposed loses to a higher-role peer at the same anchor. */
  | { kind: 'reject'; reason: 'lower-role'; winner: Hash }

/**
 * Decide what happens to a proposed Interaction, given the already-admitted
 * peers that are *concurrent with it at the same anchor*. The caller pre-
 * filters: same `target.artifactId`, equal `target.anchor`, and neither
 * party is a transitive ancestor of the other in `caused_by`.
 *
 * Phase 2 — single-machine semantics:
 *   - `{kind: 'none'}` anchor or empty peers → straight admit, no supersede.
 *   - Proposed is external OR any peer is external → straight admit, no
 *     supersede (external effects don't supersede each other; the claim
 *     primitive serializes them at write time).
 *   - Any peer has strictly higher role → reject proposed.
 *   - Otherwise: equal-role peers go into conflict.branches; strictly-lower
 *     peers are superseded by proposed. If conflict.branches non-empty,
 *     return conflict; else admit-with-supersede.
 */
export function mergeProposal(
  proposed: Interaction,
  concurrentAtAnchor: Interaction[],
): MergeOutcome {
  // 1. No anchor → no merge. The interaction is its own slot in the DAG.
  if (proposed.target.anchor.kind === 'none') {
    return { kind: 'admit', supersede: [] }
  }
  // 2. No concurrent peers → straight admit.
  if (concurrentAtAnchor.length === 0) {
    return { kind: 'admit', supersede: [] }
  }
  // 3. External effects bypass role-ordered merge.
  if (
    proposed.effect === 'external' ||
    concurrentAtAnchor.some(c => c.effect === 'external')
  ) {
    return { kind: 'admit', supersede: [] }
  }

  // 4. Role-ordered partition.
  const pRank = roleRank(proposed.role)
  const conflict: Hash[] = []
  const supersede: Hash[] = []
  for (const c of concurrentAtAnchor) {
    const cRank = roleRank(c.role)
    if (cRank > pRank) {
      // A strictly higher-role admitted peer wins; proposed is rejected.
      // The caller surfaces this back to the proposer via a knowledge note.
      return { kind: 'reject', reason: 'lower-role', winner: c.hash }
    }
    if (cRank === pRank) {
      conflict.push(c.hash)
    } else {
      supersede.push(c.hash)
    }
  }

  if (conflict.length > 0) {
    // Surface both authors. Resolution = a higher-role merge.resolve patch.
    return { kind: 'conflict', branches: [proposed.hash, ...conflict] }
  }
  return { kind: 'admit', supersede }
}

function roleRank(role: Role): number {
  return ROLE_RANK[role]
}
