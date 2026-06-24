/**
 * await-verdict — bridges the Promise-shaped adapter permission handler with
 * the ledger verdict admission (tool.approved/tool.denied). Timeout returns
 * `deny`, preserving the deny-floor invariant.
 */

import type { Verdict } from '../agent-adapter.ts'
import type { Hash, Interaction } from './interaction.ts'
import type { Store } from './store.ts'

export const DEFAULT_VERDICT_TIMEOUT_MS = 5 * 60 * 1000

/** Resolve when a tool.approved/tool.denied admits with `caused_by` containing
 *  `toolRequestedHash`. Pre-existing verdicts resolve on the first store scan. */
export function awaitVerdict(
  store: Store,
  toolRequestedHash: Hash,
  timeoutMs: number = DEFAULT_VERDICT_TIMEOUT_MS,
): Promise<Verdict> {
  return new Promise<Verdict>(resolve => {
    let settled = false
    const settle = (v: Verdict): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(v)
    }
    const matches = (i: Interaction): boolean =>
      (i.verb === 'tool.approved' || i.verb === 'tool.denied') &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
      i.caused_by.includes(toolRequestedHash)
    const verdictFor = (i: Interaction): Verdict =>
      i.verb === 'tool.approved'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: i.deniedReason ?? 'denied' }

    const unsubscribe = store.subscribe(i => {
      if (matches(i)) settle(verdictFor(i))
    })
    const timer = setTimeout(() => {
      settle({ behavior: 'deny', message: 'Approval timed out.' })
    }, timeoutMs)

    // Check for an already-existing verdict (race: classification fired before we subscribed).
    void (async () => {
      const approvals = await store.listByVerb('tool.approved')
      for (const i of approvals) {
        if (matches(i)) {
          settle(verdictFor(i))
          return
        }
      }
      const denials = await store.listByVerb('tool.denied')
      for (const i of denials) {
        if (matches(i)) {
          settle(verdictFor(i))
          return
        }
      }
    })()
  })
}
