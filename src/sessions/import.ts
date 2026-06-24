/**
 * importSession — headless core of a session import: read the on-disk transcript,
 * distill it, and admit an owner-role `knowledge.append` to the scope's
 * shared-context. Caller authenticates the owner id; this does not.
 */

import type { Store } from '../ledger/store.ts'
import type { Hash } from '../ledger/interaction.ts'
import { admit } from '../ledger/admit.ts'
import { wrapSharedContext } from '../lib.ts'
import { makeSessionStore, type SessionRuntime } from './index.ts'
import { cwdMatchesWorkspace } from './session-store.ts'
import { distill } from './distill.ts'

export type ImportSessionInput = {
  runtime: SessionRuntime
  sessionId: string
  scopeId: string
  ownerId: string
  /** Importing agent's workspace — enforced so a stem collision can't leak a foreign session. */
  workspace?: string
  /** Used when the transcript doesn't record its own cwd. */
  fallbackCwd?: string
}

export type ImportSessionResult =
  | { ok: true; noteHash: Hash; brief: string; tags: string[]; cwd?: string }
  | { ok: false; reason: 'unreadable' | 'outside-workspace' }

export async function importSession(store: Store, input: ImportSessionInput): Promise<ImportSessionResult> {
  const sstore = makeSessionStore(input.runtime)
  if (!sstore) return { ok: false, reason: 'unreadable' }

  // Privacy gate: confirm the id is in this workspace via the filtered list() first.
  if (input.workspace) {
    const inWorkspace = (await sstore.list({ workspace: input.workspace })).some(
      s => s.id === input.sessionId,
    )
    if (!inWorkspace) return { ok: false, reason: 'outside-workspace' }
  }

  const transcript = await sstore.read(input.sessionId)
  if (!transcript) return { ok: false, reason: 'unreadable' }

  // Defense in depth: a recorded cwd must also be within the workspace.
  if (input.workspace && transcript.cwd && !cwdMatchesWorkspace(transcript.cwd, input.workspace)) {
    return { ok: false, reason: 'outside-workspace' }
  }

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
