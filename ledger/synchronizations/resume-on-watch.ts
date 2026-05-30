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

export function resumeOnWatch(): Synchronization {
  return {
    name: 'resume-on-watch',
    matches: i =>
      i.verb === 'watch.fired' && (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (fired, ctx) => {
      const args = fired.patch.kind === 'external' ? (fired.patch.intent.args as { agentKey?: string }) : undefined
      const agentKey = args?.agentKey
      if (!agentKey) return // ill-formed fire — no agent to resume

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
