/**
 * §4 Discord surface — pure renderers. No store, no Discord.
 */

import { test, expect } from 'bun:test'
import {
  GLYPHS,
  NUMBERS,
  renderWorkbench,
  workbenchEntries,
  toolSubject,
  renderConflictCard,
  renderOverrideDm,
  rewindActionFor,
  renderRewindAck,
  renderSessionCard,
  renderSessionImported,
  renderSessionResumed,
  renderSharedContextPost,
} from './surface.ts'
import type { TurnFoldState, TurnState } from '../concepts/turn.ts'

// ─── §4.1 workbench ─────────────────────────────────────────────────────────

test('workbench: working agent shows step log with status glyphs', () => {
  const out = renderWorkbench(
    [
      {
        agent: 'research-bot',
        status: 'working',
        stage: 'whats the current unstaged changes about',
        steps: [
          { tool: 'Bash', subject: 'git status', status: 'executed' },
          { tool: 'Bash', subject: 'git diff', status: 'executed' },
          { tool: 'Read', subject: 'driver.ts', status: 'requested' },
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
  expect(out).toContain('◆ working…') // a step is still pending
})

test('workbench: a FINISHED turn keeps its step log + done/failed footer', () => {
  const out = renderWorkbench([
    {
      agent: 'research-bot',
      status: 'done',
      stage: 'commit and push',
      steps: [
        { tool: 'Terminal', subject: 'git add -A', status: 'executed' },
        { tool: 'Terminal', subject: 'git push', status: 'executed' },
      ],
      lastSeen: '03:28',
    },
    {
      agent: 'fail-bot',
      status: 'failed',
      stage: 'run the build',
      steps: [{ tool: 'Terminal', subject: 'bun run build', status: 'failed' }],
      lastSeen: '03:30',
    },
  ])
  // Done turn: log retained, not collapsed to a bare idle line.
  expect(out).toContain(`${GLYPHS.doneMark} research-bot — commit and push`)
  expect(out).toContain('→ Terminal git add -A ✓')
  expect(out).toContain('→ Terminal git push ✓')
  expect(out).toContain(`${GLYPHS.doneMark} done 03:28`)
  // Failed turn keeps its log too.
  expect(out).toContain(`${GLYPHS.failMark} fail-bot — run the build`)
  expect(out).toContain('finished with errors 03:30')
})

test('workbench: pending steps → working… and working sorts first', () => {
  const out = renderWorkbench([
    { agent: 'z-bot', status: 'done', stage: 'x', steps: [], lastSeen: '01:10' },
    { agent: 'a-bot', status: 'working', stage: 'y', steps: [{ tool: 'Bash', status: 'requested' }] },
  ])
  expect(out).toContain('◆ working…')
  expect(out.indexOf('a-bot')).toBeLessThan(out.indexOf('z-bot'))
})

test('workbench: caps step log and notes elided count', () => {
  const steps = Array.from({ length: 11 }, (_, i) => ({ tool: `t${i}`, status: 'executed' as const }))
  const out = renderWorkbench([{ agent: 'b', status: 'working', stage: '', steps }])
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
  expect(alice.status).toBe('working')
  expect(alice.stage).toBe('list files')
  expect(alice.steps).toEqual([{ tool: 'Bash', subject: 'ls', status: 'requested' }])
  expect(bob.status).toBe('done')
  expect(bob.lastSeen).toBe('13:42')
})

test('workbenchEntries: filters by channel', () => {
  const state: TurnFoldState = new Map([['p1', turn({ promptHash: 'p1', channel: 'other' })]])
  expect(workbenchEntries(state, 'chan-A', () => undefined)).toEqual([])
})

test('toolSubject: probes common fields, undefined on junk', () => {
  expect(toolSubject('{"command":"git status"}')).toBe('git status')
  expect(toolSubject('{"file_path":"a.ts"}')).toBe('a.ts')
  // ACP-derived subject (when rawInput is empty, the adapter synthesizes this).
  expect(toolSubject('{"subject":"git status"}')).toBe('git status')
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
  // The A/B letters are a hash sort, not arrival order — the card says so.
  expect(out).toContain('not arrival order')
})

test('conflict card: no owner falls back gracefully', () => {
  const out = renderConflictCard({ target: 'x', branches: [] })
  expect(out).toContain('An owner — pick one')
  // No branches → no letters → no ordering hint.
  expect(out).not.toContain('not arrival order')
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

test('renderSessionCard lists numbered sessions with runtime + age', () => {
  const card = renderSessionCard({
    ownerId: 'u1',
    sessions: [
      { runtime: 'claude-code', title: 'build the relay', updatedAt: '2026-05-29T14:02:00Z', messageCount: 12 },
      { runtime: 'codex', title: 'fix the parser', updatedAt: '2026-05-29T13:00:00Z', messageCount: 1 },
    ],
  })
  expect(card).toContain(GLYPHS.session)
  expect(card).toContain('<@u1>')
  expect(card).toContain(NUMBERS[0])
  expect(card).toContain('claude-code')
  expect(card).toContain('build the relay')
  expect(card).toContain('12 msgs')
  expect(card).toContain('1 msg ') // singular
})

test('renderSessionCard empty-state names the runtimes searched', () => {
  const card = renderSessionCard({ ownerId: 'u1', sessions: [] })
  expect(card).toContain('No local sessions found')
  expect(card).toContain('Claude Code')
})

test('renderSessionImported confirms the source', () => {
  const msg = renderSessionImported({ runtime: 'codex', title: 'fix the parser' })
  expect(msg).toContain(GLYPHS.session)
  expect(msg).toContain('codex')
  expect(msg).toContain('fix the parser')
})

test('renderSessionCard resume mode reads as "resume", empty-state suggests import', () => {
  const card = renderSessionCard({
    ownerId: 'u1',
    mode: 'resume',
    sessions: [{ runtime: 'claude-code', title: 'build', updatedAt: '2026-05-29T14:00:00Z', messageCount: 3 }],
  })
  expect(card).toContain('Resume a local session')

  const empty = renderSessionCard({ ownerId: 'u1', mode: 'resume', sessions: [] })
  expect(empty).toContain('No resumable session')
  expect(empty).toContain('share session')
})

test('renderSessionResumed confirms continuation with full history', () => {
  const msg = renderSessionResumed({ runtime: 'opencode', title: 'wire the relay' })
  expect(msg).toContain(GLYPHS.session)
  expect(msg).toContain('Resuming session')
  expect(msg).toContain('opencode')
})

test('renderSharedContextPost carries the brief and @mentions room peers, capped for Discord', () => {
  const post = renderSharedContextPost({
    runtime: 'claude-code',
    title: 'wire the relay',
    brief: '## Plan\nDo X then Y',
    peerMentions: ['<@111>', '<@222>'],
  })
  expect(post).toContain('Shared session context')
  expect(post).toContain('claude-code')
  expect(post).toContain('Do X then Y')
  expect(post).toContain('<@111>')
  expect(post).toContain('<@222>')

  // A long brief is truncated so the single Discord message stays under 2000.
  const big = renderSharedContextPost({ runtime: 'codex', brief: 'x'.repeat(5000) })
  expect(big.length).toBeLessThan(2000)
})
