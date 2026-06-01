/**
 * conflict-card — §4.2. When the merge gate holds two equal-role drafts at one
 * anchor, surface a choice in the channel instead of leaving the conflict silent
 * in the ledger.
 *
 * The losing (second) write lands with `lifecycle: 'proposed'` (admit.ts /
 * merge.ts) — that's the trigger. We gather the concurrent peers at the same
 * anchor, render the card (pure, render/surface.ts), and hand the text plus the
 * branch hashes to the glue, which attaches the Take A / Take B / Write buttons.
 *
 * The button click resolves to an owner-role `merge.resolve` that supersedes the
 * unchosen branches — that path lives in AgentHost (it owns the Discord client).
 * This file is the detect-and-render half; rubric #2: one new file.
 */

import type { Synchronization } from '../sync.ts'
import type { Interaction, Patch } from '../interaction.ts'
import { findConcurrentAtAnchor } from '../concurrency.ts'
import { renderConflictCard, type ConflictBranch } from '../render/surface.ts'

export type ConflictCardPost = {
  channelId: string
  text: string
  /** Branch hashes in the SAME order as the lettered A/B/… in the text. */
  branchHashes: string[]
  ownerId?: string
}

export type ConflictCardOpts = {
  /** Owner (Discord user id) who resolves conflicts in this channel. */
  getOwnerForChannel: (channelId: string) => string | undefined
  /** Post the card; the glue attaches buttons keyed by branchHashes. */
  postCard: (post: ConflictCardPost) => Promise<void>
  /** This relay's unique id, used as the claim holder so exactly one relay posts
   *  a given conflict card. Two agents on two machines editing one file in one
   *  scope both fire this sync; without the claim both would post. Omit for a
   *  single-relay setup (the claim still works, harmlessly). */
  relayId?: string
}

/** Window in which a posted conflict card is deduped across relays. Both relays
 *  receive the synced 'proposed' interaction within milliseconds, so a short
 *  window suffices; after it the conflict is typically already resolved. */
const CONFLICT_CLAIM_TTL_MS = 60_000

export function conflictCard(opts: ConflictCardOpts): Synchronization {
  return {
    name: 'conflict-card',
    // A 'proposed' lifecycle is only ever a held equal-role conflict.
    matches: i => i.lifecycle === 'proposed' && i.target.anchor.kind !== 'none',
    fire: async (i, ctx) => {
      const peers = await findConcurrentAtAnchor(ctx.store, i)
      if (peers.length === 0) return // nothing to choose between — not a real card

      // Deterministic order so the letters are stable across machines:
      // sort the whole branch set (proposed + peers) by hash, matching the
      // merge gate's lower-hash tiebreak. This is intentional and is NOT
      // arrival order — the second writer to land can take 🅰 if its hash
      // sorts lower. The hash tiebreak is precisely what lets two machines
      // render byte-identical cards (and label the same buttons); do not
      // re-sort by timestamp. The card text carries a one-line hint saying so.
      const all = [i, ...peers].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

      // Dedup across relays: the branch set is deterministic (lower-hash sort),
      // so both machines derive the same claim key; the first to acquire posts,
      // the other skips. The holder is this relay's id (NOT the interaction hash,
      // which is identical on both machines and would "renew" rather than block).
      if (opts.relayId) {
        const claimKey = `extp:discord/${i.channel}/conflict/${all[0]!.hash}`
        const lock = await ctx.store.acquireClaim(claimKey, opts.relayId, CONFLICT_CLAIM_TTL_MS)
        if (!lock.acquired) return
      }

      const branches: ConflictBranch[] = all.map(b => ({
        author: `@${b.actor}`,
        body: bodyOf(b.patch),
      }))
      const ownerId = opts.getOwnerForChannel(i.channel)
      const text = renderConflictCard({
        target: targetLabel(i),
        ownerId,
        branches,
      })
      await opts.postCard({
        channelId: i.channel,
        text,
        branchHashes: all.map(b => b.hash),
        ownerId,
      })
    },
  }
}

/** Human-readable draft body from a patch; placeholder for opaque kinds. The
 *  contested file path is in the card header (targetLabel); for a versionable
 *  edit we show the change magnitude rather than a misleading single-delta
 *  preview (a true before/after diff is deferred past the walking skeleton). */
function bodyOf(patch: Patch): string {
  if (patch.kind === 'knowledge' && patch.append) return patch.append.body
  if (patch.kind === 'versionable') {
    const bytes = patch.ops ? Buffer.from(patch.ops, 'base64').length : 0
    return `(file edit · ~${bytes} bytes changed)`
  }
  return '(draft)'
}

/** Short label for the contested artifact + anchor, e.g. "notes §title". */
function targetLabel(i: Interaction): string {
  const id = i.target.artifactId
  const short = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const a = i.target.anchor
  if (a.kind === 'key') return `${short} §${a.path}`
  // The whole-file sentinel (0..0) reads as the file itself, not a byte range.
  if (a.kind === 'range' && !(a.from === 0 && a.to === 0)) return `${short} [${a.from}..${a.to}]`
  return short
}
