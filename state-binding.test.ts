/**
 * Resume bindings — local-file persistence round-trip.
 *
 * STATE_DIR is captured at module load, so we point it at a temp dir BEFORE the
 * first import of state.ts (no other test imports state.ts, so this load is the
 * only one). Dynamic import keeps that ordering explicit.
 */

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'kk-state-'))
process.env.KNOCK_KNOCK_STATE_DIR = dir
const { readSessionBinding, writeSessionBinding, clearSessionBinding } = await import('./state.ts')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a binding round-trips: absent → written → read → cleared', () => {
  expect(readSessionBinding('agentA', 'chan1')).toBeUndefined()

  writeSessionBinding('agentA', 'chan1', { runtime: 'claude-code', sessionId: 'sess-xyz' })
  expect(readSessionBinding('agentA', 'chan1')).toEqual({ runtime: 'claude-code', sessionId: 'sess-xyz' })

  clearSessionBinding('agentA', 'chan1')
  expect(readSessionBinding('agentA', 'chan1')).toBeUndefined()
})

test('bindings are isolated per agent + channel', () => {
  writeSessionBinding('agentA', 'chanX', { runtime: 'opencode', sessionId: 'a-x' })
  writeSessionBinding('agentB', 'chanX', { runtime: 'codex', sessionId: 'b-x' })
  expect(readSessionBinding('agentA', 'chanX')?.sessionId).toBe('a-x')
  expect(readSessionBinding('agentB', 'chanX')?.sessionId).toBe('b-x')
})

test('clearing an absent binding is a no-op', () => {
  expect(() => clearSessionBinding('agentA', 'nope')).not.toThrow()
})

test('a malformed binding file reads as undefined', () => {
  // writeSessionBinding always writes valid JSON; a partial object reads back
  // as undefined via the shape guard.
  writeSessionBinding('agentC', 'chanY', { runtime: 'gemini', sessionId: 'g-1' })
  expect(readSessionBinding('agentC', 'chanY')).toEqual({ runtime: 'gemini', sessionId: 'g-1' })
})
