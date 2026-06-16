/**
 * post-on-reply chunk-limit tests (U7). The outbound splitter must chunk at the
 * sending platform's cap, not Discord's hardcoded 1900, while staying under the
 * hard cap and never producing zero-length chunks for a tiny declared cap.
 */

import { test, expect } from 'bun:test'
import { chunkLimitFor } from './post-on-reply.ts'
import { chunk } from '../../lib.ts'

test('chunkLimitFor: applies a safety margin under the platform cap', () => {
  expect(chunkLimitFor(2000)).toBe(1900) // Discord
  expect(chunkLimitFor(3000)).toBe(2900) // Slack
  expect(chunkLimitFor(4096)).toBe(3996) // Telegram / WhatsApp
})

test('chunkLimitFor: unknown/zero cap falls back to the safe default', () => {
  expect(chunkLimitFor(undefined)).toBe(1900)
  expect(chunkLimitFor(0)).toBe(1900)
})

test('chunkLimitFor: a tiny cap is floored, never zero or negative', () => {
  expect(chunkLimitFor(50)).toBeGreaterThanOrEqual(280)
})

test('a long reply chunks at the platform width, not Discord 1900', () => {
  const text = 'x'.repeat(3500)
  // On Telegram (4096) the whole thing fits in one chunk; on Discord it would split.
  const telegram = chunk(text, chunkLimitFor(4096), 'newline')
  const discord = chunk(text, chunkLimitFor(2000), 'newline')
  expect(telegram.length).toBe(1)
  expect(discord.length).toBeGreaterThan(1)
  // No chunk exceeds its platform cap.
  expect(Math.max(...telegram.map(c => c.length))).toBeLessThanOrEqual(4096)
  expect(Math.max(...discord.map(c => c.length))).toBeLessThanOrEqual(2000)
})
