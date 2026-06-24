/**
 * SessionStore — read-side seam for *local* coding-agent sessions. Best-effort:
 * a missing dir / unreadable file degrades to fewer results, never throws.
 * Privacy: `list({workspace})` filters to the agent's workspace.
 */

/** Session-runtime keys — where a transcript lives, NOT the relay runtime. */
export type SessionRuntime = 'claude-code' | 'codex' | 'opencode' | 'gemini'

/** A one-line index entry for the selection card. */
export type SessionSummary = {
  id: string
  runtime: SessionRuntime
  cwd: string
  updatedAt: string
  title?: string
  messageCount: number
}

/** A single normalized transcript event. */
export type TranscriptEvent = {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  tool?: { name: string; input?: unknown }
}

/** A runtime-agnostic transcript — what distill.ts consumes. */
export type NormalizedTranscript = {
  id: string
  runtime: SessionRuntime
  cwd: string
  title?: string
  events: TranscriptEvent[]
}

export interface SessionStore {
  readonly runtime: SessionRuntime
  /** List recent sessions whose cwd matches `workspace`, newest first. */
  list(opts: { workspace: string; limit?: number }): Promise<SessionSummary[]>
  /** Read one session's full normalized transcript, or undefined if gone. */
  read(id: string): Promise<NormalizedTranscript | undefined>
}

// ─── Shared helpers for the readers ──────────────────────────────────────────

/** True if `cwd` is `workspace` or a descendant (trailing-slash tolerant). */
export function cwdMatchesWorkspace(cwd: string | undefined, workspace: string): boolean {
  if (!cwd) return false
  const a = normalizeWorkspace(cwd)
  const b = normalizeWorkspace(workspace)
  return a === b || a.startsWith(b + '/')
}

/** Normalize a workspace path: strip trailing slashes (encoding/hashing depend on it). */
export function normalizeWorkspace(ws: string): string {
  return ws.replace(/\/+$/, '')
}

/** First non-empty line of prose, collapsed + capped, for a session title. */
export function deriveTitle(events: TranscriptEvent[]): string | undefined {
  const firstUser = events.find(e => e.role === 'user' && e.text && e.text.trim())
  const raw = firstUser?.text ?? events.find(e => e.text && e.text.trim())?.text
  if (!raw) return undefined
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat
}

/** Count user+assistant turns (tool calls don't count as "messages"). */
export function countMessages(events: TranscriptEvent[]): number {
  return events.filter(e => e.role !== 'tool').length
}

/** Parse newline-delimited JSON tolerantly: skip blank/garbage lines. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* tolerate a partial last line or non-JSON noise */
    }
  }
  return out
}
