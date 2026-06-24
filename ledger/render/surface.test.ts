/**
 * Surface render tests for the per-thread config additions: resolved-config
 * source labels, the pinned config card, and the per-turn workbench entry. Pure
 * (facts → string), like lib.test.ts — no Discord, no store.
 */

import { test, expect } from 'bun:test'
import {
  renderResolvedConfig,
  renderConfigCard,
  workbenchEntryForTurn,
  renderContextList,
} from './surface.ts'
import type { TurnFoldState, TurnState } from '../concepts/turn.ts'
import type { ChannelConfig } from '../../lib.ts'

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

function turn(partial: Partial<TurnState>): TurnState {
  return {
    promptHash: 'p1',
    channel: 'thread-1',
    agentKey: 'alice',
    inboundHash: 'in1',
    toolCalls: [],
    startedAt: '2026-06-23T10:00:00.000Z',
    ...partial,
  }
}

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
