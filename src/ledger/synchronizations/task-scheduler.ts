/** task-scheduler (Problem C) — allocate ready tasks to single owners under the
 *  room's AllocationPolicy, wake them, and reassign on failure. No central
 *  scheduler: every relay runs this; external_claim makes exactly one win.
 *
 *  Two claims per task (mirrors reply-claim):
 *    - taskClaimKey  (holder = agentKey) — WHICH AGENT owns the task.
 *    - taskDriveKey  (holder = relayId)  — WHICH RELAY drives the owning agent.
 *
 *  Failover: a claimed-not-done task whose owner stops renewing (crash, or a turn
 *  that is no longer live) lets its claim lapse; the next reconcile tick re-acquires
 *  it (subject to claimantFor) and reassigns. Renewal is gated on `isTurnLive` so a
 *  dead/stalled owner does NOT keep renewing. All admits are INSERT-only (R9). */

import type { ProposedInteraction, ChannelId, Role } from '../interaction.ts'
import type { Store } from '../store.ts'
import type { FoldEngine } from '../fold.ts'
import type { AdmissionResult } from '../admit.ts'
import type { Synchronization } from '../sync.ts'
import {
  projectTaskDag,
  readyTasks,
  resolveAllocationPolicy,
  claimantFor,
  winningBid,
  scoreBid,
  taskClaimKey,
  taskDriveKey,
  type ChannelConfig,
  type Bid,
} from '../../lib.ts'
import {
  TASK_DAG_FOLD,
  taskArtifact,
  taskRecordsFor,
  type TaskDagFoldState,
} from '../concepts/task-dag.ts'

const TASK_CLAIM_TTL_MS = 30_000

/** Per-scope scheduling context the host resolves for the LOCAL agent. */
export type ScheduleContext = {
  agentKey: string
  cfg: ChannelConfig
  relayId: string
  /** Is the local agent's turn on this scope still live/progressing? Gates claim
   *  renewal: false ⇒ let the claim lapse so another claimant can fail it over. */
  isTurnLive: () => boolean
}

export type TaskSchedulerOpts = {
  resolveSchedule: (scope: ChannelId) => ScheduleContext | undefined
  claimTtlMs?: number
}

type Admit = (p: ProposedInteraction) => Promise<AdmissionResult | undefined>

function bidsByTask(records: ReturnType<typeof taskRecordsFor>): Map<string, Bid[]> {
  const m = new Map<string, Bid[]>()
  for (const r of records) {
    if (r.verb !== 'task.bid') continue
    const d = r.data
    if (!d.bidder || typeof d.utility !== 'number') continue
    const arr = m.get(d.id) ?? []
    arr.push({ bidder: d.bidder, utility: d.utility, createdAt: r.createdAt, hash: r.hash })
    m.set(d.id, arr)
  }
  return m
}

/** Core scheduling pass for one scope — shared by the sync and the reconcile timer. */
export async function scheduleScope(deps: {
  store: Store
  engine: FoldEngine
  admit: Admit
  opts: TaskSchedulerOpts
  scope: ChannelId
  /** bid policy only: false (event pass) ⇒ submit bids, don't claim yet; true
   *  (reconcile pass, after the bid window) ⇒ the winner claims, else fall back to
   *  pull when no bids arrived. Ignored by pull/push. */
  allowBidClaim?: boolean
}): Promise<void> {
  const sched = deps.opts.resolveSchedule(deps.scope)
  if (!sched) return // no local agent serves this scope

  let state: TaskDagFoldState
  try {
    state = deps.engine.get<TaskDagFoldState>(TASK_DAG_FOLD)
  } catch {
    return // task-dag fold not registered
  }
  const records = taskRecordsFor(state, deps.scope)
  const board = projectTaskDag(records)
  const bids = bidsByTask(records)
  const policy = resolveAllocationPolicy(sched.cfg)
  const ttl = deps.opts.claimTtlMs ?? TASK_CLAIM_TTL_MS
  const art = taskArtifact(deps.scope)

  // Candidates: the open frontier (ready) PLUS claimed-not-done tasks (so the
  // owner renews and a lapsed claim can be re-taken for failover).
  const candidates = [...readyTasks(board), ...[...board.values()].filter(t => t.status === 'claimed')]

  for (const task of candidates) {
    const taskBids = bids.get(task.id) ?? []

    if (policy === 'bid') {
      // Submit my bid on first sight of a ready task; defer claiming to the
      // reconcile pass so peers' bids have time to land (the bid window).
      const alreadyBid = taskBids.some(b => b.bidder === sched.agentKey)
      if (task.status === 'open' && !alreadyBid) {
        await deps.admit({
          actor: sched.agentKey,
          role: 'agent' as Role,
          channel: deps.scope,
          target: { artifactId: art, anchor: { kind: 'none' } },
          verb: 'task.bid',
          patch: {
            kind: 'task',
            data: { id: task.id, bidder: sched.agentKey, utility: scoreBid(task.id, sched.agentKey) },
          },
          effect: 'pure',
          caused_by: [],
        })
        continue
      }
      if (!deps.allowBidClaim) continue // bid window still open — don't claim yet
      // Window closed: the winner claims; with no bids at all, fall back to pull.
      if (taskBids.length > 0 && winningBid(taskBids) !== sched.agentKey) continue
    } else if (!claimantFor(policy, task, sched.agentKey, taskBids)) {
      continue
    }

    const mineAlready = task.status === 'claimed' && task.owner === sched.agentKey
    // Renewal-progress gate: don't renew my own claim if my turn is no longer live
    // (crash/stall) — let it lapse so failover can reassign.
    if (mineAlready && !sched.isTurnLive()) continue

    const claim = await deps.store.acquireClaim(taskClaimKey(deps.scope, task.id), sched.agentKey, ttl)
    if (!claim.acquired) continue // held live by another agent
    if (mineAlready) continue // renewed only — don't re-wake an in-flight turn

    // Newly acquired (fresh ready task, or reassignment of a lapsed claim): elect
    // the driving relay, then record ownership and wake the agent.
    const drive = await deps.store.acquireClaim(taskDriveKey(deps.scope, task.id, sched.agentKey), sched.relayId, ttl)
    if (!drive.acquired) continue // another relay of the same agent drives

    if (task.owner !== sched.agentKey) {
      await deps.admit({
        actor: sched.agentKey,
        role: 'agent' as Role,
        channel: deps.scope,
        target: { artifactId: art, anchor: { kind: 'none' } },
        verb: 'task.claimed',
        patch: { kind: 'task', data: { id: task.id, owner: sched.agentKey } },
        effect: 'pure',
        caused_by: [],
      })
    }
    await deps.admit({
      actor: sched.agentKey,
      role: 'agent' as Role,
      channel: deps.scope,
      target: { artifactId: art, anchor: { kind: 'none' } },
      verb: 'turn.prompted',
      patch: { kind: 'none' },
      effect: 'pure',
      caused_by: [],
    })
  }
}

/** The frontier may have changed: schedule the scope on create/complete/bid. */
export function taskScheduler(opts: TaskSchedulerOpts): Synchronization {
  return {
    name: 'task-scheduler',
    matches: i =>
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
      (i.verb === 'task.created' || i.verb === 'task.completed' || i.verb === 'task.bid'),
    fire: async (i, ctx) => {
      await scheduleScope({ store: ctx.store, engine: ctx.engine, admit: ctx.admit, opts, scope: i.channel })
    },
  }
}
