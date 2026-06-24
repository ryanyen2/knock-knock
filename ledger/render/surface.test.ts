/**
 * Pure tests for the §4 Discord-surface renderers. Two areas:
 *  - the Workbench plan block: an agent's TodoWrite list is captured as ordinary
 *    tool calls in the Turn fold, and we render the *latest* list as a per-item
 *    status checklist (planned ○ / in progress ◐ / done ✓) instead of one opaque
 *    `→ TodoWrite ✓` step;
 *  - the per-thread config additions: resolved-config source labels, the pinned
 *    config card, the per-turn workbench entry, and the context list.
 * Pure (facts → string), like lib.test.ts — no Discord, no store.
 */

import { test, expect } from 'bun:test'
import {
  GLYPHS,
  parseTodos,
  renderWorkbench,
  workbenchEntries,
  workbenchEntryForTurn,
  renderResolvedConfig,
  renderConfigCard,
  renderContextList,
  type WorkbenchEntry,
} from './surface.ts'
import type { TurnFoldState, TurnState, TurnToolCall } from '../concepts/turn.ts'
import { stableJson } from '../util.ts'
import type { ChannelConfig } from '../../lib.ts'

function tc(name: string, args: unknown, status: TurnToolCall['status'], hash: string): TurnToolCall {
  return { hash, name, inputJson: stableJson(args), status }
}

function turn(partial: Partial<TurnState> = {}): TurnState {
  return {
    promptHash: 'p1',
    channel: 'c1',
    agentKey: 'claude',
    inboundHash: 'in1',
    toolCalls: [],
    startedAt: '2026-06-23T10:00:00.000Z',
    ...partial,
  }
}

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

test('workbenchEntries: latest TodoWrite becomes the plan; TodoWrite drops from steps', () => {
  const turns: TurnFoldState = new Map([
    [
      'p1',
      turn({
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
    ['p1', turn({ toolCalls: [tc('Edit', {}, 'executed', 't1')] })],
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

// ─── per-thread config renderers ──────────────────────────────────────────────

const ROOM: ChannelConfig = { role: 'room persona', model: 'claude-room', loopMaxConsecutive: 4 }
const SCOPE: ChannelConfig = { role: 'thread persona', effort: 'max', permissionPreset: 'bypass' }

test('renderResolvedConfig: labels each value thread vs room; suppressed at top level', () => {
  const out = renderResolvedConfig(ROOM, SCOPE, true)
  expect(out).toContain('thread persona') // scope wins
  expect(out).toContain('(thread)')
  expect(out).toContain('(room)') // model inherited from room
  // a plain channel (not a thread) renders the flat view with no source labels
  const flat = renderResolvedConfig(ROOM, ROOM, false)
  expect(flat).not.toContain('(thread)')
})

test('renderConfigCard: shows resolved knobs with source + context count', () => {
  const card = renderConfigCard(ROOM, SCOPE, 2)
  expect(card).toContain('Thread setup')
  expect(card).toContain('thread persona')       // role (thread)
  expect(card).toContain('`claude-room`')        // model (room) rendered as token
  expect(card).toContain('bypass')               // mode (thread)
  expect(card).toContain('2 context notes')
})

test('renderConfigCard: pluralizes context note count', () => {
  expect(renderConfigCard({}, {}, 1)).toContain('1 context note ')
  expect(renderConfigCard({}, {}, 0)).toContain('0 context notes')
})

// ─── workbenchEntryForTurn (per-turn board) ───────────────────────────────────

test('workbenchEntryForTurn: derives status from a single turn', () => {
  const working: TurnFoldState = new Map([['p1', turn({})]])
  expect(workbenchEntryForTurn(working, 'p1', () => 'fix the bug')?.status).toBe('working')

  const done: TurnFoldState = new Map([
    ['p1', turn({ reply: { hash: 'r', text: 'done', ts: 'x' }, endedAt: 'x' })],
  ])
  expect(workbenchEntryForTurn(done, 'p1', () => 'fix the bug')?.status).toBe('done')

  const failed: TurnFoldState = new Map([
    ['p1', turn({ endedAt: 'x', toolCalls: [{ hash: 't', name: 'Bash', inputJson: '{}', status: 'failed' }] })],
  ])
  expect(workbenchEntryForTurn(failed, 'p1', () => 'x')?.status).toBe('failed')

  // a DENIED tool call (permission gate fired) is a distinct status path and also
  // marks the turn failed — exercised separately from 'failed'.
  const denied: TurnFoldState = new Map([
    ['p1', turn({ endedAt: 'x', toolCalls: [{ hash: 't', name: 'Edit', inputJson: '{}', status: 'denied' }] })],
  ])
  expect(workbenchEntryForTurn(denied, 'p1', () => 'x')?.status).toBe('failed')

  // unknown turn → undefined
  expect(workbenchEntryForTurn(new Map(), 'nope', () => undefined)).toBeUndefined()
})

test('renderContextList: numbers entries and shows the empty state', () => {
  expect(renderContextList([])).toContain('none')
  const out = renderContextList([
    { source: 'claude-code:abcd', summary: 'a plan', when: '2026-06-23T10:00:00.000Z', by: '123' },
  ])
  expect(out).toContain('1. `claude-code:abcd`')
  expect(out).toContain('a plan')
})
