/**
 * Distiller — pure extraction of plan / todos / decisions / files / pitfalls.
 */

import { test, expect } from 'bun:test'
import { distill } from './distill.ts'
import type { NormalizedTranscript } from './session-store.ts'

function transcript(events: NormalizedTranscript['events']): NormalizedTranscript {
  return { id: 's1', runtime: 'claude-code', cwd: '/ws', events }
}

test('distill pulls plan, todos, files, and tags', () => {
  const { brief, tags } = distill(
    transcript([
      { role: 'user', text: 'build it' },
      { role: 'assistant', text: 'We decided to use SQLite because it is simplest.' },
      { role: 'tool', tool: { name: 'ExitPlanMode', input: { plan: 'Step 1: schema\nStep 2: writes' } } },
      { role: 'tool', tool: { name: 'TodoWrite', input: { todos: [
        { content: 'schema', status: 'completed' },
        { content: 'writes', status: 'in_progress' },
        { content: 'tests', status: 'pending' },
      ] } } },
      { role: 'tool', tool: { name: 'Edit', input: { file_path: '/ws/db.ts' } } },
      { role: 'assistant', text: 'That approach turned out to deadlock under concurrency.' },
    ]),
  )

  expect(brief).toContain('## Plan')
  expect(brief).toContain('Step 1: schema')
  expect(brief).toContain('## Todos')
  expect(brief).toContain('- [x] schema')
  expect(brief).toContain('- [~] writes')
  expect(brief).toContain('- [ ] tests')
  expect(brief).toContain('## Key decisions')
  expect(brief).toContain('decided to use SQLite')
  expect(brief).toContain('## Files touched')
  expect(brief).toContain('/ws/db.ts')
  expect(brief).toContain('## Pitfalls / dead-ends')
  expect(brief).toContain('deadlock')

  expect(tags).toContain('session-import')
  expect(tags).toContain('claude-code')
  expect(tags).toContain('plan')
  expect(tags).toContain('todos')
})

test('distill uses only the LATEST plan and todo list', () => {
  const { brief } = distill(
    transcript([
      { role: 'tool', tool: { name: 'ExitPlanMode', input: { plan: 'OLD plan' } } },
      { role: 'tool', tool: { name: 'ExitPlanMode', input: { plan: 'NEW plan' } } },
      { role: 'tool', tool: { name: 'TodoWrite', input: { todos: [{ content: 'stale', status: 'pending' }] } } },
      { role: 'tool', tool: { name: 'TodoWrite', input: { todos: [{ content: 'current', status: 'completed' }] } } },
    ]),
  )
  expect(brief).toContain('NEW plan')
  expect(brief).not.toContain('OLD plan')
  expect(brief).toContain('- [x] current')
  expect(brief).not.toContain('stale')
})

test('distill falls back to recent prose when no structure is present', () => {
  const { brief, tags } = distill(
    transcript([
      { role: 'user', text: 'hey' },
      { role: 'assistant', text: 'Here is a fairly long substantive explanation of what I did in the session.' },
    ]),
  )
  expect(brief).toContain('substantive explanation')
  expect(tags).not.toContain('plan')
})

test('distill never returns an empty brief', () => {
  expect(distill(transcript([])).brief.length).toBeGreaterThan(0)
})
