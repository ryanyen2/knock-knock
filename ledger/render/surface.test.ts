/**
 * Pure tests for the §4 Discord-surface renderers. The load-bearing case here
 * is the Workbench plan block: an agent's TodoWrite list is captured as ordinary
 * tool calls in the Turn fold, and we render the *latest* list as a per-item
 * status checklist (planned ○ / in progress ◐ / done ✓) instead of one opaque
 * `→ TodoWrite ✓` step.
 */

import { test, expect } from 'bun:test'
import {
  GLYPHS,
  parseTodos,
  renderWorkbench,
  workbenchEntries,
  type WorkbenchEntry,
} from './surface.ts'
import type { TurnFoldState, TurnState, TurnToolCall } from '../concepts/turn.ts'
import { stableJson } from '../util.ts'

// ─── parseTodos ───────────────────────────────────────────────────────────────

test('parseTodos: normalizes runtime status vocabulary to our three glyphs', () => {
  const json = stableJson({
    todos: [
      { content: 'Grabbed latest', status: 'completed' },
      { content: 'Updating feed', status: 'in_progress' },
      { content: 'Update beta', status: 'pending' },
    ],
  })
  expect(parseTodos(json)).toEqual([
    { content: 'Grabbed latest', status: 'done' },
    { content: 'Updating feed', status: 'inProgress' },
    { content: 'Update beta', status: 'planned' },
  ])
})

test('parseTodos: tolerates garbage (bad json, missing todos, empty content)', () => {
  expect(parseTodos('not json')).toEqual([])
  expect(parseTodos(stableJson({}))).toEqual([])
  expect(parseTodos(stableJson({ todos: 'nope' }))).toEqual([])
  expect(parseTodos(stableJson({ todos: [{ status: 'pending' }, null, 7] }))).toEqual([])
})

test('parseTodos: unknown status falls back to planned', () => {
  expect(parseTodos(stableJson({ todos: [{ content: 'x', status: 'weird' }] }))).toEqual([
    { content: 'x', status: 'planned' },
  ])
})

// ─── workbenchEntries: plan derivation ────────────────────────────────────────

function tc(name: string, args: unknown, status: TurnToolCall['status'], hash: string): TurnToolCall {
  return { hash, name, inputJson: stableJson(args), status }
}

function turn(t: Partial<TurnState> & Pick<TurnState, 'promptHash' | 'channel' | 'agentKey'>): TurnState {
  return { toolCalls: [], startedAt: '2026-06-23T10:00:00Z', ...t }
}

test('workbenchEntries: latest TodoWrite becomes the plan; TodoWrite drops from steps', () => {
  const turns: TurnFoldState = new Map([
    [
      'p1',
      turn({
        promptHash: 'p1',
        channel: 'c1',
        agentKey: 'claude',
        toolCalls: [
          tc('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }, 'executed', 't1'),
          tc('Edit', { file_path: 'foo.ts' }, 'executed', 't2'),
          // The agent rewrites the whole list — only this newest one should show.
          tc(
            'TodoWrite',
            { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
            'executed',
            't3',
          ),
        ],
        startedAt: '2026-06-23T10:00:00Z',
      }),
    ],
  ])
  const [entry] = workbenchEntries(turns, 'c1', () => 'do the thing')
  expect(entry?.plan).toEqual([
    { content: 'a', status: 'done' },
    { content: 'b', status: 'inProgress' },
  ])
  // The Edit step survives; neither TodoWrite call appears as a step.
  expect(entry?.steps.map(s => s.tool)).toEqual(['Edit'])
})

test('workbenchEntries: no TodoWrite means no plan', () => {
  const turns: TurnFoldState = new Map([
    ['p1', turn({ promptHash: 'p1', channel: 'c1', agentKey: 'claude', toolCalls: [tc('Edit', {}, 'executed', 't1')] })],
  ])
  const [entry] = workbenchEntries(turns, 'c1', () => undefined)
  expect(entry?.plan).toBeUndefined()
})

// ─── renderWorkbench: plan block ──────────────────────────────────────────────

test('renderWorkbench: renders the plan with per-item status glyphs', () => {
  const entry: WorkbenchEntry = {
    agent: 'claude',
    status: 'working',
    stage: 'ship the feed',
    steps: [{ tool: 'Edit', subject: 'feed.ts', status: 'executed' }],
    plan: [
      { content: 'Grabbed latest', status: 'done' },
      { content: 'Updating feed', status: 'inProgress' },
      { content: 'Update beta', status: 'planned' },
    ],
  }
  const out = renderWorkbench([entry], '2026-06-23T10:30:00Z')
  expect(out).toContain(`${GLYPHS.doneMark} Grabbed latest`)
  expect(out).toContain(`${GLYPHS.inProgress} Updating feed`)
  expect(out).toContain(`${GLYPHS.planned} Update beta`)
  // The plan sits above the tool-step trace.
  expect(out.indexOf('Grabbed latest')).toBeLessThan(out.indexOf('→ Edit'))
})
