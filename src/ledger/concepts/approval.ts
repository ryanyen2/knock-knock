/** Approval concept — lifecycle of every ask-tier permission request, keyed by
 *  the tool.requested Interaction hash. */

import type { Fold } from '../fold.ts'
import type { Hash, Interaction } from '../interaction.ts'
import { stableJson } from '../util.ts'

export type ApprovalStatus = 'pending' | 'allowed' | 'denied'

export type ApprovalState = {
  hash: Hash
  channel: string
  toolName: string
  inputJson: string
  status: ApprovalStatus
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

/** Pending approvals only, oldest-first. */
export function pendingApprovals(state: ApprovalFoldState): ApprovalState[] {
  return [...state.values()].filter(a => a.status === 'pending')
}
