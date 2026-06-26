/** Task-DAG concept (Problem C) — a per-scope set of delegated tasks with
 *  dependencies, folded from the log. task.* verbs use anchor:none so they're
 *  admitted applied and never gate-conflict; reassignment rides immutable INSERTs
 *  (a new task.claimed), so the board converges cross-machine without lifecycle
 *  UPDATEs. The projection (open/ready/done + owner) is the pure projectTaskDag in
 *  lib.ts; claim liveness lives in the scheduler/reconcile, not the fold. */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId, ArtifactId } from '../interaction.ts'
import { projectTaskDag, type TaskBoard, type TaskRecord, type TaskVerb } from '../../lib.ts'

export type TaskDagFoldState = ReadonlyMap<ArtifactId, TaskRecord[]>

export const TASK_DAG_FOLD = 'task-dag'

const TASK_VERBS: ReadonlySet<string> = new Set([
  'task.created',
  'task.bid',
  'task.claimed',
  'task.completed',
])

/** The task-DAG artifact for a scope. */
export function taskArtifact(scopeId: ChannelId): ArtifactId {
  return `task:channel/${scopeId}`
}

export const taskDagFold: Fold<TaskDagFoldState> = {
  name: TASK_DAG_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    TASK_VERBS.has(i.verb) &&
    i.target.artifactId.startsWith('task:'),
  step: (state, i) => {
    if (i.patch.kind !== 'task') return state
    const next = new Map(state)
    const prev = next.get(i.target.artifactId) ?? []
    next.set(i.target.artifactId, [
      ...prev,
      { verb: i.verb as TaskVerb, data: i.patch.data, createdAt: i.createdAt, hash: i.hash },
    ])
    return next
  },
}

/** Effective task board for a scope. */
export function tasksFor(state: TaskDagFoldState, scopeId: ChannelId): TaskBoard {
  return projectTaskDag(state.get(taskArtifact(scopeId)) ?? [])
}

/** Raw task records for a scope (the scheduler/bid round needs the bid ops too). */
export function taskRecordsFor(state: TaskDagFoldState, scopeId: ChannelId): TaskRecord[] {
  return state.get(taskArtifact(scopeId)) ?? []
}
