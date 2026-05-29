/**
 * Approval concept — the lifecycle of every ask-tier permission request,
 * keyed by the tool.requested Interaction hash.
 *
 * Replaces `Approvals.pending: Map<correlationId, ...>` and the
 * `msgToCorr: Map<msgId, correlationId>` lookup. The Promise resolver itself
 * still lives in memory (a Promise resolver is not serialisable; it has to —
 * persistable wake-up is a Phase 2+ feature) but the *index* of "which
 * interaction does this Discord message-id belong to" is now a fold.
 *
 * Rubric #1 (Replayability): if the relay restarts mid-approval, the lifecycle
 * fold still shows the pending tool.requested has no admitted resolution.
 * Rubric #3 (Interpretability): one slice (the tool.requested + its eventual
 * tool.approved/tool.denied) tells the auditor exactly what was asked and how
 * it was answered, with no external context.
 */

import type { Fold } from '../fold.ts'
import type { Hash, Interaction } from '../interaction.ts'
import { stableJson } from '../util.ts'

export type ApprovalStatus = 'pending' | 'allowed' | 'denied'

export type ApprovalState = {
  /** The tool.requested hash — the index key. */
  hash: Hash
  channel: string
  toolName: string
  inputJson: string
  status: ApprovalStatus
  /** Optional: who resolved it and when. */
  resolverActor?: string
  resolvedAt?: string
}

export type ApprovalFoldState = ReadonlyMap<Hash, ApprovalState>

export const APPROVAL_FOLD = 'approval:lifecycle'

export const approvalFold: Fold<ApprovalFoldState> = {
  name: APPROVAL_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    (i.verb === 'tool.requested' ||
      i.verb === 'tool.approved' ||
      i.verb === 'tool.denied'),
  step: (state, i) => {
    const next = new Map(state)

    if (i.verb === 'tool.requested' && i.patch.kind === 'external') {
      next.set(i.hash, {
        hash: i.hash,
        channel: i.channel,
        toolName: i.patch.intent.op,
        inputJson: stableJson(i.patch.intent.args),
        status: 'pending',
      })
    } else if (i.verb === 'tool.approved' || i.verb === 'tool.denied') {
      const target = i.caused_by[0]
      if (target) {
        const prior = next.get(target)
        if (prior) {
          next.set(target, {
            ...prior,
            status: i.verb === 'tool.approved' ? 'allowed' : 'denied',
            resolverActor: i.actor,
            resolvedAt: i.createdAt,
          })
        }
      }
    }
    return next
  },
}

/**
 * Filter helper: pending approvals only, oldest-first. Used by the cross-host
 * "what's awaiting attention" view in Phase 2+ and by debug commands today.
 */
export function pendingApprovals(state: ApprovalFoldState): ApprovalState[] {
  return [...state.values()].filter(a => a.status === 'pending')
}
