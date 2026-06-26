/** capture-presence (Problem B) — derive "who is doing what" onto the coordination
 *  board from the turn lifecycle, so awareness is free rather than manual.
 *
 *  v1 scope: `turn.prompted` → presence `working`, `turn.replied` → presence `done`.
 *  Runtime-neutral — keys on the neutral turn verbs common to every AgentAdapter,
 *  never an agent-specific output shape (`tool.*` granularity is a deferred
 *  follow-up). INSERT-only, so it converges cross-machine. */

import type { Synchronization } from '../sync.ts'
import type { Role } from '../interaction.ts'
import { coordArtifact } from '../concepts/coordination-board.ts'

export function capturePresence(): Synchronization {
  return {
    name: 'capture-presence',
    matches: i =>
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
      (i.verb === 'turn.prompted' || i.verb === 'turn.replied'),
    fire: async (i, ctx) => {
      const status = i.verb === 'turn.prompted' ? 'working' : 'done'
      await ctx.admit({
        actor: i.actor,
        role: 'agent' as Role,
        channel: i.channel,
        target: { artifactId: coordArtifact(i.channel), anchor: { kind: 'none' } },
        verb: 'coord.note',
        patch: { kind: 'coord', note: { type: 'presence', agentKey: i.actor, status, ref: i.hash } },
        effect: 'pure',
        caused_by: [i.hash],
      })
    },
  }
}
