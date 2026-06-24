// ConflictUI — on a held equal-role conflict, post a Take A/B/Write card; a
// click admits an owner merge.resolve and surfaces the drop to losers' inboxes.

import type { HostContext } from './context.ts'
import type { IncomingAction, Choice } from '../messaging-adapter.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { resolveConflict } from '../ledger/resolve-conflict.ts'
import { LETTERS } from '../ledger/render/surface.ts'
import type { ConflictCardPost } from '../ledger/synchronizations/conflict-card.ts'

export class ConflictUI {
  private readonly cards = new Map<string, { branchHashes: Hash[]; channelId: ChannelId }>()

  constructor(private readonly ctx: HostContext) {}

  /** Does this action target one of our open conflict cards? */
  handles(action: IncomingAction): boolean {
    return action.actionId.startsWith('cflt:')
  }

  /** Post a Take A/B/…/Write card; remember branch hashes for click resolution. */
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
      // Owner's own concurrent edit dominates both drafts and clears the region.
      this.cards.delete(action.ref.id)
      await action.update(`${action.message}\n\n-# ✏️ write your own — reply with your merge; it supersedes both drafts`)
      return
    }

    const m = /^cflt:take:(\d+)$/.exec(action.actionId)
    if (!m) return
    const idx = Number(m[1])
    const chosen = card.branchHashes[idx]
    if (!chosen) return

    // Headless ledger verb; owner-gated above.
    const result = await resolveConflict(this.ctx.store, this.ctx.ledger, {
      ownerId,
      channel: card.channelId,
      branchHashes: card.branchHashes,
      chosenHash: chosen,
      label: `took ${LETTERS[idx]}`,
    })
    this.cards.delete(action.ref.id)
    if (!result) {
      // Already resolved (e.g. another relay took a branch; cards aren't shared).
      await action.respond('This conflict was already resolved.', { ephemeral: true })
      return
    }
    await action.update(`${action.message}\n\n-# ✓ took ${LETTERS[idx]}`)
  }
}
