/**
 * Gemini CLI session reader.
 *
 * Layout: `~/.gemini/tmp/<project_hash>/chats/*.json`, where `<project_hash>` is
 * `sha256(projectRoot)` (Gemini CLI's `Storage.getProjectTempDir`). We compute
 * that hash from the agent's workspace, so the project filter is exact and we
 * never read another project's chats — if Gemini's hashing ever changes, the
 * reader degrades to "no Gemini sessions" rather than leaking.
 *
 * Chat files vary: an array of Gemini `Content` ({role, parts:[{text}|
 * {functionCall}]}), or an object with a `messages` array. Both are tolerated.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type NormalizedTranscript,
  type SessionStore,
  type SessionSummary,
  type TranscriptEvent,
  countMessages,
  deriveTitle,
} from './session-store.ts'

function tmpRoot(): string {
  // GEMINI_DIR overrides the base (used by some setups, and for test isolation).
  return join(process.env.GEMINI_DIR ?? join(homedir(), '.gemini'), 'tmp')
}

function projectHash(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex')
}

function chatsDirFor(workspace: string): string {
  return join(tmpRoot(), projectHash(workspace), 'chats')
}

/** Map a Gemini role token to ours. */
function roleOf(v: unknown): 'user' | 'assistant' {
  return v === 'model' || v === 'gemini' || v === 'assistant' ? 'assistant' : 'user'
}

/** Events out of a Gemini `parts` array ({text} | {functionCall:{name,args}}). */
function partsToEvents(role: 'user' | 'assistant', parts: unknown[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (typeof p.text === 'string' && p.text) {
      events.push({ role, text: p.text })
    } else if (p.functionCall && typeof p.functionCall === 'object') {
      const fc = p.functionCall as { name?: unknown; args?: unknown }
      if (typeof fc.name === 'string') {
        events.push({ role: 'tool', tool: { name: fc.name, input: fc.args } })
      }
    }
  }
  return events
}

type Parsed = { id?: string; lastTs?: string; events: TranscriptEvent[] }

/** Two shapes in the wild: a bare Content[] array, or an object wrapping the
 *  conversation in `messages`. Return the message list either way. */
function geminiContents(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)) {
    return (raw as { messages: unknown[] }).messages
  }
  return []
}

function parseGemini(raw: unknown, fallbackId: string): Parsed {
  const contents = geminiContents(raw)
  // Session metadata only exists on the object form, not the bare array.
  const meta: Record<string, unknown> =
    !Array.isArray(raw) && raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  const events: TranscriptEvent[] = []
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue
    const rec = c as Record<string, unknown>
    const role = roleOf(rec.role ?? rec.type)
    if (Array.isArray(rec.parts)) {
      events.push(...partsToEvents(role, rec.parts))
    } else if (typeof rec.content === 'string' && rec.content) {
      events.push({ role, text: rec.content })
    } else if (typeof rec.text === 'string' && rec.text) {
      events.push({ role, text: rec.text })
    }
  }

  const lastTs =
    (typeof meta.lastUpdated === 'string' && meta.lastUpdated) ||
    (typeof meta.endTime === 'string' && meta.endTime) ||
    (typeof meta.startTime === 'string' && meta.startTime) ||
    undefined
  const id = (typeof meta.sessionId === 'string' && meta.sessionId) || fallbackId
  return { id, lastTs: lastTs || undefined, events }
}

export class GeminiSessionStore implements SessionStore {
  readonly runtime = 'gemini' as const

  async list(opts: { workspace: string; limit?: number }): Promise<SessionSummary[]> {
    const dir = chatsDirFor(opts.workspace)
    let files: string[]
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: SessionSummary[] = []
    for (const file of files) {
      const path = join(dir, file)
      try {
        const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
        const stem = file.replace(/\.json$/, '')
        const parsed = parseGemini(JSON.parse(text), stem)
        out.push({
          id: parsed.id ?? stem,
          runtime: this.runtime,
          cwd: opts.workspace, // the hash dir IS the project, so cwd is known
          updatedAt: parsed.lastTs ?? st.mtime.toISOString(),
          title: deriveTitle(parsed.events),
          messageCount: countMessages(parsed.events),
        })
      } catch {
        // Skip unreadable chat files.
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
  }

  async read(id: string): Promise<NormalizedTranscript | undefined> {
    // read() has no workspace, so scan every project's chats for a matching id.
    let hashes: string[]
    try {
      hashes = await readdir(tmpRoot())
    } catch {
      return undefined
    }
    for (const hash of hashes) {
      const dir = join(tmpRoot(), hash, 'chats')
      let files: string[]
      try {
        files = (await readdir(dir)).filter(f => f.endsWith('.json'))
      } catch {
        continue
      }
      for (const file of files) {
        const stem = file.replace(/\.json$/, '')
        try {
          const parsed = parseGemini(JSON.parse(await readFile(join(dir, file), 'utf8')), stem)
          if (parsed.id !== id && stem !== id) continue
          return {
            id,
            runtime: this.runtime,
            cwd: '', // recovered from the chosen summary by the caller
            title: deriveTitle(parsed.events),
            events: parsed.events,
          }
        } catch {
          // Keep scanning.
        }
      }
    }
    return undefined
  }
}
