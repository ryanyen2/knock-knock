/** capture-workspace-edit — turn an agent's Edit/Write tool execution into a
 *  `workspace.edit` interaction (admitted applied; dominance/exclusion/conflict
 *  derived from immutable ops). The path-free intent rides the patch for the
 *  projection's interference test. v1: whole-file anchor, text only. */

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
  /** `absFilePath` relative to `scope`'s workspace, or undefined when outside the
   *  workspace / scope unserved. Workspace-relative keeps the artifact id stable. */
  relativize: (scope: string, absFilePath: string) => string | undefined
}

export function captureWorkspaceEdit(deps: CaptureWorkspaceEditDeps): Synchronization {
  // Live capture docs, one per artifact; kept alive across edits and primed from
  // the ledger on first use so a new update is relative to the merged state.
  const docs = new Map<ArtifactId, Y.Doc>()

  return {
    name: 'capture-workspace-edit',
    matches: i =>
      i.verb === 'tool.executed' && (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      if (i.patch.kind !== 'external' || i.patch.result?.ok !== true) return
      const parentHash = i.caused_by[0]
      if (!parentHash) return
      // tool.executed carries empty args; read the Edit/Write input from the request.
      const parent = await ctx.store.getByHash(parentHash)
      if (!parent || parent.verb !== 'tool.requested' || parent.patch.kind !== 'external') return

      const intent = parseEditIntent(parent.patch.intent.op, parent.patch.intent.args)
      if (!intent) return
      const relPath = deps.relativize(i.channel, intent.filePath)
      if (!relPath) return // containment: outside the workspace / scope unserved

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

      // Binary guard: a NUL byte would be mangled through Y.Text — skip, don't corrupt.
      if (newText.includes('\u0000')) return

      const ops = mutateAndEncode(doc, text => {
        text.delete(0, text.length)
        text.insert(0, newText)
      })

      // Chain onto the artifact's LIVE edits only: sequential edits don't contend,
      // concurrent ones do.
      const caused_by = [...new Set([i.hash, ...liveVersionableEditHashes(state, artifactId)])]

      await ctx.admit({
        actor: i.actor,
        role: i.role,
        channel: i.channel,
        target: { artifactId, anchor: WHOLE_FILE_ANCHOR },
        verb: 'workspace.edit',
        // Path-free intent rides the patch for the interference test; plain JSON so
        // it hashes identically across replicas.
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

export { parseVersionableId }
