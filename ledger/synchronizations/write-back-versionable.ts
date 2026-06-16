/**
 * write-back-versionable — project the merged text for an edited file and write
 * it to disk, so every relay sharing the ledger converges to the same bytes.
 *
 * Fires on an admitted `workspace.edit`. Reads the merged text from the
 * versionable fold and writes it under an `external_claim` keyed to the file, so
 * two relays on one Postgres ledger don't interleave writes to the same path.
 * The write is content-compared first (idempotent): on the machine where the
 * agent already wrote the file via its own Edit tool, this is a no-op; the value
 * is cross-machine convergence and role-ordered conflict arbitration.
 */

import type { Synchronization } from '../sync.ts'
import type { ArtifactId } from '../interaction.ts'
import { withClaim } from '../artifacts/external.ts'
import { VERSIONABLE_FOLD, projectVersionable, isVersionableEdit, type VersionableFoldState } from '../artifacts/versionable.ts'

export type WriteBackVersionableDeps = {
  /** Resolve a `vers:<scope>/<rel>` artifact to an absolute path on this machine,
   *  or undefined when the scope is not served here. */
  resolvePath: (artifactId: ArtifactId) => string | undefined
  /** Read the file's current contents, or undefined if absent/unreadable. */
  readFile: (absPath: string) => Promise<string | undefined>
  /** Write the file atomically. */
  writeFile: (absPath: string, content: string) => Promise<void>
}

export function writeBackVersionable(deps: WriteBackVersionableDeps): Synchronization {
  return {
    name: 'write-back-versionable',
    matches: isVersionableEdit,
    fire: async (i, ctx) => {
      const artifactId = i.target.artifactId
      const absPath = deps.resolvePath(artifactId)
      if (!absPath) return // not served on this machine

      const state = ctx.engine.get<VersionableFoldState>(VERSIONABLE_FOLD)
      const { text } = projectVersionable(state, artifactId)

      // Serialize the disk write across relays. The claim holder is this edit's
      // hash; if another relay holds it, skip — it will write the same bytes.
      const claimKey = `extp:file/${artifactId}` as ArtifactId
      await withClaim(ctx.store, claimKey, i.hash, async () => {
        const current = await deps.readFile(absPath)
        if (current === text) return // already converged — no write
        await deps.writeFile(absPath, text)
      })
    },
  }
}
