/**
 * coord-lite — local-first coordination (no shared DB). Verifies the two properties
 * that let it work over Discord alone: (1) every peer elects the SAME actor from the
 * same input, and (2) folding the same events in ANY order yields the same snapshot.
 */

import { test, expect } from 'bun:test'
import {
  electOrder,
  electWinner,
  electScribe,
  foldCoord,
  applyCoordEvent,
  readyTasks,
  renderSharedContext,
  type CoordEvent,
} from '../src/coord-lite.ts'

// ─── Deterministic election ──────────────────────────────────────────────────

test('electWinner: every peer computes the same winner from the same input', () => {
  const bots = ['U_cc', 'U_dbot', 'U_alice']
  // Same eligible set + same message key → identical winner, no matter who asks.
  expect(electWinner(bots, 'msg-123')).toBe(electWinner([...bots].reverse(), 'msg-123'))
})

test('electOrder: stable ranking, deduped, total order', () => {
  const order = electOrder(['b', 'a', 'b', 'c'], 'k')
  expect(order.length).toBe(3) // deduped
  expect(electOrder(['a', 'b', 'c'], 'k')).toEqual(order) // order-independent input
})

test('electWinner: load spreads across different messages (not always one bot)', () => {
  const bots = ['U_cc', 'U_dbot', 'U_alice']
  const winners = new Set(Array.from({ length: 20 }, (_, i) => electWinner(bots, `msg-${i}`)))
  expect(winners.size).toBeGreaterThan(1) // salted by message key → not always the same
})

test('electScribe: deterministic and present-set dependent', () => {
  expect(electScribe(['a', 'b', 'c'])).toBe(electScribe(['c', 'b', 'a']))
})

// ─── Event fold ──────────────────────────────────────────────────────────────

const plan: CoordEvent[] = [
  { kind: 'task', actor: 'owner', taskId: 'T1', label: 'scan docs' },
  { kind: 'task', actor: 'owner', taskId: 'T2', label: 'fact-check', deps: ['T1'] },
  { kind: 'task', actor: 'owner', taskId: 'T3', label: 'write aligned', deps: ['T2'] },
]

test('readyTasks: only open tasks whose deps are all done', () => {
  let ctx = foldCoord('align docs', plan)
  expect(readyTasks(ctx).map(t => t.id)).toEqual(['T1']) // T2/T3 blocked
  ctx = applyCoordEvent(ctx, { kind: 'claim', taskId: 'T1', actor: 'U_d', at: '2026-06-26T10:00:00Z' })
  ctx = applyCoordEvent(ctx, { kind: 'done', taskId: 'T1', actor: 'U_d' })
  expect(readyTasks(ctx).map(t => t.id)).toEqual(['T2']) // T1 done unlocks T2
})

test('claim conflict resolves deterministically + order-independently (earliest wins)', () => {
  const claims: CoordEvent[] = [
    { kind: 'claim', taskId: 'T1', actor: 'U_late', at: '2026-06-26T10:00:05Z' },
    { kind: 'claim', taskId: 'T1', actor: 'U_early', at: '2026-06-26T10:00:01Z' },
  ]
  const a = foldCoord('g', [...plan, ...claims])
  const b = foldCoord('g', [...plan, ...claims.slice().reverse()]) // claims in opposite order
  const ownerA = a.tasks.find(t => t.id === 'T1')!.owner
  const ownerB = b.tasks.find(t => t.id === 'T1')!.owner
  expect(ownerA).toBe('U_early') // earliest claim wins
  expect(ownerA).toBe(ownerB) // convergence: order doesn't change the result
})

test('done only applies from the task owner (a stray done is ignored)', () => {
  let ctx = foldCoord('g', plan)
  ctx = applyCoordEvent(ctx, { kind: 'claim', taskId: 'T1', actor: 'U_owner', at: '2026-06-26T10:00:00Z' })
  ctx = applyCoordEvent(ctx, { kind: 'done', taskId: 'T1', actor: 'U_imposter' })
  expect(ctx.tasks.find(t => t.id === 'T1')!.status).toBe('wip') // not done — imposter ignored
})

test('renderSharedContext: compact, readable, shows status glyphs + owners', () => {
  let ctx = foldCoord('align docs', plan)
  ctx = applyCoordEvent(ctx, { kind: 'presence', actor: 'd-bot', status: 'working', last: 'scanning docs' })
  ctx = applyCoordEvent(ctx, { kind: 'claim', taskId: 'T1', actor: 'd-bot', at: '2026-06-26T10:00:00Z' })
  const out = renderSharedContext(ctx)
  expect(out).toContain('GOAL: align docs')
  expect(out).toContain('- d-bot [working] scanning docs')
  expect(out).toContain('T1 ◐ scan docs <-d-bot')
  expect(out).toContain('T3 ○ write aligned (after T2)')
})
