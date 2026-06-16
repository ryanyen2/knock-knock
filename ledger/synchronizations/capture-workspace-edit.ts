/**
 * capture-workspace-edit — turn an agent's Edit/Write tool execution into a
 * `workspace.edit` interaction, so concurrent file edits converge over the ledger
 * under AOCM (no Discord conversation): the edit is admitted `applied`, and the
 * versionable projection derives dominance/exclusion/conflict from the immutable
 * ops (see ledger/artifacts/versionable.ts).
 *
 * Fires on a successful `tool.executed`. Its parent `tool.requested` carries the
 * Edit/Write input (file path + content) — `tool.executed` itself carries empty
 * args, so we read the input from the correlated request. The edit is captured
 * against a per-artifact live Y.Doc (Yjs updates are relative to a doc instance,
 * so the doc is kept alive across edits and primed from the ledger on first use),
 * then admitted. The normalized path-free intent rides along on the patch for the
 * projection's interference test.
 *
 * Walking-skeleton scope (rubric #2: one new behavior, zero edits to concepts):
 * whole-file replace/append, one stable whole-file anchor. The capture is wired
 * for any runtime whose Edit/Write tool calls surface as tool.requested; the
 * convergence story is proven by versionable.test.ts and aocm.test.ts.
 */

import * as Y from 'yjs'
import type { Synchronization } from '../sync.ts'
import type { ArtifactId } from '../interaction.ts'
import {
  VERSIONABLE_FOLD,
  WHOLE_FILE_ANCHOR,
  applyEditIntent,
  mutateAndEncode,
  parseEditIntent,
  parseVersionableId,
  versionableArtifactId,
  liveVersionableEditHashes,
  type VersionableFoldState,
} from '../artifacts/versionable.ts'

export type CaptureWorkspaceEditDeps = {
  /** Make `absFilePath` relative to the agent serving `scope`'s workspace, or
   *  undefined when the file is outside the workspace / the scope is unserved.
   *  Workspace-relative keeps the artifact id stable across machines. */
  relativize: (scope: string, absFilePath: string) => string | undefined
}

export function captureWorkspaceEdit(deps: CaptureWorkspaceEditDeps): Synchronization {
  // Live capture docs, one per artifact. Kept alive across edits; primed from the
  // ledger on first use after a (re)start so a new update is relative to the
  // current merged state, not an empty doc.
  const docs = new Map<ArtifactId, Y.Doc>()

  return {
    name: 'capture-workspace-edit',
    matches: i =>
      i.verb === 'tool.executed' && (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      if (i.patch.kind !== 'external' || i.patch.result?.ok !== true) return
      const parentHash = i.caused_by[0]
      if (!parentHash) return
      const parent = await ctx.store.getByHash(parentHash)
      if (!parent || parent.verb !== 'tool.requested' || parent.patch.kind !== 'external') return

      const intent = parseEditIntent(parent.patch.intent.op, parent.patch.intent.args)
      if (!intent) return
      const relPath = deps.relativize(i.channel, intent.filePath)
      if (!relPath) return // outside the workspace, or scope not served here

      const artifactId = versionableArtifactId(i.channel, relPath)
      const state = ctx.engine.get<VersionableFoldState>(VERSIONABLE_FOLD)

      // Get/prime the live doc for this artifact.
      let doc = docs.get(artifactId)
      if (!doc) {
        doc = new Y.Doc()
        const existing = state.get(artifactId)
        if (existing) {
          for (const edit of existing.values()) {
            if (edit.patch.kind === 'versionable' && edit.patch.ops) {
              Y.applyUpdate(doc, Buffer.from(edit.patch.ops, 'base64'))
            }
          }
        }
        docs.set(artifactId, doc)
      }

      const currentText = doc.getText('content').toString()
      const newText = applyEditIntent(currentText, intent)
      if (newText === currentText) return // no-op edit; nothing to record

      // Binary guard: a Write of non-text content would be mangled through Y.Text
      // (UTF-16) and then write-back would overwrite the real file with corrupt
      // text. A NUL byte is the standard binary signal — skip rather than corrupt.
      // (v1 scope is Claude-Code-shaped text Edit/Write; binary is out of scope.)
      if (newText.includes('\u0000')) return

      const ops = mutateAndEncode(doc, text => {
        text.delete(0, text.length)
        text.insert(0, newText)
      })

      // Chain onto the artifact's LIVE edits only, so a sequential edit descends
      // from the live text (no false conflict) without becoming a spurious
      // descendant of a dominated/conflicting loser.
      const caused_by = [...new Set([i.hash, ...liveVersionableEditHashes(state, artifactId)])]

      await ctx.admit({
        actor: i.actor,
        role: i.role,
        channel: i.channel,
        target: { artifactId, anchor: WHOLE_FILE_ANCHOR },
        verb: 'workspace.edit',
        // Retain the normalized (path-free) intent alongside the Yjs ops — AOCM's
        // interference test reads it; it is plain JSON so it hashes identically
        // across replicas. (Previously the parsed intent was discarded here.)
        patch: {
          kind: 'versionable',
          ops,
          intent:
            intent.kind === 'write'
              ? { kind: 'write', content: intent.content }
              : { kind: 'edit', oldString: intent.oldString, newString: intent.newString },
        },
        effect: 'workspace',
        caused_by,
      })
    },
  }
}

/** Re-exported so the relay can build artifact ids / parse them symmetrically. */
export { parseVersionableId }
