/** resume-on-watch — admit a fresh `turn.prompted` pointing at a `watch.fired`
 *  (structurally like an inbound message). Legitimately bypasses the loop-guard
 *  decision; the watch's own TTL/max-fires bounds runaway. */

import type { Synchronization } from '../sync.ts'

/** Claim TTL for the cross-relay resume dedup. */
const WATCH_RESUME_CLAIM_TTL_MS = 30_000

export type ResumeOnWatchOpts = {
  /** This relay's id, used as the claim holder so exactly one relay resumes. */
  relayId?: string
}

export function resumeOnWatch(opts: ResumeOnWatchOpts = {}): Synchronization {
  return {
    name: 'resume-on-watch',
    matches: i =>
      i.verb === 'watch.fired' && (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (fired, ctx) => {
      const args = fired.patch.kind === 'external' ? (fired.patch.intent.args as { agentKey?: string }) : undefined
      const agentKey = args?.agentKey
      if (!agentKey) return // ill-formed fire — no agent to resume

      // Cross-relay dedup: exactly one relay resumes. On claim error, log and
      // proceed — turn.prompted is content-addressed and dedups anyway.
      if (opts.relayId) {
        try {
          const lock = await ctx.store.acquireClaim(`watchfire/${fired.hash}`, opts.relayId, WATCH_RESUME_CLAIM_TTL_MS)
          if (!lock.acquired) return
        } catch (err) {
          process.stderr.write(`resume-on-watch: claim failed for ${fired.hash.slice(0, 10)}: ${err}\n`)
        }
      }

      await ctx.admit({
        actor: agentKey,
        role: 'agent',
        channel: fired.channel,
        target: { artifactId: fired.target.artifactId, anchor: { kind: 'none' } },
        verb: 'turn.prompted',
        patch: { kind: 'none' },
        effect: 'pure',
        caused_by: [fired.hash],
      })
    },
  }
}
