/**
 * Session-store factory + cross-runtime fan-out.
 *
 * The mirror of adapters/index.ts: agent-host.ts and the distiller stay free of
 * any per-runtime path/format knowledge and speak only the SessionStore seam.
 * The owner picks a session from ANY local runtime, so listAllSessions queries
 * every store and merges newest-first — independent of which runtime the
 * channel's own agent happens to use.
 */

import { ClaudeCodeSessionStore } from './claude.ts'
import { CodexSessionStore } from './codex.ts'
import { GeminiSessionStore } from './gemini.ts'
import { OpenCodeSessionStore } from './opencode.ts'
import type { SessionRuntime, SessionStore, SessionSummary } from './session-store.ts'

/** All session readers, one per runtime. Internal: callers use the seam below. */
function allSessionStores(): SessionStore[] {
  return [
    new ClaudeCodeSessionStore(),
    new CodexSessionStore(),
    new OpenCodeSessionStore(),
    new GeminiSessionStore(),
  ]
}

/** Resolve a single store. Accepts session-runtime keys AND the relay's runtime
 *  keys (claude-sdk/claude-acp both read Claude Code's on-disk sessions). */
export function makeSessionStore(runtime: string): SessionStore | undefined {
  switch (runtime) {
    case 'claude-code':
    case 'claude-sdk':
    case 'claude-acp':
      return new ClaudeCodeSessionStore()
    case 'codex':
      return new CodexSessionStore()
    case 'opencode':
      return new OpenCodeSessionStore()
    case 'gemini':
      return new GeminiSessionStore()
    default:
      return undefined
  }
}

/** The session-runtime a relay runtime resumes against (claude-sdk/claude-acp →
 *  claude-code, etc.), or undefined if no store maps. Used to check that a
 *  session can actually be resumed by the channel's agent before offering it. */
export function sessionRuntimeForAgent(runtime: string): SessionRuntime | undefined {
  return makeSessionStore(runtime)?.runtime
}

/** Recent sessions across every runtime for a workspace, newest first. Each
 *  store is best-effort and isolated: one throwing never sinks the others. */
export async function listAllSessions(
  workspace: string,
  opts: { limit?: number } = {},
): Promise<SessionSummary[]> {
  const perStore = opts.limit ?? 10
  const results = await Promise.all(
    allSessionStores().map(s =>
      s.list({ workspace, limit: perStore }).catch(() => [] as SessionSummary[]),
    ),
  )
  const merged = results.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return typeof opts.limit === 'number' ? merged.slice(0, opts.limit) : merged
}

export type { SessionRuntime, SessionStore, SessionSummary }
export type { NormalizedTranscript, TranscriptEvent } from './session-store.ts'
