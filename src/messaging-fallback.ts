/**
 * messaging-fallback — the pure capability-degradation layer. When a platform
 * lacks an affordance knock-knock leans on (arbitrary reactions, inline buttons),
 * these pure functions decide the graceful fallback. No I/O, no SDK — the same
 * "pure decision logic" discipline as lib.ts and ledger/render/, so an adapter's
 * degradation is unit-testable without a live platform.
 *
 * Three jobs:
 *  1. mapGlyphToReaction — a project glyph → the nearest reaction the platform
 *     actually permits (or null → skip; status lives in text instead).
 *  2. choiceMenuText — render an interactive prompt's options as a numbered text
 *     menu when the platform has no buttons.
 *  3. parseChoiceReply — turn a user's free-text reply ("2", "deny", "take a")
 *     back into the chosen Choice.id, so a bare platform still drives the ledger.
 */

import type { Capabilities, Choice, Glyph, OutgoingFile } from './messaging-adapter.ts'
import { GLYPHS } from './ledger/render/surface.ts'

/**
 * Nearest widely-supported reaction for each project glyph, used when a platform
 * restricts reactions to a whitelist (Telegram) and the exact glyph isn't in it.
 * Values are deliberately common emoji that appear in every major whitelist;
 * the lookup still intersects with the platform's actual `reactionWhitelist`.
 */
const REACTION_EQUIVALENT: Record<Glyph, Glyph[]> = {
  [GLYPHS.saw]: ['👀', '👍'], // received / working
  [GLYPHS.done]: ['🎉', '👍', '🏆'], // turn completed
  [GLYPHS.failed]: ['👎', '😱'], // turn errored (⚠️)
  [GLYPHS.stopped]: ['👎', '🤔'], // turn stopped
  [GLYPHS.stop]: ['👎'], // owner stop control
  [GLYPHS.override]: ['🔥', '👍'], // retry / override (🔁)
  [GLYPHS.rewind]: ['🔥'], // ⏪
  [GLYPHS.checkpoint]: ['📌', '🙏'], // 🧷
  '✅': ['👍', '🎉'], // approve
  '❌': ['👎'], // deny
}

/**
 * Map a project glyph onto a reaction the platform will accept, or null to skip.
 *  - reactions: 'any'       → the glyph unchanged.
 *  - reactions: 'none'      → null (status conveyed in message text instead).
 *  - reactions: 'whitelist' → the glyph if allowed, else the first equivalent in
 *    the whitelist, else null.
 */
export function mapGlyphToReaction(glyph: Glyph, caps: Capabilities): Glyph | null {
  if (caps.reactions === 'none') return null
  if (caps.reactions === 'any') return glyph
  // whitelist
  const allowed = caps.reactionWhitelist ?? []
  const allow = new Set(allowed)
  if (allow.has(glyph)) return glyph
  for (const alt of REACTION_EQUIVALENT[glyph] ?? []) {
    if (allow.has(alt)) return alt
  }
  return null
}

// ─── Inbound reactions (the inverse of mapGlyphToReaction) ────────────────────
//
// A user reacting ✅/🛑/🔁 etc. is a *control* signal the host acts on, and the
// host compares against the project glyph vocabulary. So each adapter must
// normalize its platform-native incoming reaction code BACK to a project glyph
// before surfacing it. Outbound mapGlyphToReaction is lossy (several glyphs share
// one equivalent), so it is not invertible — inbound needs its own explicit map.
// A reaction that isn't a control glyph normalizes to undefined and is ignored.

/** The reserved control reactions the host acts on inbound: approve/deny, owner
 *  stop, retry/override, rewind, checkpoint. (Session sharing uses a button, not
 *  a reaction, so 📥 is not here.) */
export const CONTROL_REACTIONS: readonly Glyph[] = [
  '✅',
  '❌',
  GLYPHS.stop,
  GLYPHS.override,
  GLYPHS.rewind,
  GLYPHS.checkpoint,
]

const CONTROL_SET = new Set<string>(CONTROL_REACTIONS)

/**
 * Normalize a unicode incoming reaction to a project control glyph, or undefined
 * if it isn't one the host acts on. For platforms that surface reactions as
 * unicode (Discord delivers the raw emoji).
 */
export function normalizeUnicodeReaction(raw: string): Glyph | undefined {
  return CONTROL_SET.has(raw) ? (raw as Glyph) : undefined
}

/**
 * Render an interactive prompt's choices as a one-line numbered text menu, for
 * platforms without buttons. Indices are 1-based to match how a human counts.
 *   choiceMenuText([{label:'Allow'},{label:'Deny'}]) → "Reply 1=Allow · 2=Deny"
 */
export function choiceMenuText(choices: Choice[]): string {
  if (choices.length === 0) return ''
  const parts = choices.map((c, i) => `${i + 1}=${c.label}`)
  return `Reply ${parts.join(' · ')}`
}

/** Built-in synonyms so common verbs resolve even when a user doesn't type the
 *  exact label or number. Keys are lowercased; matched against the choice's
 *  label/first-word. */
const SYNONYMS: Record<string, string[]> = {
  allow: ['allow', 'yes', 'y', 'ok', 'okay', 'approve', 'approved', 'accept', 'go'],
  deny: ['deny', 'no', 'n', 'reject', 'denied', 'block', 'stop', 'cancel'],
  cancel: ['cancel', 'nevermind', 'nvm', 'abort'],
  write: ['write', 'mine', 'own', 'custom'],
  retry: ['retry', 'again', 'redo'],
}

/** Normalize a token for comparison: lowercase, strip surrounding punctuation. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * Parse a free-text reply into the chosen Choice.id, or null if nothing matches.
 * Resolution order (first hit wins):
 *  1. a bare 1-based index ("2")
 *  2. an exact glyph match (the user pasted the choice's emoji)
 *  3. the label, its first word, or a registered synonym ("deny", "take a")
 * Only the FIRST whitespace-delimited token is considered for 1–2 so a longer
 * sentence that happens to start with a selector still resolves (the
 * Claude-channels "n <code>" shape), while ambiguous prose returns null.
 */
export function parseChoiceReply(text: string, choices: Choice[]): string | null {
  if (choices.length === 0) return null
  const trimmed = text.trim()
  const firstTok = norm(trimmed.split(/\s+/)[0] ?? '')

  // 1. bare 1-based index
  if (/^\d+$/.test(firstTok)) {
    const idx = Number(firstTok) - 1
    if (idx >= 0 && idx < choices.length) return choices[idx]!.id
    return null
  }

  // 2. exact glyph
  for (const c of choices) {
    if (c.glyph && trimmed.startsWith(c.glyph)) return c.id
  }

  const whole = norm(trimmed)

  // 3. exact full label ("take b", "write my own", "allow") — most specific, so
  //    it wins over the leading-word match below (which can't tell A from B).
  for (const c of choices) {
    if (whole === norm(c.label)) return c.id
  }

  // 4. a single-word label as the first token ("allow please" → Allow)
  for (const c of choices) {
    const label = norm(c.label)
    if (!label.includes(' ') && firstTok === label) return c.id
  }

  // 5. synonym buckets keyed by the choice's leading word ("yes" → Allow)
  for (const c of choices) {
    const labelHead = norm(c.label).split(/\s+/)[0] ?? ''
    const bucket = SYNONYMS[labelHead]
    if (bucket && (bucket.includes(firstTok) || bucket.includes(whole))) return c.id
  }

  // 6. an UNAMBIGUOUS leading word ("write" → Write my own; "take" stays null
  //    when two choices share it)
  const headMatches = choices.filter(c => (norm(c.label).split(/\s+/)[0] ?? '') === firstTok)
  if (headMatches.length === 1) return headMatches[0]!.id

  return null
}

// ─── Outbound files (capability degradation) ──────────────────────────────────

/**
 * When a platform can't accept outbound files (`Capabilities.files.outbound` is
 * false/absent), produce a short text notice naming the withheld files so the
 * share isn't silently dropped — or null when the platform handles files
 * natively (the adapter attaches them) or there's nothing to attach.
 */
export function outboundFileNotice(
  files: Pick<OutgoingFile, 'name'>[],
  caps: Capabilities,
): string | null {
  if (caps.files?.outbound) return null
  if (!files || files.length === 0) return null
  const names = files.map(f => f.name).join(', ')
  return files.length === 1
    ? `(attachment "${names}" omitted — this platform can't receive files)`
    : `(attachments omitted — this platform can't receive files: ${names})`
}
