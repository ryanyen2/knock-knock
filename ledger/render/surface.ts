/**
 * §4 Discord surface — pure renderers for the visual cues that surface ledger
 * state. No I/O: the synchronizations and AgentHost glue do the lookups and
 * Discord calls; everything here is a pure (facts) → string the way `lib.ts`
 * keeps decision logic pure. That makes the visual vocabulary unit-testable
 * without a Discord client.
 *
 * Design note (minimalist-ui spirit on a Discord canvas): restraint over
 * ornament — one glyph per concept, Discord subtext (`-#`) for metadata,
 * blockquotes for quoted drafts, no decorative boxes. The skill bans emojis
 * for the *web*; on Discord the project's glyph set (§9) IS the icon system,
 * so glyphs stay but are used sparingly — exactly one leads each cue.
 */

import { formatIsoTime } from './reply-annotations.ts'
import type { TurnFoldState, TurnState } from '../concepts/turn.ts'

/**
 * §9 glyph reference — the complete visual vocabulary, in one place so every
 * surface draws the same symbol for the same concept.
 */
export const GLYPHS = {
  working: '▸', // a bot is actively working (pill)
  idle: '·', // a bot is idle (pill)
  conflict: '🔀', // two equal-role drafts collided (conflict card)
  override: '🔁', // a draft was superseded / retry (override DM, rewind)
  rewind: '⏪', // rewind the frontier (rewind reaction)
  checkpoint: '🧷', // pin a checkpoint (rewind reaction)
  stale: '⚠️', // a reply rests on invalidated knowledge (§4.6)
} as const

// ─── §4.1 the "now working" pill ──────────────────────────────────────────────

export type PillLine = {
  agent: string
  working: boolean
  /** "tracing parser bug · 3 tools" when working; "last seen 14:02" when idle. */
  detail: string
}

/**
 * The single pinned per-channel status message. Each bot owns one line; the
 * line is `▸ agent — detail` while working, `· agent — idle · detail` at rest.
 */
export function renderPill(lines: PillLine[]): string {
  const head = '**Workbench**'
  if (lines.length === 0) return `${head}\n-# ${GLYPHS.idle} no agents active`
  const body = lines
    .slice()
    .sort((a, b) => a.agent.localeCompare(b.agent))
    .map(l => {
      const glyph = l.working ? GLYPHS.working : GLYPHS.idle
      const state = l.working ? l.detail : `idle${l.detail ? ` · ${l.detail}` : ''}`
      return `-# ${glyph} ${l.agent} — ${state}`
    })
    .join('\n')
  return `${head}\n${body}`
}

/**
 * Derive one pill line per agent that has worked in a channel, from the Turn
 * fold. An agent is "working" if it has a turn here with no reply yet; its
 * detail is the in-flight tool count. Otherwise it's idle, detail = last-seen
 * time of its most recent finished turn. Pure: the glue passes Turn fold state
 * straight in.
 */
export function pillLinesForChannel(
  turns: TurnFoldState,
  channelId: string,
): PillLine[] {
  // newest turn per agent + whether any of its turns is currently in flight.
  const latest = new Map<string, TurnState>()
  const working = new Map<string, TurnState>()
  for (const t of turns.values()) {
    if (t.channel !== channelId) continue
    const prevLatest = latest.get(t.agentKey)
    if (!prevLatest || t.startedAt > prevLatest.startedAt) latest.set(t.agentKey, t)
    const inFlight = !t.reply && !t.endedAt
    if (inFlight) {
      const prevWork = working.get(t.agentKey)
      if (!prevWork || t.startedAt > prevWork.startedAt) working.set(t.agentKey, t)
    }
  }
  const lines: PillLine[] = []
  for (const [agent, t] of latest) {
    const active = working.get(agent)
    if (active) {
      const n = active.toolCalls.length
      lines.push({
        agent,
        working: true,
        detail: n > 0 ? `${n} ${n === 1 ? 'tool' : 'tools'}` : 'thinking',
      })
    } else {
      const seen = formatIsoTime(t.endedAt ?? t.startedAt)
      lines.push({ agent, working: false, detail: seen ? `last seen ${seen}` : '' })
    }
  }
  return lines
}

// ─── §4.2 the conflict card ───────────────────────────────────────────────────

export type ConflictBranch = { author: string; body: string }

export type ConflictCardFacts = {
  /** Human label for the contested artifact, e.g. "report.md §X". */
  target: string
  /** Discord id of the owner who resolves, or undefined for none. */
  ownerId?: string
  /** Exactly the equal-role branches that tied. Two is the common case. */
  branches: ConflictBranch[]
}

/**
 * The in-channel card shown when the merge step holds two equal-role drafts at
 * one anchor. Buttons (Take A / Take B / Write my own) are attached by the glue
 * — this is the message body only.
 */
export function renderConflictCard(facts: ConflictCardFacts): string {
  const lines: string[] = []
  lines.push(`${GLYPHS.conflict} **Two drafts arrived together** — ${facts.target}`)
  const who = facts.ownerId ? `<@${facts.ownerId}>` : 'An owner'
  lines.push(`-# ${who} — pick one, or write the merge.`)
  facts.branches.forEach((b, idx) => {
    lines.push('')
    lines.push(`${LETTERS[idx] ?? '•'} ${b.author}`)
    lines.push(`> ${quote(b.body)}`)
  })
  return lines.join('\n')
}

/** A/B/C labels for conflict branches (regional-indicator glyphs). */
export const LETTERS = ['🅰', '🅱', '🅲', '🅳'] as const

// ─── §4.4 the "your draft was overridden" DM ──────────────────────────────────

export type OverrideDmFacts = {
  /** Human label for the channel the override happened in. */
  channelLabel: string
  /** The merge-gate inbox note body explaining the supersession. */
  note: string
}

/** A short DM to the losing agent's owner. The ledger keeps the original. */
export function renderOverrideDm(facts: OverrideDmFacts): string {
  return [
    `${GLYPHS.override} **A draft was overridden** in ${facts.channelLabel}`,
    `> ${quote(facts.note)}`,
    '-# The original is preserved in the ledger; the agent picks up the new text next turn.',
  ].join('\n')
}

// ─── §4.5 rewind reactions ────────────────────────────────────────────────────

export type RewindAction = 'rewind' | 'retry' | 'checkpoint'

/** Map a reaction glyph to its rewind action, or undefined if not one of ours. */
export function rewindActionFor(emoji: string | null | undefined): RewindAction | undefined {
  switch (emoji) {
    case GLYPHS.rewind:
      return 'rewind'
    case GLYPHS.override:
      return 'retry'
    case GLYPHS.checkpoint:
      return 'checkpoint'
    default:
      return undefined
  }
}

/** The terse confirmation reply posted when a rewind reaction is honored. */
export function renderRewindAck(action: RewindAction): string {
  switch (action) {
    case 'rewind':
      return `-# ${GLYPHS.rewind} rewound — the next prompt starts from here.`
    case 'retry':
      return `-# ${GLYPHS.override} retrying this turn…`
    case 'checkpoint':
      return `-# ${GLYPHS.checkpoint} checkpoint pinned.`
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Collapse whitespace and cap a quoted draft so a card stays compact. */
function quote(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Re-export so glue can format the pill's "last seen 14:02" without re-importing. */
export { formatIsoTime }
