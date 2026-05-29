/**
 * retry-on-reaction — §4.5 (the 🔁 reaction).
 *
 * A `turn.retry` interaction (admitted by AgentHost when the owner reacts 🔁 on
 * a bot message) means "run that turn again with the same prompt." We re-admit a
 * fresh `turn.prompted` pointing at the original inbound message, with the retry
 * hash mixed into `caused_by` so the new prompt content-addresses to a *different*
 * hash than the original (otherwise the ledger would dedup it to a no-op). The
 * existing drive-turn synchronization then re-runs the adapter as usual.
 *
 * ⏪ rewind and 🧷 checkpoint are recorded as `frontier.rewind` /
 * `frontier.checkpoint` interactions by AgentHost for the audit trail; wiring
 * them into frontier-resume (model doc §6) is the next step and intentionally
 * not done here.
 */

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
        // inbound first (drive-turn reads caused_by[0]); retry hash makes this
        // a distinct interaction so it isn't deduped against the original.
        caused_by: [inboundHash, retry.hash],
      })
    },
  }
}
