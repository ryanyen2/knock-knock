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
  parseChoiceReply,
} from '../src/messaging-fallback.ts'
import type { Choice } from '../src/messaging-adapter.ts'
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

// ─── parseChoiceReply against the real control-prompt shapes ──────────────────
// These are the choice sets the host's text-reply fallback resolves on platforms
// without buttons/usable reactions — the contract that wiring depends on.

test('parseChoiceReply: an approval prompt resolves by word, number, or glyph', () => {
  const choices: Choice[] = [
    { id: 'appr:allow:abc123', label: 'Allow', glyph: '✅', style: 'primary' },
    { id: 'appr:deny:abc123', label: 'Deny', glyph: '❌', style: 'danger' },
  ]
  expect(parseChoiceReply('allow', choices)).toBe('appr:allow:abc123')
  expect(parseChoiceReply('yes please', choices)).toBe('appr:allow:abc123')
  expect(parseChoiceReply('2', choices)).toBe('appr:deny:abc123')
  expect(parseChoiceReply('❌', choices)).toBe('appr:deny:abc123')
  expect(parseChoiceReply('what is this doing?', choices)).toBeNull()
})

test('parseChoiceReply: a conflict card resolves take A/B/write', () => {
  const choices: Choice[] = [
    { id: 'cflt:take:0', label: 'Take A', glyph: '🅰', style: 'neutral' },
    { id: 'cflt:take:1', label: 'Take B', glyph: '🅱', style: 'neutral' },
    { id: 'cflt:write', label: 'Write my own', glyph: '✏️', style: 'primary' },
  ]
  expect(parseChoiceReply('take b', choices)).toBe('cflt:take:1')
  expect(parseChoiceReply('1', choices)).toBe('cflt:take:0')
  expect(parseChoiceReply('write', choices)).toBe('cflt:write')
})

test('parseChoiceReply: a session card resolves pick N or cancel', () => {
  const choices: Choice[] = [
    { id: 'sess:pick:0', label: '1', glyph: '1️⃣', style: 'neutral' },
    { id: 'sess:pick:1', label: '2', glyph: '2️⃣', style: 'neutral' },
    { id: 'sess:cancel', label: 'Cancel', style: 'neutral' },
  ]
  expect(parseChoiceReply('1', choices)).toBe('sess:pick:0')
  expect(parseChoiceReply('cancel', choices)).toBe('sess:cancel')
})
