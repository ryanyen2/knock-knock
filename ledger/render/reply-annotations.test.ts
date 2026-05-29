/**
 * §4.3 + §4.6 — pure reply-annotation renderers. No store, no fold; just the
 * visual vocabulary.
 */

import { test, expect } from 'bun:test'
import {
  renderAttributionLine,
  renderStaleFlag,
  formatIsoTime,
} from './reply-annotations.ts'

test('formatIsoTime extracts HH:MM, empty on garbage', () => {
  expect(formatIsoTime('2026-05-28T14:03:09.123Z')).toBe('14:03')
  expect(formatIsoTime('not-a-date')).toBe('')
})

test('attribution: names origin, time, and tool count', () => {
  const line = renderAttributionLine({
    originActor: 'u-alice',
    originTs: '2026-05-28T14:03:00.000Z',
    toolCount: 4,
  })
  expect(line).toBe("-# — traced from @u-alice's message at 14:03 · 4 tools")
})

test('attribution: pluralization and resolver', () => {
  const one = renderAttributionLine(
    { originActor: 'u1', originTs: '2026-05-28T09:00:00Z', toolCount: 1 },
    id => (id === 'u1' ? 'alice' : id),
  )
  expect(one).toBe("-# — traced from @alice's message at 09:00 · 1 tool")
})

test('attribution: zero tools omits the tool segment', () => {
  const line = renderAttributionLine({
    originActor: 'bob',
    originTs: '2026-05-28T23:59:00Z',
    toolCount: 0,
  })
  expect(line).toBe("-# — traced from @bob's message at 23:59")
})

test('attribution: undefined facts → no line', () => {
  expect(renderAttributionLine(undefined)).toBeUndefined()
})

test('stale flag: undefined when nothing stale', () => {
  expect(renderStaleFlag([])).toBeUndefined()
})

test('stale flag: single note, singular noun', () => {
  const flag = renderStaleFlag([{ body: 'nesting limit is 8 levels' }])
  expect(flag).toContain('⚠️')
  expect(flag).toContain('1 invalidated note')
  expect(flag).toContain('“nesting limit is 8 levels”')
})

test('stale flag: truncates long bodies and counts overflow', () => {
  const long = 'x'.repeat(200)
  const flag = renderStaleFlag([
    { body: long },
    { body: 'b' },
    { body: 'c' },
    { body: 'd' },
  ])!
  expect(flag).toContain('4 invalidated notes')
  expect(flag).toContain('…') // long body truncated
  expect(flag).toContain('(+1 more)') // only 3 sampled
})
