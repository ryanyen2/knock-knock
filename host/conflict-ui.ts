/**
 * ConflictUI (§4.2) — on a held equal-role conflict, post a Take A / Take B /
 * Write card; a button click admits an owner merge.resolve and surfaces the
 * drop back to each loser's inbox. Owns the open-card bookkeeping.
 */

import type { HostContext } from './context.ts'
import type { IncomingAction, Choice } from '../messaging-adapter.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { resolveConflict } from '../ledger/resolve-conflict.ts'
import { LETTERS } from '../ledger/render/surface.ts'
import type { ConflictCardPost } from '../ledger/synchronizations/conflict-card.ts'

export class ConflictUI {
  /** Conflict card messageId → its branch hashes, for button resolution. */
  private readonly cards = new Map<string, { branchHashes: Hash[]; channelId: ChannelId }>()

  constructor(private readonly ctx: HostContext) {}

  /** Does this action target one of our open conflict cards? */
  handles(action: IncomingAction): boolean {
    return action.actionId.startsWith('cflt:')
  }

  /**
   * Post a conflict card with Take A / Take B / … / Write choices. The branch
   * hashes are remembered against the message so a click resolves to a
   * merge.resolve. Returns the posted message id.
   */
  async postCard(post: ConflictCardPost): Promise<string | undefined> {
    const choices: Choice[] = post.branchHashes.slice(0, LETTERS.length).map((_, idx) => ({
      id: `cflt:take:${idx}`,
      label: `Take ${String.fromCharCode(65 + idx)}`,
      glyph: LETTERS[idx]!,
      style: 'neutral',
    }))
    choices.push({ id: 'cflt:write', label: 'Write my own', glyph: '✏️', style: 'primary' })

    const ref = await this.ctx.messaging.send(post.channelId, post.text, { choices })
    if (!ref) return undefined
    this.cards.set(ref.id, { branchHashes: post.branchHashes, channelId: post.channelId })
    this.ctx.noteBotMsg(ref.id)
    return ref.id
  }

  /** Resolve a conflict-card action into a merge.resolve. */
  async resolve(action: IncomingAction): Promise<void> {
    const card = this.cards.get(action.ref.id)
    if (!card) {
      await action.respond('This conflict is no longer open.', { ephemeral: true })
      return
    }
    const ownerId = this.ctx.getOwnerForChannel(card.channelId)
    if (!ownerId || action.userId !== ownerId) {
      await action.respond('Only the owner can resolve this.', { ephemeral: true })
      return
    }

    if (action.actionId === 'cflt:write') {
      // Close the card and let the owner's own edit resolve the conflict: a new
      // owner-role edit is concurrent with and dominates both drafts, so the
      // derived projection clears the region (no lingering, re-firing card).
      this.cards.delete(action.ref.id)
      await action.update(`${action.message}\n\n-# ✏️ write your own — reply with your merge; it supersedes both drafts`)
      return
    }

    const m = /^cflt:take:(\d+)$/.exec(action.actionId)
    if (!m) return
    const idx = Number(m[1])
    const chosen = card.branchHashes[idx]
    if (!chosen) return

    // The resolution itself is a headless ledger verb — record merge.resolve,
    // flip lifecycles, surface the drop to each loser's inbox. This handler is
    // now a thin adapter over it (the owner gate above is the identity boundary
    // the core trusts).
    const result = await resolveConflict(this.ctx.store, this.ctx.ledger, {
      ownerId,
      channel: card.channelId,
      branchHashes: card.branchHashes,
      chosenHash: chosen,
      label: `took ${LETTERS[idx]}`,
    })
    this.cards.delete(action.ref.id)
    if (!result) {
      // Already resolved — e.g. another relay took a branch and this card is a
      // stale copy (cards aren't shared across relays). Close it gracefully.
      await action.respond('This conflict was already resolved.', { ephemeral: true })
      return
    }
    await action.update(`${action.message}\n\n-# ✓ took ${LETTERS[idx]}`)
  }
}
