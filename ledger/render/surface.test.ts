/**
 * §4 Discord surface — pure renderers. No store, no Discord.
 */

import { test, expect } from 'bun:test'
import {
  GLYPHS,
  renderWorkbench,
  workbenchEntries,
  toolSubject,
  renderConflictCard,
  renderOverrideDm,
  rewindActionFor,
  renderRewindAck,
} from './surface.ts'
import type { TurnFoldState, TurnState } from '../concepts/turn.ts'

// ─── §4.1 workbench ─────────────────────────────────────────────────────────

test('workbench: working agent shows step log with status glyphs', () => {
  const out = renderWorkbench(
    [
      {
        agent: 'research-bot',
        working: true,
        stage: 'whats the current unstaged changes about',
        steps: [
          { tool: 'Bash', subject: 'git status', status: 'executed' },
          { tool: 'Bash', subject: 'git diff', status: 'executed' },
          { tool: 'Read', subject: 'driver.ts', status: 'failed' },
        ],
        lastSeen: '02:41',
      },
    ],
    '2026-05-28T02:41:00Z',
  )
  expect(out).toContain('**Workbench**')
  expect(out).toContain('updated 02:41')
  expect(out).toContain(`${GLYPHS.working} research-bot — whats the current unstaged changes about`)
  expect(out).toContain('→ Bash git status ✓')
  expect(out).toContain('→ Read driver.ts ✗')
  expect(out).toContain('◆ replying…') // no pending steps left
})

test('workbench: pending steps → working… ; idle agents collapse', () => {
  const out = renderWorkbench([
    { agent: 'a-bot', working: true, stage: 'x', steps: [{ tool: 'Bash', status: 'requested' }] },
    { agent: 'z-bot', working: false, stage: '', steps: [], lastSeen: '01:10' },
  ])
  expect(out).toContain('◆ working…')
  expect(out).toContain(`${GLYPHS.idle} z-bot — idle · last seen 01:10`)
  // working agent sorts above idle
  expect(out.indexOf('a-bot')).toBeLessThan(out.indexOf('z-bot'))
})

test('workbench: caps step log and notes elided count', () => {
  const steps = Array.from({ length: 11 }, (_, i) => ({ tool: `t${i}`, status: 'executed' as const }))
  const out = renderWorkbench([{ agent: 'b', working: true, stage: '', steps }])
  expect(out).toContain('… 3 earlier steps')
})

test('workbench: empty', () => {
  expect(renderWorkbench([])).toContain('no agents active')
})

function turn(p: Partial<TurnState> & { promptHash: string }): TurnState {
  return {
    promptHash: p.promptHash,
    channel: p.channel ?? 'chan-A',
    agentKey: p.agentKey ?? 'alice-bot',
    inboundHash: p.inboundHash,
    toolCalls: p.toolCalls ?? [],
    reply: p.reply,
    startedAt: p.startedAt ?? '2026-05-28T13:00:00Z',
    endedAt: p.endedAt,
  }
}

test('workbenchEntries: derives working/idle + steps from the Turn fold', () => {
  const state: TurnFoldState = new Map([
    ['p1', turn({ promptHash: 'p1', agentKey: 'alice-bot', inboundHash: 'in1', toolCalls: [{ hash: 't', name: 'Bash', inputJson: '{"command":"ls"}', status: 'requested' }] })],
    ['p2', turn({ promptHash: 'p2', agentKey: 'bob-bot', endedAt: '2026-05-28T13:42:00Z', reply: { hash: 'r', text: 'done', ts: '2026-05-28T13:42:00Z' } })],
  ])
  const entries = workbenchEntries(state, 'chan-A', h => (h === 'in1' ? 'list files' : undefined))
  const alice = entries.find(e => e.agent === 'alice-bot')!
  const bob = entries.find(e => e.agent === 'bob-bot')!
  expect(alice.working).toBe(true)
  expect(alice.stage).toBe('list files')
  expect(alice.steps).toEqual([{ tool: 'Bash', subject: 'ls', status: 'requested' }])
  expect(bob.working).toBe(false)
  expect(bob.lastSeen).toBe('13:42')
})

test('workbenchEntries: filters by channel', () => {
  const state: TurnFoldState = new Map([['p1', turn({ promptHash: 'p1', channel: 'other' })]])
  expect(workbenchEntries(state, 'chan-A', () => undefined)).toEqual([])
})

test('toolSubject: probes common fields, undefined on junk', () => {
  expect(toolSubject('{"command":"git status"}')).toBe('git status')
  expect(toolSubject('{"file_path":"a.ts"}')).toBe('a.ts')
  expect(toolSubject('"raw string"')).toBe('raw string')
  expect(toolSubject('{}')).toBeUndefined()
  expect(toolSubject('not json')).toBeUndefined()
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
