/**
 * Pure tests for the messaging fallback/normalization layer. Inbound reaction
 * normalization is the load-bearing one: the host compares control glyphs, so a
 * casual 👍 must never read as an approval.
 */

import { test, expect } from 'bun:test'
import {
  normalizeUnicodeReaction,
  CONTROL_REACTIONS,
  mapGlyphToReaction,
  outboundFileNotice,
} from '../src/messaging-fallback.ts'
import { GLYPHS } from '../src/ledger/render/surface.ts'

// ─── normalizeUnicodeReaction (Discord delivers the raw emoji) ────────────────

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

test('every control glyph is a recognized control reaction', () => {
  for (const glyph of ['✅', '❌', GLYPHS.stop, GLYPHS.override, GLYPHS.rewind, GLYPHS.checkpoint]) {
    expect(CONTROL_REACTIONS).toContain(normalizeUnicodeReaction(glyph)!)
  }
})

// ─── outbound mapGlyphToReaction (the generic capability seam) ────────────────

test('mapGlyphToReaction: none → null, any → unchanged, whitelist → equivalent', () => {
  expect(mapGlyphToReaction('✅', { reactions: 'none' } as any)).toBeNull()
  expect(mapGlyphToReaction('✅', { reactions: 'any' } as any)).toBe('✅')
  // Whitelist without the exact glyph falls back to a permitted equivalent.
  expect(
    mapGlyphToReaction(GLYPHS.stop, { reactions: 'whitelist', reactionWhitelist: ['👎'] } as any),
  ).toBe('👎')
})

// ─── outboundFileNotice (U2) ──────────────────────────────────────────────────

test('outboundFileNotice: null when the platform handles files natively', () => {
  const caps = { files: { inbound: true, outbound: true, maxBytes: 1 } } as any
  expect(outboundFileNotice([{ name: 'a.pdf' }], caps)).toBeNull()
})

test('outboundFileNotice: text notice naming withheld files when outbound unsupported', () => {
  const noFiles = { files: { inbound: false, outbound: false, maxBytes: 0 } } as any
  expect(outboundFileNotice([{ name: 'a.pdf' }], noFiles)).toContain('a.pdf')
  expect(outboundFileNotice([{ name: 'a.pdf' }, { name: 'b.png' }], noFiles)).toContain('b.png')
  // absent files capability also degrades
  expect(outboundFileNotice([{ name: 'a.pdf' }], {} as any)).toContain('a.pdf')
})

test('outboundFileNotice: null when there is nothing to attach', () => {
  expect(outboundFileNotice([], {} as any)).toBeNull()
})
