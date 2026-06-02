import { test, expect } from 'bun:test'
import { mapGlyphToReaction, choiceMenuText, parseChoiceReply } from './messaging-fallback.ts'
import { GLYPHS } from './ledger/render/surface.ts'
import type { Capabilities, Choice } from './messaging-adapter.ts'

const caps = (over: Partial<Capabilities>): Capabilities => ({
  reactions: 'any',
  threads: true,
  buttons: true,
  edit: true,
  pin: true,
  dm: true,
  mentions: 'native',
  maxMessageLength: 2000,
  ...over,
})

// Telegram-ish whitelist (a representative subset of the real fixed set).
const TG = ['👍', '👎', '❤', '🔥', '🎉', '👀', '🤔', '😱', '🙏', '🏆', '📌']

// ─── mapGlyphToReaction ───────────────────────────────────────────────────────

test("reactions 'any' passes the glyph through unchanged", () => {
  expect(mapGlyphToReaction(GLYPHS.done, caps({ reactions: 'any' }))).toBe(GLYPHS.done)
  expect(mapGlyphToReaction(GLYPHS.stop, caps({ reactions: 'any' }))).toBe(GLYPHS.stop)
})

test("reactions 'none' drops every glyph (status moves to text)", () => {
  expect(mapGlyphToReaction(GLYPHS.saw, caps({ reactions: 'none' }))).toBeNull()
  expect(mapGlyphToReaction('✅', caps({ reactions: 'none' }))).toBeNull()
})

test('whitelist keeps a glyph that is already allowed', () => {
  // 👀 (saw) is in the whitelist verbatim.
  expect(mapGlyphToReaction(GLYPHS.saw, caps({ reactions: 'whitelist', reactionWhitelist: TG }))).toBe('👀')
})

test('whitelist substitutes the nearest equivalent for a disallowed glyph', () => {
  const w = caps({ reactions: 'whitelist', reactionWhitelist: TG })
  // 🏁 (done) isn't in TG → first equivalent that is: 🎉
  expect(mapGlyphToReaction(GLYPHS.done, w)).toBe('🎉')
  // ⚠️ (failed) → 👎
  expect(mapGlyphToReaction(GLYPHS.failed, w)).toBe('👎')
  // approval ✅ → 👍
  expect(mapGlyphToReaction('✅', w)).toBe('👍')
})

test('whitelist returns null when neither the glyph nor any equivalent is allowed', () => {
  // A whitelist that contains none of 🧷/📌/🙏's options.
  const w = caps({ reactions: 'whitelist', reactionWhitelist: ['❤'] })
  expect(mapGlyphToReaction(GLYPHS.checkpoint, w)).toBeNull()
})

// ─── choiceMenuText ───────────────────────────────────────────────────────────

const approve: Choice[] = [
  { id: 'appr:allow:abc', label: 'Allow', glyph: '✅', style: 'primary' },
  { id: 'appr:deny:abc', label: 'Deny', glyph: '❌', style: 'danger' },
]

test('choiceMenuText renders a 1-based numbered menu', () => {
  expect(choiceMenuText(approve)).toBe('Reply 1=Allow · 2=Deny')
})

test('choiceMenuText is empty for no choices', () => {
  expect(choiceMenuText([])).toBe('')
})

// ─── parseChoiceReply ─────────────────────────────────────────────────────────

test('parses a bare 1-based index', () => {
  expect(parseChoiceReply('1', approve)).toBe('appr:allow:abc')
  expect(parseChoiceReply('2', approve)).toBe('appr:deny:abc')
})

test('rejects an out-of-range index', () => {
  expect(parseChoiceReply('3', approve)).toBeNull()
  expect(parseChoiceReply('0', approve)).toBeNull()
})

test('matches the exact label (any case)', () => {
  expect(parseChoiceReply('Allow', approve)).toBe('appr:allow:abc')
  expect(parseChoiceReply('deny', approve)).toBe('appr:deny:abc')
})

test('matches a registered synonym', () => {
  expect(parseChoiceReply('yes', approve)).toBe('appr:allow:abc')
  expect(parseChoiceReply('no', approve)).toBe('appr:deny:abc')
  expect(parseChoiceReply('approve it', approve)).toBe('appr:allow:abc')
})

test('matches a pasted glyph', () => {
  expect(parseChoiceReply('✅', approve)).toBe('appr:allow:abc')
  expect(parseChoiceReply('❌ nope', approve)).toBe('appr:deny:abc')
})

test('resolves a selector at the head of a longer reply (n <code> shape)', () => {
  expect(parseChoiceReply('n a1b2c', approve)).toBe('appr:deny:abc')
  expect(parseChoiceReply('2 because it edits prod', approve)).toBe('appr:deny:abc')
})

test('returns null for ambiguous prose', () => {
  expect(parseChoiceReply('hmm let me think about it', approve)).toBeNull()
  expect(parseChoiceReply('', approve)).toBeNull()
})

test('handles multi-word labels by first word (conflict card Take A / Take B)', () => {
  const conflict: Choice[] = [
    { id: 'cflt:take:0', label: 'Take A' },
    { id: 'cflt:take:1', label: 'Take B' },
    { id: 'cflt:write', label: 'Write my own' },
  ]
  expect(parseChoiceReply('1', conflict)).toBe('cflt:take:0')
  expect(parseChoiceReply('Take B', conflict)).toBe('cflt:take:1')
  expect(parseChoiceReply('write', conflict)).toBe('cflt:write')
  expect(parseChoiceReply('mine', conflict)).toBe('cflt:write')
})
