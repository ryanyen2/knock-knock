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
import type { TurnFoldState, TurnState, TurnToolCall } from '../concepts/turn.ts'

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

// ─── §4.1 the "now working" workbench ─────────────────────────────────────────

export type WorkbenchStep = {
  tool: string
  subject?: string
  status: TurnToolCall['status']
}

export type WorkbenchEntry = {
  agent: string
  working: boolean
  /** Short summary of what the agent is doing this turn (the prompt). */
  stage: string
  steps: WorkbenchStep[]
  /** HH:MM of the agent's last activity. */
  lastSeen?: string
}

const STEP_GLYPH: Record<TurnToolCall['status'], string> = {
  requested: '·',
  approved: '·',
  executed: '✓',
  failed: '✗',
  denied: '⛔',
}

const MAX_STEPS = 8

/**
 * The pinned per-channel "Workbench" — an append-style activity log rather than
 * a one-line-per-agent summary. Each working agent gets a header plus its tool
 * steps (newest underneath), with failures/denials surfaced, and a final
 * "current state" line. Idle agents collapse to one line. Edited in place by
 * the glue, so the log grows as the turn runs.
 */
export function renderWorkbench(entries: WorkbenchEntry[], updatedAt?: string): string {
  const stamp = updatedAt ? formatIsoTime(updatedAt) : ''
  const footer = stamp ? [`-# updated ${stamp}`] : []
  if (entries.length === 0) {
    return ['**Workbench**', `-# ${GLYPHS.idle} no agents active`, ...footer].join('\n')
  }
  const blocks = entries
    .slice()
    .sort((a, b) => Number(b.working) - Number(a.working) || a.agent.localeCompare(b.agent))
    .map(e => renderEntry(e))
  // `-#` subtext only renders at the start of a line, so the timestamp is its
  // own trailing line, never appended to the bold header.
  return ['**Workbench**', ...blocks, ...footer].join('\n')
}

function renderEntry(e: WorkbenchEntry): string {
  if (!e.working) {
    const seen = e.lastSeen ? ` · last seen ${e.lastSeen}` : ''
    return `${GLYPHS.idle} ${e.agent} — idle${seen}`
  }
  const lines = [`${GLYPHS.working} ${e.agent}${e.stage ? ` — ${quote(e.stage, 100)}` : ''}`]
  const steps = e.steps.length > MAX_STEPS ? e.steps.slice(e.steps.length - MAX_STEPS) : e.steps
  const hidden = e.steps.length - steps.length
  if (hidden > 0) lines.push(`-#   … ${hidden} earlier step${hidden === 1 ? '' : 's'}`)
  for (const s of steps) {
    const subj = s.subject ? ` ${quote(s.subject, 60)}` : ''
    lines.push(`-#   → ${s.tool}${subj} ${STEP_GLYPH[s.status]}`)
  }
  const pending = e.steps.some(s => s.status === 'requested' || s.status === 'approved')
  lines.push(`-#   ◆ ${pending ? 'working…' : 'replying…'}`)
  return lines.join('\n')
}

/**
 * Derive a workbench entry per agent that has worked in a channel, from the
 * Turn fold. `working` = the agent's newest turn has no reply yet. `stage` comes
 * from the prompt text the caller resolves (the fold stores only the inbound
 * hash). Pure: the glue pre-fetches prompt texts and passes them in.
 */
export function workbenchEntries(
  turns: TurnFoldState,
  channelId: string,
  promptText: (inboundHash: string | undefined) => string | undefined,
): WorkbenchEntry[] {
  const latest = new Map<string, TurnState>()
  for (const t of turns.values()) {
    if (t.channel !== channelId) continue
    const prev = latest.get(t.agentKey)
    if (!prev || t.startedAt > prev.startedAt) latest.set(t.agentKey, t)
  }
  const entries: WorkbenchEntry[] = []
  for (const [agent, t] of latest) {
    const working = !t.reply && !t.endedAt
    entries.push({
      agent,
      working,
      stage: working ? (promptText(t.inboundHash) ?? '') : '',
      steps: t.toolCalls.map(tc => ({
        tool: tc.name,
        subject: toolSubject(tc.inputJson),
        status: tc.status,
      })),
      lastSeen: formatIsoTime(t.endedAt ?? t.startedAt),
    })
  }
  return entries
}

/** Pull the primary argument (command / path / url) out of a tool's stable
 *  input JSON for a compact workbench/step line. */
export function toolSubject(inputJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputJson)
  } catch {
    return undefined
  }
  if (typeof parsed === 'string') return parsed || undefined
  if (!parsed || typeof parsed !== 'object') return undefined
  const r = parsed as Record<string, unknown>
  for (const k of ['command', 'cmd', 'script', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'subject']) {
    const v = r[k]
    if (typeof v === 'string' && v) return v
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return (v as string[]).join(' ')
  }
  return undefined
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
