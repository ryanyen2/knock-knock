/**
 * SessionStore — the read-side seam for *local* coding-agent sessions.
 *
 * The relay drives agents through the AgentAdapter seam (adapters/). This is the
 * mirror image: a read-only window onto sessions that other local coding agents
 * (Claude Code, Codex, OpenCode, Gemini) have already persisted on this machine.
 * The valuable collaboration context — the plan, the decisions, the dead-ends —
 * lives in those unpushed sessions; a SessionStore lets the relay surface and
 * import it (see sessions/distill.ts and the owner share-session flow in
 * agent-host.ts).
 *
 * One store per runtime; each knows only its own on-disk layout + format. Every
 * implementation is BEST-EFFORT: a missing directory, an unreadable file, or an
 * unrecognized line must degrade to "fewer results", never throw. Discovery is
 * owner-initiated and read-only, so over-tolerance is the safe failure.
 *
 * Privacy: `list({workspace})` filters to sessions whose working directory is the
 * agent's `workspace`, so unrelated local projects are never surfaced into a
 * channel. A store that genuinely cannot determine a session's cwd falls back to
 * including it (better a stray entry the owner can ignore than a runtime that
 * silently shows nothing) — documented per reader.
 */

/** Session-runtime keys — where a transcript lives, NOT the relay runtime.
 *  `claude-sdk` and `claude-acp` relay runtimes both read `claude-code` here. */
export type SessionRuntime = 'claude-code' | 'codex' | 'opencode' | 'gemini'

/** A one-line index entry for the selection card — cheap to compute. */
export type SessionSummary = {
  /** Runtime-native session id (usually the file/dir stem). */
  id: string
  runtime: SessionRuntime
  /** Working directory the session ran in (used for the workspace filter). */
  cwd: string
  /** ISO timestamp of last activity (last event ts, else file mtime). */
  updatedAt: string
  /** Short human label — the first user prompt or the session's own title. */
  title?: string
  /** Count of user/assistant turns (tool calls excluded), for the card. */
  messageCount: number
}

/** A single normalized transcript event. Tool calls keep name + input so the
 *  distiller can pull out plans (ExitPlanMode) and todos (TodoWrite). */
export type TranscriptEvent = {
  role: 'user' | 'assistant' | 'tool'
  /** Assistant/user prose, when present. */
  text?: string
  /** A tool invocation, when this event is a tool call. */
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

/** Compare two paths as the same directory, tolerant of a trailing slash.
 *  A session counts as "in the workspace" if its cwd is the workspace or a
 *  descendant of it (so a session started in a subdir still surfaces). */
export function cwdMatchesWorkspace(cwd: string | undefined, workspace: string): boolean {
  if (!cwd) return false
  const a = normalizeWorkspace(cwd)
  const b = normalizeWorkspace(workspace)
  return a === b || a.startsWith(b + '/')
}

/** Normalize a workspace path for matching/encoding: strip trailing slashes so
 *  "/x/y/" and "/x/y" resolve identically. Critical because the path is encoded
 *  into a Claude project-dir name and sha256-hashed for Gemini, where a trailing
 *  slash diverges from the on-disk reality (access.json may carry one). */
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
      // Tolerate a partial last line (crash mid-write) or non-JSON noise.
    }
  }
  return out
}
