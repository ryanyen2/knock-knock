/**
 * Discord surface — pure (facts) → string renderers for visual cues.
 */

import { formatIsoTime } from './reply-annotations.ts'
import type { TurnFoldState, TurnState, TurnToolCall } from '../concepts/turn.ts'
import {
  CONFIG_FIELDS,
  configFieldSpec,
  type ChannelConfig,
  type ConfigFieldSpec,
  type WorkbenchVerbosity,
} from '../../lib.ts'

/** The complete visual vocabulary — one symbol per concept. */
export const GLYPHS = {
  working: '▸',
  doneMark: '✓',
  failMark: '✗',
  idle: '·',
  planned: '○',
  inProgress: '◐',
  conflict: '🔀',
  override: '🔁',
  rewind: '⏪',
  checkpoint: '🧷',
  stale: '⚠️',
  saw: '👀',
  done: '🏁',
  failed: '⚠️',
  stopped: '⏹',
  stop: '🛑',
  session: '📥',
  config: '⚙️',
} as const

// ─── the "now working" workbench ──────────────────────────────────────────────

export type WorkbenchStatus = 'working' | 'done' | 'failed'

export type WorkbenchStep = {
  tool: string
  subject?: string
  status: TurnToolCall['status']
}

/** Lifecycle of a plan item, normalized from a TodoWrite `status`. */
export type TodoStatus = 'planned' | 'inProgress' | 'done'

export type WorkbenchTodo = {
  content: string
  status: TodoStatus
}

export type WorkbenchEntry = {
  agent: string
  status: WorkbenchStatus
  /** Short summary of what the agent worked on this turn (the prompt). */
  stage: string
  steps: WorkbenchStep[]
  /** The agent's current plan (latest TodoWrite list this turn), if any. */
  plan?: WorkbenchTodo[]
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

const TODO_GLYPH: Record<TodoStatus, string> = {
  planned: GLYPHS.planned,
  inProgress: GLYPHS.inProgress,
  done: GLYPHS.doneMark,
}

const MAX_STEPS = 8
const MAX_TODOS = 12

/** The agent's planning tool — its list is rendered as a plan block, not a step. */
const PLAN_TOOL = 'TodoWrite'

/** The per-channel "Workbench" — a per-agent activity log. */
export function renderWorkbench(
  entries: WorkbenchEntry[],
  updatedAt?: string,
  verbosity: WorkbenchVerbosity = 'normal',
): string {
  const stamp = updatedAt ? formatIsoTime(updatedAt) : ''
  const footer = stamp ? [`-# updated ${stamp}`] : []
  if (entries.length === 0) {
    return ['**Workbench**', `-# ${GLYPHS.idle} no agents active`, ...footer].join('\n')
  }
  const rank: Record<WorkbenchStatus, number> = { working: 0, failed: 1, done: 2 }
  const blocks = entries
    .slice()
    .sort((a, b) => rank[a.status] - rank[b.status] || a.agent.localeCompare(b.agent))
    .map(e => renderEntry(e, verbosity))
  // `-#` subtext only renders at line start, so the timestamp is its own line.
  return ['**Workbench**', ...blocks, ...footer].join('\n')
}

/** Per-verbosity cap on the tool-step lines shown. */
const STEP_CAP: Record<WorkbenchVerbosity, number> = { quiet: 0, normal: MAX_STEPS, verbose: 20 }

function renderEntry(e: WorkbenchEntry, verbosity: WorkbenchVerbosity = 'normal'): string {
  const head = `${HEAD_GLYPH[e.status]} ${e.agent}${e.stage ? ` — ${quote(e.stage, 100)}` : ''}`
  const lines = [head]
  const plan = e.plan ?? []
  const todos = plan.length > MAX_TODOS ? plan.slice(0, MAX_TODOS) : plan
  for (const t of todos) {
    lines.push(`-#   ${TODO_GLYPH[t.status]} ${quote(t.content, 80)}`)
  }
  const hiddenTodos = plan.length - todos.length
  if (hiddenTodos > 0) lines.push(`-#   … ${hiddenTodos} more planned`)
  const cap = STEP_CAP[verbosity]
  const steps = e.steps.length > cap ? e.steps.slice(e.steps.length - cap) : e.steps
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

/** Has `agentKey` worked in `channelId` (does the Turn fold hold a turn it authored there)?
 *  Drives actor-owned surfaces: a bot posts a scope's status surface only when this is true,
 *  so an idle co-resident sibling sharing the fold never becomes the visible owner. */
export function botActiveInScope(turns: TurnFoldState, channelId: string, agentKey: string): boolean {
  for (const t of turns.values()) {
    if (t.channel === channelId && t.agentKey === agentKey) return true
  }
  return false
}

/** Derive a workbench entry per agent that has worked in a channel, from the Turn fold. */
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
  for (const [, t] of latest) entries.push(entryFromTurn(t, promptText))
  return entries
}


/** Build a workbench entry from one TurnState. */
function entryFromTurn(
  t: TurnState,
  promptText: (inboundHash: string | undefined) => string | undefined,
): WorkbenchEntry {
  const working = !t.reply && !t.endedAt
  const failed = t.toolCalls.some(tc => tc.status === 'failed' || tc.status === 'denied')
  // Plan = the latest TodoWrite list; drop those calls from the step trace.
  const planCalls = t.toolCalls.filter(tc => tc.name === PLAN_TOOL)
  const plan = planCalls.length ? parseTodos(planCalls[planCalls.length - 1]!.inputJson) : undefined
  return {
    agent: t.agentKey,
    status: working ? 'working' : failed ? 'failed' : 'done',
    stage: promptText(t.inboundHash) ?? '',
    steps: t.toolCalls
      .filter(tc => tc.name !== PLAN_TOOL)
      .map(tc => ({
        tool: tc.name,
        subject: toolSubject(tc.inputJson),
        status: tc.status,
      })),
    plan: plan && plan.length ? plan : undefined,
    lastSeen: formatIsoTime(t.endedAt ?? t.startedAt),
  }
}

/** Parse a TodoWrite tool input into plan items, normalizing status to three glyphs. */
export function parseTodos(inputJson: string): WorkbenchTodo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputJson)
  } catch {
    return []
  }
  const todos = (parsed as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos)) return []
  const out: WorkbenchTodo[] = []
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const { content, status } = t as { content?: unknown; status?: unknown }
    if (typeof content !== 'string' || !content) continue
    out.push({ content, status: todoStatus(status) })
  }
  return out
}

function todoStatus(status: unknown): TodoStatus {
  if (status === 'completed' || status === 'done') return 'done'
  if (status === 'in_progress' || status === 'inProgress') return 'inProgress'
  return 'planned'
}

/** Pull the primary argument (command / path / url) out of a tool's input JSON. */
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

// ─── the conflict card ────────────────────────────────────────────────────────

export type ConflictBranch = { author: string; body: string }

export type ConflictCardFacts = {
  /** Human label for the contested artifact. */
  target: string
  /** Discord id of the owner who resolves, or undefined for none. */
  ownerId?: string
  /** The equal-role branches that tied. */
  branches: ConflictBranch[]
}

/** The in-channel card shown when the merge step holds two equal-role drafts at one anchor. */
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
  // Letters are a stable hash sort, not arrival order.
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

/** The in-channel card an owner gets after asking to share/resume a session. */
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

/** The distilled brief, posted into the channel on import so agents on a separate
 *  relay can ingest it through the normal Discord feed. */
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

// ─── the "your draft was overridden" DM ───────────────────────────────────────

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

// ─── rewind reactions ─────────────────────────────────────────────────────────

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

// ─── per-channel config (!config) ─────────────────────────────────────────────

/** Compact human form for a ms duration knob (8000 → `8s`). */
function formatDurationShort(ms: number): string {
  if (ms !== 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms !== 0 && ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function formatConfigValue(spec: ConfigFieldSpec, value: unknown): string {
  if (spec.kind === 'duration' && typeof value === 'number') return formatDurationShort(value)
  if (spec.kind === 'text' && typeof value === 'string') return quote(value, 300)
  if (spec.kind === 'token' && typeof value === 'string') return `\`${value}\``
  if (spec.kind === 'bool') return value ? 'on' : 'off'
  if (spec.kind === 'list' && Array.isArray(value)) return value.map(v => `\`${v}\``).join(', ')
  return String(value)
}

/** Help for the owner `!config` command — driven by the field registry. */
export function renderConfigHelp(): string {
  return [
    `${GLYPHS.config} **Channel config** — tune behavior (owner only)`,
    ...CONFIG_FIELDS.map(f => f.help),
    '`!config get [key]` — show the resolved overlay (thread ⊕ room)',
    '`!config reset <key>` — clear a key back to the inherited default',
    '-# In a thread, edits apply to **this thread**; `!config room <key> <val>` sets the room default for all threads.',
    '-# Identity, the allowlist, and raw permissions stay terminal-managed (`bun setup.ts`).',
  ].join('\n')
}

/** Show the current overlay for a channel — all set knobs, or one by chat key. */
export function renderConfig(cfg: ChannelConfig, key?: string): string {
  const lines = [`${GLYPHS.config} **Channel config**`]
  const fields = key ? CONFIG_FIELDS.filter(f => f.chatKey === key) : CONFIG_FIELDS
  const shown = fields.filter(f => (cfg as Record<string, unknown>)[f.field] !== undefined)
  if (shown.length === 0) {
    lines.push('-# nothing set — using the agent defaults')
    return lines.join('\n')
  }
  for (const f of shown) {
    const value = (cfg as Record<string, unknown>)[f.field]
    const rendered = formatConfigValue(f, value)
    lines.push(f.kind === 'text' ? `> ${f.chatKey}: ${rendered}` : `-# ${f.chatKey}: ${rendered}`)
  }
  return lines.join('\n')
}

/** Terse confirmation after a knob is set, echoing the stored value and target layer. */
export function renderConfigSet(field: string, value: unknown, where?: 'thread' | 'room'): string {
  const spec = configFieldSpec(field)
  const label = spec?.chatKey ?? field
  const shown = spec ? formatConfigValue(spec, value) : String(value)
  const detail = shown.length <= 64 ? `\`${shown}\`` : 'a new value'
  const scopeNote = where === 'room' ? ' for the **room** (all threads)' : where === 'thread' ? ' for **this thread**' : ''
  const lines = [
    `${GLYPHS.config} \`${label}\` set to ${detail}${scopeNote}.`,
  ]
  // mode loosens allow/ask only — the room deny and the destructive deny floor hold.
  if (field === 'permissionPreset') {
    lines.push('-# Loosens allow/ask only — the room deny and the destructive deny floor still apply.')
  }
  lines.push(`-# Takes effect on the next turn here. \`!config reset ${label}\` to clear.`)
  return lines.join('\n')
}

/** Render the resolved (room ⊕ thread) config, labeling each value's source layer. */
export function renderResolvedConfig(
  roomCfg: ChannelConfig,
  scopeCfg: ChannelConfig,
  isThread: boolean,
): string {
  if (!isThread) return renderConfig(scopeCfg)
  const lines = [`${GLYPHS.config} **Thread config** — resolved (thread ⊕ room)`]
  const rows: string[] = []
  for (const f of CONFIG_FIELDS) {
    const scopeVal = (scopeCfg as Record<string, unknown>)[f.field]
    const roomVal = (roomCfg as Record<string, unknown>)[f.field]
    const has = scopeVal !== undefined ? scopeVal : roomVal
    if (has === undefined) continue
    const src = scopeVal !== undefined ? 'thread' : 'room'
    const rendered = formatConfigValue(f, has)
    rows.push(
      f.kind === 'text'
        ? `> ${f.chatKey}: ${rendered} (${src})`
        : `-# ${f.chatKey}: ${rendered} (${src})`,
    )
  }
  if (rows.length === 0) {
    lines.push('-# nothing set — using the room/agent defaults')
    return lines.join('\n')
  }
  lines.push(...rows)
  lines.push('-# `!config <key> <val>` sets this thread; `!config room <key> <val>` sets the room default.')
  return lines.join('\n')
}

/** Terse confirmation after keys are reset to the agent default. */
export function renderConfigReset(keys: string[]): string {
  const labels = keys.map(k => configFieldSpec(k)?.chatKey ?? k)
  return [
    `${GLYPHS.config} Reset ${labels.map(k => `\`${k}\``).join(', ')} to the agent default.`,
    '-# Takes effect on the next turn here.',
  ].join('\n')
}

// ─── per-thread context surface (!context) ───────────────────────────────────

export type ContextEntry = {
  /** Provenance label, e.g. "claude-code:1a2b3c4d" or "owner-note". */
  source: string
  /** Readable snippet of the note (envelope stripped). */
  summary: string
  /** ISO timestamp the note was added. */
  when: string
  /** Discord id of who added it, when known. */
  by?: string
}

/** The owner `!context` list — active shared-context notes, stable-numbered oldest-first. */
export function renderContextList(entries: ContextEntry[]): string {
  if (entries.length === 0) {
    return [
      `${GLYPHS.session} **Thread context** — none`,
      '-# Import a session ("share session") or add a note with `!context add <text>`.',
    ].join('\n')
  }
  const lines = [
    `${GLYPHS.session} **Thread context** — ${entries.length} note${entries.length === 1 ? '' : 's'}`,
  ]
  entries.forEach((e, i) => {
    lines.push('')
    lines.push(`${i + 1}. \`${e.source}\` — ${quote(e.summary, 140)}`)
    lines.push(`-#   added ${formatIsoTime(e.when)}${e.by ? ` by <@${e.by}>` : ''}`)
  })
  lines.push('', '-# `!context add <text>` to add · `!context remove <n>` to drop one')
  return lines.join('\n')
}

/** Help for the owner `!context` command. */
export function renderContextHelp(): string {
  return [
    `${GLYPHS.session} **Thread context** — curate what this thread's turns see (owner only)`,
    '`!context` — list the active shared-context notes',
    '`!context add <text>` — append a free-form note injected once next turn',
    '`!context remove <n>` — drop the n-th note',
  ].join('\n')
}

/** Terse confirmation after a free-form context note is added. */
export function renderContextAdded(): string {
  return [
    `${GLYPHS.session} Context note added.`,
    '-# The next turn here will see it once.',
  ].join('\n')
}

/** Terse confirmation after a context note is removed, echoing its source + summary. */
export function renderContextRemoved(index: number, removed?: ContextEntry): string {
  const what = removed ? ` — \`${removed.source}\`: ${quote(removed.summary, 100)}` : ''
  return `${GLYPHS.session} Removed context note #${index}${what}. It won't be injected again.`
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Collapse whitespace and cap a quoted draft so a card stays compact. */
function quote(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Re-export so glue can format timestamps without re-importing. */
export { formatIsoTime }
