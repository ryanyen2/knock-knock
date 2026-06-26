/** complete-task-on-turn (Problem C) — close the loop on a scheduler-allocated
 *  task. When a turn that the task-scheduler woke replies, mark that task done so
 *  dependents unlock and the reconcile tick stops re-waking/reassigning it (no
 *  thrash). Scoped by the caused_by chain: turn.replied → turn.prompted →
 *  task.created. Normal message-driven turns (parent is a channel.message) don't
 *  match, so this only completes scheduler-driven task turns. A crashed turn never
 *  replies, so its task is NOT completed — failover via the reconcile tick is
 *  correct.
 *
 *  Guarded against forged/foreign completions: only the task's CURRENT OWNER's
 *  reply completes it, and an already-done task is left alone (so a hostile peer's
 *  crafted turn.replied, or a 🔁 retry, can't complete someone else's task or
 *  double-complete). INSERT-only. */

import type { Synchronization } from '../sync.ts'
import type { Role } from '../interaction.ts'
import { TASK_DAG_FOLD, taskArtifact, tasksFor, type TaskDagFoldState } from '../concepts/task-dag.ts'

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

      const taskId = parent.patch.data.id
      // Ownership + not-already-done guard: only the current owner's reply completes
      // the task, and only once. Blocks forged/foreign replies and retry re-completion.
      let board
      try {
        board = tasksFor(ctx.engine.get<TaskDagFoldState>(TASK_DAG_FOLD), replied.channel)
      } catch {
        return
      }
      const task = board.get(taskId)
      if (!task || task.status === 'done' || task.owner !== replied.actor) return

      await ctx.admit({
        actor: replied.actor,
        role: 'agent' as Role,
        channel: replied.channel,
        target: { artifactId: taskArtifact(replied.channel), anchor: { kind: 'none' } },
        verb: 'task.completed',
        patch: { kind: 'task', data: { id: taskId } },
        effect: 'pure',
        caused_by: [replied.hash],
      })
    },
  }
}
