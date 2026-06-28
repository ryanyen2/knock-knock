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
  meshTaskClaimant,
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

// TTL must comfortably exceed the relay reconcile interval (15s) so a healthy
// owner's serial-reconcile renewal can't be starved past expiry and falsely fail
// over (which would let a second agent drive the same task). 60s ≈ 4 renewal cycles.
const TASK_CLAIM_TTL_MS = 60_000

// Cap new claims+wakes admitted per scheduling pass, staying well under the
// synchronizer's 16-admit wave cap (each wake is 2 admits + downstream presence).
// Excess ready tasks are picked up by the next reconcile tick — bounded and
// recovered, never a silent wave-cap drop.
const MAX_WAKES_PER_PASS = 5

// Mesh pull-claim: per-rank failover window. A window must span ≥1 reconcile tick (15s)
// so the elected claimant is given real time to claim before the next rank steps in.
const MESH_CLAIM_WINDOW_MS = 45_000

/** Mesh mode (no shared Postgres): deterministic election over the shared directory
 *  replaces the same-machine-only `acquireClaim` for pull-claim allocation. (bid is
 *  already a deterministic election via scoreBid/winningBid; push-assign already targets
 *  one agent — both converge cross-machine once `task.*` events bridge, so this gates
 *  pull-claim only.) Provided by the relay only when mesh is enabled. */
export type MeshTaskElection = {
  /** Directory bots eligible to claim in this scope (the cross-machine candidate set). */
  eligibleClaimants: (scope: ChannelId) => string[]
  windowMs?: number
}

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
  /** Return ALL local agents that serve `scope` — with co-resident bots in one room,
   *  returning only the first would let d-bot claim cc's tasks (the same-class bug as
   *  "@cc → d-bot answers"). Each context is scheduled independently; external_claim
   *  prevents double-claiming. */
  resolveSchedule: (scope: ChannelId) => ScheduleContext | ScheduleContext[] | undefined
  claimTtlMs?: number
  /** Mesh mode only: deterministic pull-claim election (no shared lock). */
  election?: MeshTaskElection
  now?: () => number
  /** Mesh mode only: true while a relay is replaying channel history on reconnect. The
   *  scheduler must NOT fire per-insert against the half-built board a replay produces — a
   *  fresh peer's large task age is exactly the failover slot the ladder hands the claim to,
   *  so it would claim+drive a task whose terminal event is later in the replay window. The
   *  host runs ONE settle pass (reconcile) on the converged ledger once replay completes. */
  suppressed?: () => boolean
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
  const resolved = deps.opts.resolveSchedule(deps.scope)
  // Normalize single/array/undefined to an array — supports both the common single-bot
  // case and co-resident multi-bot (each bot needs its own scheduling pass so it can
  // independently claim tasks; only the first would ever claim under the old shape).
  const scheds: ScheduleContext[] = !resolved ? [] : Array.isArray(resolved) ? resolved : [resolved]
  if (scheds.length === 0) return // no local agent serves this scope
  // Run a scheduling pass for each local agent independently.
  for (const sched of scheds) {
    await scheduleScopeForAgent({ ...deps, sched })
  }
}

async function scheduleScopeForAgent(deps: {
  store: Store
  engine: FoldEngine
  admit: Admit
  opts: TaskSchedulerOpts
  scope: ChannelId
  sched: ScheduleContext
  allowBidClaim?: boolean
}): Promise<void> {
  const { sched } = deps
  let state: TaskDagFoldState
  try {
    state = deps.engine.get<TaskDagFoldState>(TASK_DAG_FOLD)
  } catch {
    return // task-dag fold not registered
  }
  const records = taskRecordsFor(state, deps.scope)
  const board = projectTaskDag(records)
  const bids = bidsByTask(records)
  // task.created hash per id — the drivable parent the wake turn.prompted points at
  // (drive-turn synthesizes the prompt from the task op).
  const createdHash = new Map<string, string>()
  const createdAtById = new Map<string, string>()
  for (const r of records)
    if (r.verb === 'task.created' && !createdHash.has(r.data.id)) {
      createdHash.set(r.data.id, r.hash)
      createdAtById.set(r.data.id, r.createdAt)
    }
  const now = deps.opts.now ?? (() => Date.now())
  const policy = resolveAllocationPolicy(sched.cfg)
  const ttl = deps.opts.claimTtlMs ?? TASK_CLAIM_TTL_MS
  const art = taskArtifact(deps.scope)

  // Candidates: the open frontier (ready) PLUS claimed-not-done tasks (so the
  // owner renews and a lapsed claim can be re-taken for failover).
  const candidates = [...readyTasks(board), ...[...board.values()].filter(t => t.status === 'claimed')]

  let wakes = 0 // new claims+wakes this pass — bounded to stay under the wave cap
  for (const task of candidates) {
    const taskBids = bids.get(task.id) ?? []

    if (policy === 'bid') {
      // Submit my bid on first sight of a ready task; defer claiming to the
      // reconcile pass so peers' bids have time to land (the bid window).
      const alreadyBid = taskBids.some(b => b.bidder === sched.agentKey)
      if (task.status === 'open' && !alreadyBid) {
        if (wakes >= MAX_WAKES_PER_PASS) continue // bounded; reconcile bids the rest
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
        wakes++
        continue
      }
      if (!deps.allowBidClaim) continue // bid window still open — don't claim yet
      // Window closed: the winner claims; with no bids at all, fall back to pull.
      if (taskBids.length > 0 && winningBid(taskBids) !== sched.agentKey) continue
    } else if (!claimantFor(policy, task, sched.agentKey, taskBids)) {
      continue
    }

    const mineAlready = task.status === 'claimed' && task.owner === sched.agentKey

    // Mesh pull-claim election (no shared lock): defer to the deterministically-elected
    // claimant for the current failover window. Once any peer's claim reaches the bridged
    // board the owner is fixed, so a claimed task is never contended — no cross-machine
    // double-claim, and a live owner is never stolen. (bid/push converge on their own.)
    if (deps.opts.election && policy === 'pull-claim' && !mineAlready) {
      if (task.status === 'claimed') continue // owner fixed by a bridged task.claimed
      const eligible = deps.opts.election.eligibleClaimants(deps.scope)
      const createdAt = createdAtById.get(task.id)
      const ageMs = createdAt ? Math.max(0, now() - Date.parse(createdAt)) : 0
      const whoseTurn = meshTaskClaimant(eligible, task.id, ageMs, deps.opts.election.windowMs ?? MESH_CLAIM_WINDOW_MS)
      if (whoseTurn && whoseTurn !== sched.agentKey) continue // not my window yet
    }

    // Renewal-progress gate: don't renew my own claim if my turn is no longer live
    // (crash/stall) — let it lapse so failover can reassign.
    if (mineAlready && !sched.isTurnLive()) continue

    // Cap NEW wakes per pass (renewals below are exempt — they don't admit a wake).
    if (!mineAlready && wakes >= MAX_WAKES_PER_PASS) continue

    const claim = await deps.store.acquireClaim(taskClaimKey(deps.scope, task.id), sched.agentKey, ttl)
    if (!claim.acquired) continue // held live by another agent
    if (mineAlready) continue // renewed only — don't re-wake an in-flight turn
    wakes++

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
      // Point at the task.created op so drive-turn can synthesize the prompt and
      // actually run the owner's turn (not a dangling wake).
      caused_by: createdHash.get(task.id) ? [createdHash.get(task.id)!] : [],
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
      // Suppress per-insert scheduling during a reconnect replay — the board is half-built,
      // so claiming/driving now risks resurrecting a task whose terminal event hasn't been
      // ingested yet. The host settles once on the converged ledger after replay (reconcile).
      if (opts.suppressed?.()) return
      await scheduleScope({ store: ctx.store, engine: ctx.engine, admit: ctx.admit, opts, scope: i.channel })
    },
  }
}
