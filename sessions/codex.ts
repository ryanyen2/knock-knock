/**
 * Codex (OpenAI) session reader.
 *
 * Layout: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` rollout files (plus older flat
 * layouts). Lines are usually `payload`-wrapped: a `session_meta` line carries
 * `{cwd, id}`, and `response_item` lines carry messages
 * (`{type:'message', role, content:[{type:'input_text'|'output_text', text}]}`)
 * or `function_call`s. The format has shifted across Codex versions, so the
 * parser unwraps `payload` when present and probes the common field names —
 * anything it doesn't recognize is skipped, never fatal.
 *
 * cwd: read from `session_meta`. If a rollout has none, the session is still
 * listed (fallback) so Codex doesn't silently vanish from discovery.
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
  parseJsonl,
} from './session-store.ts'

function sessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
}

/** Recursively collect *.jsonl under a root (YYYY/MM/DD nesting). */
async function walkJsonl(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const path = join(root, e.name)
    if (e.isDirectory()) out.push(...(await walkJsonl(path, depth + 1)))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/** Unwrap a `{payload:{…}}` envelope, else return the object itself. */
function body(o: Record<string, unknown>): Record<string, unknown> {
  const p = o.payload
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : o
}

/** Text out of a Codex content value (string or {text|input_text|output_text}[]). */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string' && t) parts.push(t)
    }
  }
  return parts.length ? parts.join('\n') : undefined
}

type Parsed = { cwd: string; id?: string; lastTs?: string; events: TranscriptEvent[] }

function parseCodex(objs: unknown[]): Parsed {
  let cwd = ''
  let id: string | undefined
  let lastTs: string | undefined
  const events: TranscriptEvent[] = []

  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    if (typeof rec.timestamp === 'string') lastTs = rec.timestamp
    const b = body(rec)
    const type = (b.type ?? rec.type) as string | undefined

    if (type === 'session_meta' || b.cwd) {
      if (typeof b.cwd === 'string' && b.cwd) cwd = b.cwd
      if (typeof b.id === 'string' && b.id) id = b.id
      if (type === 'session_meta') continue
    }

    if (type === 'message' || typeof b.role === 'string') {
      const role = b.role === 'assistant' ? 'assistant' : 'user'
      const text = textOf(b.content)
      if (text) events.push({ role, text })
    } else if (type === 'function_call' || type === 'tool_call') {
      const name = (b.name ?? b.tool_name) as string | undefined
      if (typeof name === 'string') {
        let input: unknown = b.arguments ?? b.input
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            /* keep the raw string */
          }
        }
        events.push({ role: 'tool', tool: { name, input } })
      }
    }
  }
  return { cwd, id, lastTs, events }
}

export class CodexSessionStore implements SessionStore {
  readonly runtime = 'codex' as const

  async list(opts: { workspace: string; limit?: number }): Promise<SessionSummary[]> {
    const files = await walkJsonl(sessionsDir())
    const out: SessionSummary[] = []
    for (const path of files) {
      try {
        const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
        const parsed = parseCodex(parseJsonl(text))
        // Filter by cwd when known; include cwd-less rollouts as a fallback.
        if (parsed.cwd && !cwdMatchesWorkspace(parsed.cwd, opts.workspace)) continue
        const stem = path.split('/').pop()!.replace(/\.jsonl$/, '')
        out.push({
          id: parsed.id ?? stem,
          runtime: this.runtime,
          cwd: parsed.cwd,
          updatedAt: parsed.lastTs ?? st.mtime.toISOString(),
          title: deriveTitle(parsed.events),
          messageCount: countMessages(parsed.events),
        })
      } catch {
        // Skip unreadable rollouts.
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
  }

  async read(id: string): Promise<NormalizedTranscript | undefined> {
    const files = await walkJsonl(sessionsDir())
    for (const path of files) {
      const stem = path.split('/').pop()!.replace(/\.jsonl$/, '')
      try {
        const text = await readFile(path, 'utf8')
        const parsed = parseCodex(parseJsonl(text))
        if (parsed.id !== id && stem !== id) continue
        return {
          id,
          runtime: this.runtime,
          cwd: parsed.cwd,
          title: deriveTitle(parsed.events),
          events: parsed.events,
        }
      } catch {
        // Keep scanning.
      }
    }
    return undefined
  }
}
