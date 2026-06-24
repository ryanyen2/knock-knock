/** write-back-versionable — on an admitted `workspace.edit`, write the merged
 *  text to disk under a per-file claim, content-compared first (idempotent). */

import type { Synchronization } from '../sync.ts'
import type { ArtifactId } from '../interaction.ts'
import { withClaim } from '../artifacts/external.ts'
import { VERSIONABLE_FOLD, projectVersionable, isVersionableEdit, type VersionableFoldState } from '../artifacts/versionable.ts'

export type WriteBackVersionableDeps = {
  /** Resolve a `vers:` artifact to an absolute path, or undefined when unserved. */
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

      // Serialize the disk write across relays.
      const claimKey = `extp:file/${artifactId}` as ArtifactId
      await withClaim(ctx.store, claimKey, i.hash, async () => {
        const current = await deps.readFile(absPath)
        if (current === text) return // already converged — no write
        await deps.writeFile(absPath, text)
      })
    },
  }
}
