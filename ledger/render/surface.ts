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
  working: '▸', // a bot is actively working (workbench header)
  doneMark: '✓', // a finished turn / executed step (workbench)
  failMark: '✗', // a failed turn / step (workbench)
  idle: '·', // separator / quiet marker
  conflict: '🔀', // two equal-role drafts collided (conflict card)
  override: '🔁', // a draft was superseded / retry (override DM, rewind)
  rewind: '⏪', // rewind the frontier (rewind reaction)
  checkpoint: '🧷', // pin a checkpoint (rewind reaction)
  stale: '⚠️', // a reply rests on invalidated knowledge (§4.6)
  // Inbound-message status reactions (traceable at a glance, persistent):
  saw: '👀', // received / working (transient, removed when the turn ends)
  done: '🏁', // turn completed (persists)
  failed: '⚠️', // turn errored / produced nothing (persists)
  stopped: '⏹', // turn was stopped by the owner (persists)
  // Owner-initiated control reaction:
  stop: '🛑', // react on a message to abort the channel's in-flight turn
  // Session sharing (owner imports a prior local coding session's context):
  session: '📥', // share-session card header / imported-context cue
} as const

// ─── §4.1 the "now working" workbench ─────────────────────────────────────────

export type WorkbenchStatus = 'working' | 'done' | 'failed'

export type WorkbenchStep = {
  tool: string
  subject?: string
  status: TurnToolCall['status']
}

export type WorkbenchEntry = {
  agent: string
  status: WorkbenchStatus
  /** Short summary of what the agent worked on this turn (the prompt). */
  stage: string
  steps: WorkbenchStep[]
  /** HH:MM of the agent's last activity. */
  lastSeen?: string
}

const STEP_GLYPH: Record<TurnToolCall['status'], string> = {
  requested: '·',
  approved: '·',
  executed: GLYPHS.doneMark,
  failed: GLYPHS.failMark,
  denied: '⛔',
}

const HEAD_GLYPH: Record<WorkbenchStatus, string> = {
  working: GLYPHS.working,
  done: GLYPHS.doneMark,
  failed: GLYPHS.failMark,
}

const MAX_STEPS = 8

/**
 * The pinned per-channel "Workbench" — a per-agent activity log. Each agent's
 * latest turn keeps its full tool-step log so the channel always shows a
 * traceable record of what happened, even after the turn finished; only the
 * header glyph and the final state line change (working… → done/failed).
 * Edited in place by the glue, so the log grows as the turn runs and then
 * stays put as the trace of that turn.
 */
export function renderWorkbench(entries: WorkbenchEntry[], updatedAt?: string): string {
  const stamp = updatedAt ? formatIsoTime(updatedAt) : ''
  const footer = stamp ? [`-# updated ${stamp}`] : []
  if (entries.length === 0) {
    return ['**Workbench**', `-# ${GLYPHS.idle} no agents active`, ...footer].join('\n')
  }
  const rank: Record<WorkbenchStatus, number> = { working: 0, failed: 1, done: 2 }
  const blocks = entries
    .slice()
    .sort((a, b) => rank[a.status] - rank[b.status] || a.agent.localeCompare(b.agent))
    .map(e => renderEntry(e))
  // `-#` subtext only renders at the start of a line, so the timestamp is its
  // own trailing line, never appended to the bold header.
  return ['**Workbench**', ...blocks, ...footer].join('\n')
}

function renderEntry(e: WorkbenchEntry): string {
  const head = `${HEAD_GLYPH[e.status]} ${e.agent}${e.stage ? ` — ${quote(e.stage, 100)}` : ''}`
  const lines = [head]
  const steps = e.steps.length > MAX_STEPS ? e.steps.slice(e.steps.length - MAX_STEPS) : e.steps
  const hidden = e.steps.length - steps.length
  if (hidden > 0) lines.push(`-#   … ${hidden} earlier step${hidden === 1 ? '' : 's'}`)
  for (const s of steps) {
    const subj = s.subject ? ` ${quote(s.subject, 60)}` : ''
    lines.push(`-#   → ${s.tool}${subj} ${STEP_GLYPH[s.status]}`)
  }
  lines.push(`-#   ${stateLine(e)}`)
  return lines.join('\n')
}

function stateLine(e: WorkbenchEntry): string {
  const at = e.lastSeen ? ` ${e.lastSeen}` : ''
  switch (e.status) {
    case 'working': {
      const pending = e.steps.some(s => s.status === 'requested' || s.status === 'approved')
      return `◆ ${pending ? 'working…' : 'replying…'}`
    }
    case 'done':
      return `${GLYPHS.doneMark} done${at}`
    case 'failed':
      return `${GLYPHS.failMark} finished with errors${at}`
  }
}

/**
 * Derive a workbench entry per agent that has worked in a channel, from the
 * Turn fold. `working` = the agent's newest turn has no reply yet; otherwise
 * `failed` if any tool failed/was denied, else `done`. `stage` is the prompt
 * text the caller resolves (the fold stores only the inbound hash) and is kept
 * for finished turns too so the trace shows what was asked. Pure.
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
    const failed = t.toolCalls.some(tc => tc.status === 'failed' || tc.status === 'denied')
    entries.push({
      agent,
      status: working ? 'working' : failed ? 'failed' : 'done',
      stage: promptText(t.inboundHash) ?? '',
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
  // The letters come from a hash sort (stable across machines), not the order
  // the drafts arrived in — say so, so 🅰 isn't misread as "the first draft".
  if (facts.branches.length > 0) {
    lines.push('')
    lines.push('-# letters are stable across machines, not arrival order')
  }
  return lines.join('\n')
}

/** A/B/C labels for conflict branches (regional-indicator glyphs). */
export const LETTERS = ['🅰', '🅱', '🅲', '🅳'] as const

// ─── session sharing: the share-a-session card ───────────────────────────────

/** 1..N labels for the session-selection card buttons. */
export const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'] as const

export type SessionCardEntry = {
  /** Session-runtime, e.g. "claude-code". */
  runtime: string
  /** Short session label (first prompt / title). */
  title?: string
  /** ISO timestamp of last activity. */
  updatedAt: string
  /** User/assistant turn count. */
  messageCount: number
}

export type SessionCardMode = 'import' | 'resume'

export type SessionCardFacts = {
  /** Discord id of the owner who may pick, or undefined. */
  ownerId?: string
  /** Recent local sessions across runtimes, newest first (already capped). */
  sessions: SessionCardEntry[]
  /** 'import' (default) distills context; 'resume' continues the live session. */
  mode?: SessionCardMode
}

/**
 * The in-channel card an owner gets after asking to share/resume a session.
 * Lists the recent local sessions; the glue attaches one numbered button per
 * entry. Body only — buttons live in AgentHost. Pure.
 */
export function renderSessionCard(facts: SessionCardFacts): string {
  const mode: SessionCardMode = facts.mode ?? 'import'
  if (facts.sessions.length === 0) {
    if (mode === 'resume') {
      return [
        `${GLYPHS.session} **No resumable session** for this agent's runtime here.`,
        '-# Resume needs a session from the same runtime. Try "share session" to import context instead.',
      ].join('\n')
    }
    return [
      `${GLYPHS.session} **No local sessions found** in this workspace.`,
      '-# Looked across Claude Code, Codex, OpenCode, and Gemini.',
    ].join('\n')
  }
  const who = facts.ownerId ? `<@${facts.ownerId}>` : 'An owner'
  const header =
    mode === 'resume'
      ? `${GLYPHS.session} **Resume a local session** — continue it live in this channel`
      : `${GLYPHS.session} **Share a local session** — import its plan & decisions here`
  const lines = [header, `-# ${who} — pick one. Only your sessions in this workspace are shown.`]
  facts.sessions.forEach((s, idx) => {
    lines.push('')
    lines.push(`${NUMBERS[idx] ?? '•'} \`${s.runtime}\`${s.title ? ` — ${quote(s.title, 80)}` : ''}`)
    lines.push(`-#   ${s.messageCount} msg${s.messageCount === 1 ? '' : 's'} · updated ${formatIsoTime(s.updatedAt)}`)
  })
  return lines.join('\n')
}

/** Terse confirmation after a session is imported into the channel. */
export function renderSessionImported(facts: { runtime: string; title?: string }): string {
  return [
    `${GLYPHS.session} **Session context imported** from \`${facts.runtime}\`${facts.title ? ` — ${quote(facts.title, 80)}` : ''}.`,
    '-# The next turn here starts from its plan, decisions, and pitfalls.',
  ].join('\n')
}

/** The distilled brief, posted into the channel on import so agents on a
 *  SEPARATE relay (their own ledger never receives the knowledge note) can still
 *  ingest it through the normal Discord feed. Mentioning the room's peers
 *  prompts them to pick it up. One message (brief capped to fit Discord). */
const POST_BRIEF_CAP = 1500

export function renderSharedContextPost(facts: {
  runtime: string
  title?: string
  brief: string
  peerMentions?: string[]
}): string {
  const head = `${GLYPHS.session} **Shared session context** from \`${facts.runtime}\`${facts.title ? ` — ${quote(facts.title, 80)}` : ''}`
  const brief =
    facts.brief.length > POST_BRIEF_CAP ? facts.brief.slice(0, POST_BRIEF_CAP - 1).trimEnd() + '…' : facts.brief
  const lines = [head, '', brief]
  const peers = (facts.peerMentions ?? []).slice(0, 5)
  if (peers.length > 0) {
    lines.push('', `-# ${peers.join(' ')} — reference context for the room; build on it, no reply needed.`)
  }
  return lines.join('\n')
}

/** Terse confirmation after a channel is bound to resume a live session. */
export function renderSessionResumed(facts: { runtime: string; title?: string }): string {
  return [
    `${GLYPHS.session} **Resuming session** on \`${facts.runtime}\`${facts.title ? ` — ${quote(facts.title, 80)}` : ''}.`,
    '-# The next turn continues that session with its full history.',
  ].join('\n')
}

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
