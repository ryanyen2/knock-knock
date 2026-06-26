/** complete-task-on-turn (Problem C) — close the loop on a scheduler-allocated
 *  task. When a turn that the task-scheduler woke replies, mark that task done so
 *  dependents unlock and the reconcile tick stops re-waking/reassigning it (no
 *  thrash). Scoped by the caused_by chain: turn.replied → turn.prompted →
 *  task.created. Normal message-driven turns (parent is a channel.message) don't
 *  match, so this only completes scheduler-driven task turns. A crashed turn never
 *  replies, so its task is NOT completed — failover via the reconcile tick is
 *  correct. INSERT-only; task.completed dedups on content hash. */

import type { Synchronization } from '../sync.ts'
import type { Role } from '../interaction.ts'
import { taskArtifact } from '../concepts/task-dag.ts'

export function completeTaskOnTurn(): Synchronization {
  return {
    name: 'complete-task-on-turn',
    matches: i =>
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied') && i.verb === 'turn.replied',
    fire: async (replied, ctx) => {
      const promptHash = replied.caused_by[0]
      if (!promptHash) return
      const prompted = await ctx.store.getByHash(promptHash)
      const parentHash = prompted?.caused_by[0]
      if (!parentHash) return
      const parent = await ctx.store.getByHash(parentHash)
      if (!parent || parent.verb !== 'task.created' || parent.patch.kind !== 'task') return

      await ctx.admit({
        actor: replied.actor,
        role: 'agent' as Role,
        channel: replied.channel,
        target: { artifactId: taskArtifact(replied.channel), anchor: { kind: 'none' } },
        verb: 'task.completed',
        patch: { kind: 'task', data: { id: parent.patch.data.id } },
        effect: 'pure',
        caused_by: [replied.hash],
      })
    },
  }
}
