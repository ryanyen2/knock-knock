/** share-file — send a workspace file out, gated by the secret floor + FileShare
 *  permission, under an external_claim (cross-relay dedup). Secret floor is the
 *  hard stop: a credential path/content is refused even under bypass / for the
 *  owner. Pipeline: resolve+read inside workspace (containment) → secret scan →
 *  classifyTool (deny ⇒ refuse) → send under claim → record completed. */

import type { Synchronization } from '../sync.ts'
import { discordArtifact } from '../interaction.ts'
import { withClaim } from '../artifacts/external.ts'
import { looksLikeSecret } from '../../lib.ts'

export type ShareFileDeps = {
  /** Read `relpath` from `scope`'s workspace (containment here), or an error reason. */
  resolveFile: (
    scope: string,
    relpath: string,
  ) => Promise<{ name: string; bytes: Uint8Array } | { error: string }>
  /** Classify a FileShare against the room profile; 'deny' is the secret floor/strict. */
  classify: (scope: string, relpath: string) => 'allow' | 'ask' | 'deny'
  /** Send the file out under the channel's claim; false on lost claim / send failure. */
  send: (scope: string, claimHolder: string, name: string, bytes: Uint8Array) => Promise<boolean>
  /** Post a short note (refusal / failure). Best-effort. */
  note?: (scope: string, text: string) => void
}

/** Decode the head of a buffer as UTF-8 for the secret content scan. */
function decodeHead(bytes: Uint8Array, max = 8192): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, max))
}

export function shareFile(deps: ShareFileDeps): Synchronization {
  return {
    name: 'share-file',
    matches: i => {
      if (i.verb !== 'file.shared') return false
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return false
      if (i.patch.kind !== 'external') return false
      return i.patch.intent.op === 'requested'
    },
    fire: async (i, ctx) => {
      if (i.patch.kind !== 'external') return
      const args = i.patch.intent.args as { relpath?: string; requestedBy?: string } | undefined
      const relpath = args?.relpath
      if (!relpath) return
      const platform = i.patch.intent.channel

      const resolved = await deps.resolveFile(i.channel, relpath)
      if ('error' in resolved) {
        deps.note?.(i.channel, `can't share "${relpath}": ${resolved.error}`)
        return
      }
      const { name, bytes } = resolved

      // Secret scan: path + content head — refuse credentials.
      if (looksLikeSecret(relpath, decodeHead(bytes))) {
        deps.note?.(i.channel, `refused to share "${relpath}" — it looks like it contains credentials`)
        return
      }

      // deny is non-bypassable; ask/allow proceed (owner request is consent).
      const verdict = deps.classify(i.channel, relpath)
      if (verdict === 'deny') {
        deps.note?.(i.channel, `not allowed to share "${relpath}" (blocked by this room's permissions)`)
        return
      }

      const result = await withClaim(ctx.store, i.target.artifactId, i.hash, async () =>
        deps.send(i.channel, i.hash, name, bytes),
      )
      if (!result.acquired) return // another relay holds the claim
      if (result.result !== true) {
        deps.note?.(i.channel, `couldn't send "${name}" to the channel`)
        return
      }

      await ctx.admit({
        actor: i.actor,
        role: i.role,
        channel: i.channel,
        target: { artifactId: discordArtifact(i.channel), anchor: { kind: 'none' } },
        verb: 'file.shared',
        patch: {
          kind: 'external',
          intent: { channel: platform, op: 'completed', args: { relpath, name } },
        },
        effect: 'external',
        caused_by: [i.hash],
      })
    },
  }
}
