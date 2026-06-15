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
import { projectVersionable, VERSIONABLE_FOLD, type VersionableFoldState } from '../artifacts/versionable.ts'
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
    // AOCM: a conflict is no longer a 'proposed' lifecycle — it is DERIVED by the
    // versionable projection (equal-role interfering edits). Fire on each admitted
    // versionable edit and consult the projection; post when the just-admitted edit
    // participates in a derived conflict region.
    matches: i =>
      i.verb === 'workspace.edit' &&
      i.lifecycle === 'applied' &&
      i.patch.kind === 'versionable' &&
      i.target.artifactId.startsWith('vers:'),
    fire: async (i, ctx) => {
      const state = ctx.engine.get<VersionableFoldState>(VERSIONABLE_FOLD)
      const region = projectVersionable(state, i.target.artifactId).conflicts.find(c =>
        c.branches.includes(i.hash),
      )
      if (!region) return // this edit created no conflict

      const slice = state.get(i.target.artifactId)
      const branchEdits = region.branches
        .map(h => slice?.get(h))
        .filter((e): e is Interaction => !!e)
      if (branchEdits.length < 2) return

      // Dedup across relays: the branch set is deterministic (the projection sorts
      // it), so both machines derive the same claim key; the first to acquire posts,
      // the other skips. The holder is this relay's id (NOT a per-op hash, which is
      // identical on both machines and would "renew" rather than block).
      if (opts.relayId) {
        const claimKey = `extp:discord/${i.channel}/conflict/${region.branches.join('-')}`
        const lock = await ctx.store.acquireClaim(claimKey, opts.relayId, CONFLICT_CLAIM_TTL_MS)
        if (!lock.acquired) return
      }

      const branches: ConflictBranch[] = branchEdits.map(b => ({
        author: `@${b.actor}`,
        body: bodyOf(b.patch),
      }))
      const ownerId = opts.getOwnerForChannel(i.channel)
      const text = renderConflictCard({ target: targetLabel(i), ownerId, branches })
      await opts.postCard({ channelId: i.channel, text, branchHashes: region.branches, ownerId })
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
