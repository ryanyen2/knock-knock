/**
 * coord-lite — local-first coordination with NO shared database.
 *
 * The transport is a Discord coordination channel everyone already sees; the
 * canonical state is folded from the messages in it, exactly like the ledger but
 * with Discord as the log. Pure decision logic only (no I/O), so it's unit-tested
 * in isolation and each machine computes identical results from identical input.
 *
 * Two ideas replace the shared-DB primitives:
 *   1. deterministic election — instead of an atomic claim, every peer computes the
 *      SAME winner from the same observable input (no lock, no race to a row).
 *   2. event log → folded snapshot — peers post one-line events; the elected scribe
 *      folds them into a pinned "shared context" everyone reads first.
 */

// ─── Deterministic election ───────────────────────────────────────────────────
// The election primitives now live in lib.ts (the canonical pure-logic home, where the
// relay imports them) — re-exported here so this experiment's tests keep one source.
export { electOrder, electWinner, electScribe } from './lib.ts'

// ─── Event log → folded shared context ────────────────────────────────────────

export type CoordEvent =
  | { kind: 'task'; actor: string; taskId: string; label: string; deps?: string[] }
  | { kind: 'claim'; actor: string; taskId: string; at: string } // at = ISO ts for deterministic tie-break
  | { kind: 'done'; actor: string; taskId: string; note?: string }
  | { kind: 'presence'; actor: string; status: ActorStatus; last?: string }
  | { kind: 'note'; actor: string; text: string }

export type ActorStatus = 'working' | 'idle' | 'done'
export type TaskStatus = 'open' | 'wip' | 'done'

export type CoordActor = { id: string; status: ActorStatus; last?: string }
export type CoordTask = {
  id: string
  label: string
  status: TaskStatus
  owner?: string
  deps: string[]
  /** internal: the winning claim's (at, actor), for order-independent convergence. */
  claim?: { at: string; by: string }
}
export type SharedContext = {
  rev: number
  goal: string
  actors: CoordActor[]
  tasks: CoordTask[]
  notes: string[]
}

const NOTES_MAX = 12

/** Fold one event into the context. Deterministic and order-independent for the
 *  fields that matter (task ownership), so two machines folding the same event set —
 *  in any order — reach the same snapshot. Pure. */
export function applyCoordEvent(ctx: SharedContext, e: CoordEvent): SharedContext {
  const tasks = ctx.tasks.map(t => ({ ...t }))
  const actors = ctx.actors.map(a => ({ ...a }))
  const notes = [...ctx.notes]
  const task = (id: string) => tasks.find(t => t.id === id)

  switch (e.kind) {
    case 'task': {
      if (!task(e.taskId)) tasks.push({ id: e.taskId, label: e.label, status: 'open', deps: e.deps ?? [] })
      break
    }
    case 'claim': {
      const t = task(e.taskId)
      if (t && t.status !== 'done') {
        const bid = { at: e.at, by: e.actor }
        // Winner = smallest (at, actor): earliest claim wins, ties broken by id. Picking
        // the min (not "first seen") makes the result independent of event order.
        if (!t.claim || bid.at < t.claim.at || (bid.at === t.claim.at && bid.by < t.claim.by)) {
          t.claim = bid
          t.owner = bid.by
          t.status = 'wip'
        }
      }
      break
    }
    case 'done': {
      const t = task(e.taskId)
      if (t && e.actor === t.owner) {
        t.status = 'done'
        if (e.note) notes.push(`${e.taskId}: ${e.note}`)
      }
      break
    }
    case 'presence': {
      const a = actors.find(x => x.id === e.actor)
      if (a) {
        a.status = e.status
        if (e.last !== undefined) a.last = e.last
      } else actors.push({ id: e.actor, status: e.status, ...(e.last ? { last: e.last } : {}) })
      break
    }
    case 'note': {
      if (!notes.includes(e.text)) notes.push(e.text)
      break
    }
  }
  // Keep notes bounded — the scribe replaces this with a real summary (compaction) once
  // it grows; here we just drop the oldest so the pin never overflows.
  while (notes.length > NOTES_MAX) notes.shift()
  return { ...ctx, actors, tasks, notes, rev: ctx.rev + 1 }
}

/** Fold an event stream into the current shared context. `rev` is the event count, so
 *  any peer that has seen the same events agrees on the version. Pure. */
export function foldCoord(goal: string, events: ReadonlyArray<CoordEvent>): SharedContext {
  let ctx: SharedContext = { rev: 0, goal, actors: [], tasks: [], notes: [] }
  for (const e of events) ctx = applyCoordEvent(ctx, e)
  return ctx
}

/** Tasks an agent may pick up now: open, with every dependency already done. Pure. */
export function readyTasks(ctx: SharedContext): CoordTask[] {
  const done = new Set(ctx.tasks.filter(t => t.status === 'done').map(t => t.id))
  return ctx.tasks.filter(t => t.status === 'open' && t.deps.every(d => done.has(d)))
}

// ─── Render the pinned "shared context" (what agents read first) ──────────────

const STATUS_GLYPH: Record<TaskStatus, string> = { open: '○', wip: '◐', done: '✓' }

/** Render the shared context as a compact, human- AND agent-readable pin. Minimal on
 *  purpose: an agent can grasp the whole picture in one glance and find what to do next. */
export function renderSharedContext(ctx: SharedContext): string {
  const lines: string[] = [`SHARED CONTEXT (rev ${ctx.rev})`, `GOAL: ${ctx.goal}`, 'WHO:']
  for (const a of ctx.actors) lines.push(`- ${a.id} [${a.status}]${a.last ? ` ${a.last}` : ''}`)
  lines.push('TASKS:')
  for (const t of ctx.tasks) {
    const dep = t.deps.length ? ` (after ${t.deps.join(',')})` : ''
    const owner = t.owner ? ` <-${t.owner}` : ''
    lines.push(`- ${t.id} ${STATUS_GLYPH[t.status]} ${t.label}${owner}${dep}`)
  }
  if (ctx.notes.length) {
    lines.push('NOTES:')
    for (const n of ctx.notes) lines.push(`- ${n}`)
  }
  return lines.join('\n')
}
