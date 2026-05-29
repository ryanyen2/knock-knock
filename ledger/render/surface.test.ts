/**
 * §4 Discord surface — pure renderers. No store, no Discord.
 */

import { test, expect } from 'bun:test'
import {
  GLYPHS,
  renderPill,
  pillLinesForChannel,
  renderConflictCard,
  renderOverrideDm,
  rewindActionFor,
  renderRewindAck,
} from './surface.ts'
import type { TurnFoldState, TurnState } from '../concepts/turn.ts'

// ─── §4.1 pill ────────────────────────────────────────────────────────────────

test('pill: working and idle lines, sorted by agent', () => {
  const out = renderPill([
    { agent: 'bob-bot', working: false, detail: 'last seen 13:42' },
    { agent: 'alice-bot', working: true, detail: '3 tools' },
  ])
  const lines = out.split('\n')
  expect(lines[0]).toBe('**Workbench**')
  expect(lines[1]).toBe(`-# ${GLYPHS.working} alice-bot — 3 tools`)
  expect(lines[2]).toBe(`-# ${GLYPHS.idle} bob-bot — idle · last seen 13:42`)
})

test('pill: empty roster', () => {
  expect(renderPill([])).toContain('no agents active')
})

function turn(p: Partial<TurnState> & { promptHash: string }): TurnState {
  return {
    promptHash: p.promptHash,
    channel: p.channel ?? 'chan-A',
    agentKey: p.agentKey ?? 'alice-bot',
    toolCalls: p.toolCalls ?? [],
    reply: p.reply,
    startedAt: p.startedAt ?? '2026-05-28T13:00:00Z',
    endedAt: p.endedAt,
  }
}

test('pillLinesForChannel: in-flight turn → working with tool count', () => {
  const state: TurnFoldState = new Map([
    ['p1', turn({ promptHash: 'p1', agentKey: 'alice-bot', toolCalls: [{ hash: 't', name: 'Bash', inputJson: '{}', status: 'requested' }] })],
    ['p2', turn({ promptHash: 'p2', agentKey: 'bob-bot', endedAt: '2026-05-28T13:42:00Z', reply: { hash: 'r', text: 'done', ts: '2026-05-28T13:42:00Z' } })],
  ])
  const lines = pillLinesForChannel(state, 'chan-A')
  const alice = lines.find(l => l.agent === 'alice-bot')!
  const bob = lines.find(l => l.agent === 'bob-bot')!
  expect(alice).toEqual({ agent: 'alice-bot', working: true, detail: '1 tool' })
  expect(bob).toEqual({ agent: 'bob-bot', working: false, detail: 'last seen 13:42' })
})

test('pillLinesForChannel: filters by channel', () => {
  const state: TurnFoldState = new Map([
    ['p1', turn({ promptHash: 'p1', channel: 'other' })],
  ])
  expect(pillLinesForChannel(state, 'chan-A')).toEqual([])
})

// ─── §4.2 conflict card ───────────────────────────────────────────────────────

test('conflict card: glyph, owner mention, lettered branches', () => {
  const out = renderConflictCard({
    target: 'report.md §X',
    ownerId: 'u-alice',
    branches: [
      { author: '@bob-bot', body: 'supports 8 levels' },
      { author: '@charlie-bot', body: 'limit is 8 levels' },
    ],
  })
  expect(out).toContain(`${GLYPHS.conflict} **Two drafts arrived together** — report.md §X`)
  expect(out).toContain('<@u-alice>')
  expect(out).toContain('🅰 @bob-bot')
  expect(out).toContain('🅱 @charlie-bot')
  expect(out).toContain('> supports 8 levels')
})

test('conflict card: no owner falls back gracefully', () => {
  const out = renderConflictCard({ target: 'x', branches: [] })
  expect(out).toContain('An owner — pick one')
})

// ─── §4.4 override DM ─────────────────────────────────────────────────────────

test('override DM: glyph, channel, note, preservation note', () => {
  const out = renderOverrideDm({
    channelLabel: '#project-x',
    note: 'Your proposal ab12cd was superseded by ef34gh.',
  })
  expect(out).toContain(`${GLYPHS.override} **A draft was overridden** in #project-x`)
  expect(out).toContain('> Your proposal ab12cd was superseded')
  expect(out).toContain('preserved in the ledger')
})

// ─── §4.5 rewind ──────────────────────────────────────────────────────────────

test('rewindActionFor maps the three glyphs, ignores others', () => {
  expect(rewindActionFor(GLYPHS.rewind)).toBe('rewind')
  expect(rewindActionFor(GLYPHS.override)).toBe('retry')
  expect(rewindActionFor(GLYPHS.checkpoint)).toBe('checkpoint')
  expect(rewindActionFor('✅')).toBeUndefined()
  expect(rewindActionFor(null)).toBeUndefined()
})

test('renderRewindAck is terse subtext per action', () => {
  expect(renderRewindAck('rewind')).toContain(GLYPHS.rewind)
  expect(renderRewindAck('retry')).toContain('retrying')
  expect(renderRewindAck('checkpoint')).toContain('checkpoint pinned')
})
