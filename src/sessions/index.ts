/**
 * Session-store factory + cross-runtime fan-out.
 */

import { ClaudeCodeSessionStore } from './claude.ts'
import { CodexSessionStore } from './codex.ts'
import { GeminiSessionStore } from './gemini.ts'
import { OpenCodeSessionStore } from './opencode.ts'
import type { SessionRuntime, SessionStore, SessionSummary } from './session-store.ts'

/** All session readers, one per runtime. */
function allSessionStores(): SessionStore[] {
  return [
    new ClaudeCodeSessionStore(),
    new CodexSessionStore(),
    new OpenCodeSessionStore(),
    new GeminiSessionStore(),
  ]
}

/** Resolve a single store (accepts session-runtime keys AND relay runtime keys). */
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

/** The session-runtime a relay runtime resumes against, or undefined if none maps. */
export function sessionRuntimeForAgent(runtime: string): SessionRuntime | undefined {
  return makeSessionStore(runtime)?.runtime
}

/** Recent sessions across every runtime for a workspace, newest first (per-store isolated). */
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
