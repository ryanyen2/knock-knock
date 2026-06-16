/**
 * resume-on-watch — turn a fired watch into an agent turn.
 *
 * A `watch.fired` interaction (admitted by the WatchSupervisor when a watch's
 * output gate matches) carries its synthesized prompt as an `external` patch
 * with `intent.args.text` — structurally identical to an inbound
 * `channel.message`. We admit a fresh `turn.prompted` pointing at the
 * `watch.fired` as its parent; `drive-turn` then reads `caused_by[0]`, sees the
 * `external`/`args.text`, and runs the adapter exactly as it would for a real
 * message. It never inspects the parent's verb, so a fire and a message are
 * interchangeable to it.
 *
 * This is the same shape `retry-on-reaction` uses to synthesize a turn from a
 * non-message event. The fire is an external-world trigger (like an owner's 🔁),
 * so it legitimately bypasses the loop-guard *decision* — the watch's own
 * TTL/max-fires bounds runaway (docs/knock-knock-watches.md §5).
 */

import type { Synchronization } from '../sync.ts'

/** Claim TTL for the cross-relay resume dedup — short, since resuming is fast. */
const WATCH_RESUME_CLAIM_TTL_MS = 30_000

export type ResumeOnWatchOpts = {
  /** This relay's unique id. With multiple relays sharing one (Postgres) ledger,
   *  a replicated `watch.fired` is seen by every relay's synchronizer; without a
   *  claim each would resume the agent. The fire's hash is identical on every
   *  relay, so they derive the same claim key and exactly one wins. Omit for a
   *  single-relay setup (the claim still works, harmlessly). */
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

      // Dedup across relays: exactly one relay resumes a given fire. A claim
      // failure must not throw the wave away silently — on a single relay it
      // would drop the resume entirely; log and proceed (better a possible
      // duplicate than a missed fire — the turn.prompted is content-addressed
      // and dedups anyway).
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
