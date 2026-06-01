/**
 * importSession — the headless core of a session import.
 *
 * Reads the chosen on-disk transcript (best-effort, file-based — nothing in the
 * live session is mutated), distills it (pure), and admits an owner-role
 * `knowledge.append` to `know:channel/<scopeId>/shared-context` (anchor: none →
 * no conflict card). The next turn in that scope injects it once; on Postgres it
 * syncs to teammates. This used to live inside the Discord button handler
 * (`host/session-sharing.ts`); extracting it makes import a ledger verb any
 * source can drive, with Discord staying the human trigger surface.
 *
 * Identity boundary: the caller passes the owner id; this function does not
 * authenticate (the Discord handler gates on ownerUserId first).
 */

import type { Store } from '../ledger/store.ts'
import type { Hash } from '../ledger/interaction.ts'
import { admit } from '../ledger/admit.ts'
import { wrapSharedContext } from '../lib.ts'
import { makeSessionStore, type SessionRuntime } from './index.ts'
import { distill } from './distill.ts'

export type ImportSessionInput = {
  runtime: SessionRuntime
  sessionId: string
  scopeId: string
  ownerId: string
  /** Used when the transcript doesn't record its own cwd. */
  fallbackCwd?: string
}

export type ImportSessionResult =
  | { ok: true; noteHash: Hash; brief: string; tags: string[]; cwd?: string }
  | { ok: false; reason: 'unreadable' }

export async function importSession(store: Store, input: ImportSessionInput): Promise<ImportSessionResult> {
  const sstore = makeSessionStore(input.runtime)
  const transcript = sstore ? await sstore.read(input.sessionId) : undefined
  if (!transcript) return { ok: false, reason: 'unreadable' }

  const { brief, tags } = distill(transcript)
  const cwd = transcript.cwd || input.fallbackCwd
  const body = wrapSharedContext(
    { source: `${input.runtime}:${input.sessionId.slice(0, 8)}`, cwd: cwd || undefined, savedBy: input.ownerId },
    brief,
  )
  const noteId = `session-${input.runtime}-${input.sessionId.slice(0, 8)}-${Date.now()}`
  const res = await admit(store, {
    actor: input.ownerId,
    role: 'owner',
    channel: input.scopeId,
    target: {
      artifactId: `know:channel/${input.scopeId}/shared-context`,
      anchor: { kind: 'none' },
    },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: noteId, body, tags } },
    effect: 'pure',
    caused_by: [],
  })
  return { ok: true, noteHash: res.interaction.hash, brief, tags, cwd: cwd || undefined }
}
