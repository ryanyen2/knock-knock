/** apply-supersession — local-first cross-machine lifecycle replication. A peer
 *  re-derives a loser's supersession from the winner's immutable `supersedes`
 *  op (which crosses NOTIFY where the lifecycle UPDATE does not). Idempotent. */

import type { Synchronization } from '../sync.ts'

export function applySupersession(): Synchronization {
  return {
    name: 'apply-supersession',
    matches: i =>
      (i.lifecycle === 'applied' || i.lifecycle === 'admitted') &&
      Array.isArray(i.supersedes) &&
      i.supersedes.length > 0,
    fire: async (winner, ctx) => {
      for (const loser of winner.supersedes ?? []) {
        try {
          const peer = await ctx.store.getByHash(loser)
          // Idempotent: skip a loser already superseded/denied.
          if (!peer || peer.lifecycle === 'superseded' || peer.lifecycle === 'denied') continue
          await ctx.store.updateLifecycle(loser, 'superseded')
        } catch (err) {
          process.stderr.write(`apply-supersession: failed to supersede ${loser.slice(0, 10)}: ${err}\n`)
        }
      }
    },
  }
}
