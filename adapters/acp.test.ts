/**
 * ACP adapter — the pure session-acquisition decision. (The transport itself is
 * driven against a real ACP agent end-to-end; this isolates the branch logic.)
 */

import { test, expect } from 'bun:test'
import { planSessionAcquire } from './acp.ts'

test('no session id → create a fresh session', () => {
  expect(planSessionAcquire(undefined, new Set(), true)).toBe('create')
  expect(planSessionAcquire(undefined, new Set(), false)).toBe('create')
})

test('an already-known id (created/loaded this process) → reuse', () => {
  expect(planSessionAcquire('s1', new Set(['s1']), true)).toBe('reuse')
  expect(planSessionAcquire('s1', new Set(['s1']), false)).toBe('reuse')
})

test('a foreign id + session/load capability → load (resume)', () => {
  expect(planSessionAcquire('foreign', new Set(['other']), true)).toBe('load')
})

test('a foreign id without session/load → create (can not resume)', () => {
  expect(planSessionAcquire('foreign', new Set(['other']), false)).toBe('create')
})
