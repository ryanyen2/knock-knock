/**
 * Claude Code session reader.
 *
 * Layout: `<config>/projects/<encoded-cwd>/<session-id>.jsonl`, where `<config>`
 * is `CLAUDE_CONFIG_DIR` or `~/.claude`, and `<encoded-cwd>` is the cwd with every
 * non-alphanumeric run replaced by `-` (e.g. `/Users/r/repos/knock-knock` →
 * `-Users-r-repos-knock-knock`). The session id is the file stem (a UUID), and
 * the authoritative cwd is also stored on every JSONL line, so we verify it
 * rather than trusting the directory name alone.
 *
 * Each line is one event: `{type:'user'|'assistant', message:{content}, cwd,
 * timestamp, sessionId, …}`. We keep user/assistant prose and assistant
 * `tool_use` blocks (esp. ExitPlanMode / TodoWrite, which the distiller mines);
 * `thinking` and `tool_result` blocks are dropped.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type NormalizedTranscript,
  type SessionStore,
  type SessionSummary,
  type TranscriptEvent,
  countMessages,
  cwdMatchesWorkspace,
  deriveTitle,
  normalizeWorkspace,
  parseJsonl,
} from './session-store.ts'

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(base, 'projects')
}

/** Claude's project-dir encoding: every non-alphanumeric char → '-'. */
function encodeWorkspace(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, '-')
}

type Parsed = { cwd: string; lastTs?: string; summary?: string; events: TranscriptEvent[] }

// User "messages" that aren't a real prompt: slash-command machinery, injected
// caveats/reminders, and the relay's own envelope. Skipped when deriving a
// human title (they're what made the card read "<local-command-caveat>…").
const INJECTED_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<command-stdout>',
  '<system-reminder>',
  '<channel ',
]
// A distinctive phrase from buildPreamble (lib.ts): marks a relay-DRIVEN session
// (the bot talking to itself), as opposed to the user's own local `claude` run.
const RELAY_PREAMBLE_MARK = 'participant in a shared Discord room'

function firstUserText(events: TranscriptEvent[]): string | undefined {
  return events.find(e => e.role === 'user' && e.text)?.text
}

/** A relay-driven session has the identity preamble as its first user turn.
 *  Those are the agent's own turns — noise for sharing — so `list` drops them. */
function isRelayDriven(events: TranscriptEvent[]): boolean {
  return (firstUserText(events) ?? '').includes(RELAY_PREAMBLE_MARK)
}

function cap80(s: string): string {
  const f = s.replace(/\s+/g, ' ').trim()
  return f.length > 80 ? f.slice(0, 79) + '…' : f
}

/** A human-meaningful title, the way `claude --resume` shows one: Claude's own
 *  session summary when present, else the first real user prompt (skipping the
 *  slash-command/caveat/reminder/envelope wrappers). */
function claudeTitle(parsed: Parsed): string | undefined {
  if (parsed.summary && parsed.summary.trim()) return cap80(parsed.summary)
  for (const e of parsed.events) {
    if (e.role !== 'user' || !e.text) continue
    const t = e.text.trimStart()
    if (INJECTED_PREFIXES.some(p => t.startsWith(p))) continue
    if (t.length < 4) continue
    return cap80(t)
  }
  return deriveTitle(parsed.events) // last resort
}

/** Pull text out of a Claude content value (string or block array). */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string' && t) parts.push(t)
    }
  }
  return parts.length ? parts.join('\n') : undefined
}

function parseClaude(objs: unknown[]): Parsed {
  let cwd = ''
  let lastTs: string | undefined
  let summary: string | undefined
  const events: TranscriptEvent[] = []

  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd
    if (typeof rec.timestamp === 'string') lastTs = rec.timestamp

    const type = rec.type
    if (type === 'summary' && typeof rec.summary === 'string' && rec.summary) {
      summary = rec.summary // Claude's own generated session title (last one wins)
      continue
    }
    const message = rec.message as { role?: string; content?: unknown } | undefined
    if (type === 'user') {
      const text = textOf(message?.content)
      if (text) events.push({ role: 'user', text })
    } else if (type === 'assistant') {
      const content = message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown }
          if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            events.push({ role: 'assistant', text: b.text })
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            events.push({ role: 'tool', tool: { name: b.name, input: b.input } })
          }
        }
      } else {
        const text = textOf(content)
        if (text) events.push({ role: 'assistant', text })
      }
    }
  }
  return { cwd, lastTs, summary, events }
}

/** Candidate project dirs for a workspace: the exact encoding, plus any dir
 *  whose name extends it (a session started in a subdirectory). */
async function candidateDirs(workspace: string): Promise<string[]> {
  const root = projectsDir()
  const encoded = encodeWorkspace(workspace)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  return names
    .filter(n => n === encoded || n.startsWith(encoded + '-'))
    .map(n => join(root, n))
}

export class ClaudeCodeSessionStore implements SessionStore {
  readonly runtime = 'claude-code' as const

  async list(opts: { workspace: string; limit?: number }): Promise<SessionSummary[]> {
    const workspace = normalizeWorkspace(opts.workspace)
    const dirs = await candidateDirs(workspace)
    const out: SessionSummary[] = []
    for (const dir of dirs) {
      let files: string[]
      try {
        files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const file of files) {
        const path = join(dir, file)
        try {
          const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
          const parsed = parseClaude(parseJsonl(text))
          if (!cwdMatchesWorkspace(parsed.cwd, workspace)) continue
          if (isRelayDriven(parsed.events)) continue // the bot's own turns, not the user's session
          out.push({
            id: file.replace(/\.jsonl$/, ''),
            runtime: this.runtime,
            cwd: parsed.cwd,
            updatedAt: parsed.lastTs ?? st.mtime.toISOString(),
            title: claudeTitle(parsed),
            messageCount: countMessages(parsed.events),
          })
        } catch {
          // Unreadable file — skip it, never fail the whole listing.
        }
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
  }

  async read(id: string): Promise<NormalizedTranscript | undefined> {
    const root = projectsDir()
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      return undefined
    }
    for (const name of dirs) {
      const path = join(root, name, `${id}.jsonl`)
      try {
        const text = await readFile(path, 'utf8')
        const parsed = parseClaude(parseJsonl(text))
        return {
          id,
          runtime: this.runtime,
          cwd: parsed.cwd,
          title: claudeTitle(parsed),
          events: parsed.events,
        }
      } catch {
        // Not in this dir — keep looking.
      }
    }
    return undefined
  }
}
