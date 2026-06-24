/** conflict-card — post a Take A / Take B / Write card when an admitted edit
 *  joins a derived equal-role conflict region. Detect-and-render half; the
 *  button resolves to an owner merge.resolve in AgentHost. */

import type { Synchronization } from '../sync.ts'
import type { Interaction, Patch } from '../interaction.ts'
import { projectVersionable, isVersionableEdit, VERSIONABLE_FOLD, type VersionableFoldState } from '../artifacts/versionable.ts'
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
  /** This relay's id, used as the claim holder so exactly one relay posts. */
  relayId?: string
}

/** Cross-relay dedup window for a posted conflict card. */
const CONFLICT_CLAIM_TTL_MS = 60_000

export function conflictCard(opts: ConflictCardOpts): Synchronization {
  return {
    name: 'conflict-card',
    // A conflict is DERIVED by the versionable projection, not a lifecycle.
    matches: isVersionableEdit,
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

      // Cross-relay dedup: deterministic branch set → same claim key; first wins.
      // Holder is this relay's id (not a per-op hash, which would renew not block).
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

/** Human-readable draft body from a patch; placeholder for opaque kinds. */
function bodyOf(patch: Patch): string {
  if (patch.kind === 'knowledge' && patch.append) return patch.append.body
  if (patch.kind === 'versionable') {
    // Show the branch's actual content so Take A vs Take B is a real choice.
    const intent = patch.intent
    if (intent?.kind === 'write') return snippet(intent.content)
    if (intent?.kind === 'edit') {
      return `replace «${snippet(intent.oldString, 28)}» → «${snippet(intent.newString, 56)}»`
    }
    const bytes = patch.ops ? Buffer.from(patch.ops, 'base64').length : 0
    return `(file edit · ~${bytes} bytes)`
  }
  return '(draft)'
}

/** One-line preview of edited text: collapse whitespace, cap length. */
function snippet(text: string, max = 88): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || '(empty)'
}

/** Short label for the contested artifact + anchor, e.g. "notes §title". */
function targetLabel(i: Interaction): string {
  const id = i.target.artifactId
  const short = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const a = i.target.anchor
  if (a.kind === 'key') return `${short} §${a.path}`
  // Whole-file sentinel (0..0) reads as the file itself, not a byte range.
  if (a.kind === 'range' && !(a.from === 0 && a.to === 0)) return `${short} [${a.from}..${a.to}]`
  return short
}
