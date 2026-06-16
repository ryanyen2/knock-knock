/**
 * Pure tests for the messaging fallback/normalization layer. Inbound reaction
 * normalization (U6) is the load-bearing one: before this, the host compared
 * unicode glyphs while Slack delivered shortcodes, so every reaction control was
 * dead off-Discord.
 */

import { test, expect } from 'bun:test'
import {
  normalizeUnicodeReaction,
  normalizeSlackReaction,
  CONTROL_REACTIONS,
  mapGlyphToReaction,
} from './messaging-fallback.ts'
import { GLYPHS } from './ledger/render/surface.ts'

// ─── normalizeUnicodeReaction (Discord / Telegram / WhatsApp) ─────────────────

test('normalizeUnicodeReaction: a control glyph passes through unchanged', () => {
  expect(normalizeUnicodeReaction('✅')).toBe('✅')
  expect(normalizeUnicodeReaction('❌')).toBe('❌')
  expect(normalizeUnicodeReaction(GLYPHS.stop)).toBe(GLYPHS.stop) // 🛑
  expect(normalizeUnicodeReaction(GLYPHS.override)).toBe(GLYPHS.override) // 🔁
  expect(normalizeUnicodeReaction(GLYPHS.rewind)).toBe(GLYPHS.rewind) // ⏪
  expect(normalizeUnicodeReaction(GLYPHS.checkpoint)).toBe(GLYPHS.checkpoint) // 🧷
})

test('normalizeUnicodeReaction: a non-control reaction is ignored (undefined)', () => {
  expect(normalizeUnicodeReaction('👍')).toBeUndefined()
  expect(normalizeUnicodeReaction('🎉')).toBeUndefined()
  expect(normalizeUnicodeReaction('')).toBeUndefined()
})

// ─── normalizeSlackReaction (the dead-reactions fix) ──────────────────────────

test('normalizeSlackReaction: shortcodes map to project control glyphs', () => {
  expect(normalizeSlackReaction('white_check_mark')).toBe('✅')
  expect(normalizeSlackReaction('heavy_check_mark')).toBe('✅')
  expect(normalizeSlackReaction('x')).toBe('❌')
  expect(normalizeSlackReaction('octagonal_sign')).toBe(GLYPHS.stop)
  expect(normalizeSlackReaction('rewind')).toBe(GLYPHS.rewind)
  expect(normalizeSlackReaction('repeat')).toBe(GLYPHS.override)
  expect(normalizeSlackReaction('safety_pin')).toBe(GLYPHS.checkpoint)
})

test('normalizeSlackReaction: an unmapped shortcode is ignored (no false approval)', () => {
  // A casual 👍 (:+1:) must NOT be read as an approval.
  expect(normalizeSlackReaction('+1')).toBeUndefined()
  expect(normalizeSlackReaction('tada')).toBeUndefined()
  expect(normalizeSlackReaction('')).toBeUndefined()
})

test('every Slack-mapped glyph is a recognized control reaction', () => {
  for (const code of ['white_check_mark', 'x', 'octagonal_sign', 'rewind', 'repeat', 'safety_pin']) {
    const glyph = normalizeSlackReaction(code)!
    expect(CONTROL_REACTIONS).toContain(glyph)
  }
})

// ─── outbound mapGlyphToReaction (regression guard for the pairing) ───────────

test('mapGlyphToReaction: none → null, any → unchanged, whitelist → equivalent', () => {
  expect(mapGlyphToReaction('✅', { reactions: 'none' } as any)).toBeNull()
  expect(mapGlyphToReaction('✅', { reactions: 'any' } as any)).toBe('✅')
  // Whitelist without the exact glyph falls back to a permitted equivalent.
  expect(
    mapGlyphToReaction(GLYPHS.stop, { reactions: 'whitelist', reactionWhitelist: ['👎'] } as any),
  ).toBe('👎')
})
