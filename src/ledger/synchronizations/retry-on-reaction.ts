/** retry-on-reaction — on a `turn.retry`, re-admit a `turn.prompted` for the
 *  original inbound, mixing the retry hash into caused_by so it's a distinct
 *  interaction (not deduped to a no-op). */

import type { Synchronization } from '../sync.ts'

export function retryOnReaction(): Synchronization {
  return {
    name: 'retry-on-reaction',
    matches: i =>
      i.verb === 'turn.retry' && (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (retry, ctx) => {
      const originalPromptHash = retry.caused_by[0]
      if (!originalPromptHash) return
      const originalPrompt = await ctx.store.getByHash(originalPromptHash)
      if (!originalPrompt || originalPrompt.verb !== 'turn.prompted') return
      const inboundHash = originalPrompt.caused_by[0]
      if (!inboundHash) return

      await ctx.admit({
        actor: originalPrompt.actor,
        role: 'agent',
        channel: originalPrompt.channel,
        target: originalPrompt.target,
        verb: 'turn.prompted',
        patch: { kind: 'none' },
        effect: 'pure',
        // inbound first (drive-turn reads caused_by[0]); retry hash makes it distinct.
        caused_by: [inboundHash, retry.hash],
      })
    },
  }
}
