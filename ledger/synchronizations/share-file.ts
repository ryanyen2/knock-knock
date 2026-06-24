/**
 * share-file — send a workspace file out to the channel, gated by the secret
 * floor and the room's FileShare permission, sent under an external_claim so
 * relays sharing one ledger don't double-post.
 *
 * Fires on a `file.shared` request (op:'requested') — admitted today by the
 * owner `!share <relpath>` command (the owner's command IS the consent, so an
 * `ask` classification collapses to allow for an owner-initiated request). The
 * shape is trigger-agnostic: an agent-initiated `share_file` tool can admit the
 * same request later (requestedBy:'agent') and route through an interactive
 * consent card — deferred (plan OQ1). The hard stop that holds regardless of
 * trigger or preset is the secret floor: a credential path/content is refused
 * even under `bypass` and even for the owner (so a fat-fingered `!share .env`
 * can't leak).
 *
 * Pipeline: resolve+read inside the workspace (containment) → secret scan (path
 * + content) → classifyTool(FileShare) (deny ⇒ refuse) → send under claim →
 * record file.shared (op:'completed'). Decisions are the pure lib.ts helpers;
 * I/O is injected, so the orchestration is testable with stubs.
 */

import type { Synchronization } from '../sync.ts'
import { discordArtifact } from '../interaction.ts'
import { withClaim } from '../artifacts/external.ts'
import { looksLikeSecret } from '../../lib.ts'

export type ShareFileDeps = {
  /** Read the file at `relpath` from the workspace serving `scope`. Returns the
   *  send name + bytes, or an error reason (outside workspace / unreadable /
   *  scope unserved). Containment lives here (host relativizeWorkspacePath). */
  resolveFile: (
    scope: string,
    relpath: string,
  ) => Promise<{ name: string; bytes: Uint8Array } | { error: string }>
  /** Classify a FileShare of `relpath` against the room profile for `scope`
   *  (scope→room). 'deny' is the secret floor (and strict); 'ask'/'allow' both
   *  proceed for an owner-initiated request. */
  classify: (scope: string, relpath: string) => 'allow' | 'ask' | 'deny'
  /** Send the file out under the channel's external claim. Returns false on a
   *  lost claim or send failure (dedup: only one relay posts). */
  send: (scope: string, claimHolder: string, name: string, bytes: Uint8Array) => Promise<boolean>
  /** Post a short note back to the scope (refusal / failure). Best-effort. */
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

      // Secret scan: path + content head. Catches a credential file the floor
      // glob might miss by name but whose content is plainly a secret.
      if (looksLikeSecret(relpath, decodeHead(bytes))) {
        deps.note?.(i.channel, `refused to share "${relpath}" — it looks like it contains credentials`)
        return
      }

      // Permission floor. deny is non-bypassable (secret floor / strict); ask and
      // allow both proceed because an owner-initiated request is itself consent.
      const verdict = deps.classify(i.channel, relpath)
      if (verdict === 'deny') {
        deps.note?.(i.channel, `not allowed to share "${relpath}" (blocked by this room's permissions)`)
        return
      }

      const result = await withClaim(ctx.store, i.target.artifactId, i.hash, async () =>
        deps.send(i.channel, i.hash, name, bytes),
      )
      if (!result.acquired) return // another relay holds the claim — it posts
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
