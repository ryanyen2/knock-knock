/**
 * ConflictUI (§4.2) — on a held equal-role conflict, post a Take A / Take B /
 * Write card; a button click admits an owner merge.resolve and surfaces the
 * drop back to each loser's inbox. Owns the open-card bookkeeping.
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js'
import type { HostContext } from './context.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { resolveConflict } from '../ledger/resolve-conflict.ts'
import { LETTERS } from '../ledger/render/surface.ts'
import type { ConflictCardPost } from '../ledger/synchronizations/conflict-card.ts'

export class ConflictUI {
  /** Conflict card messageId → its branch hashes, for button resolution. */
  private readonly cards = new Map<string, { branchHashes: Hash[]; channelId: ChannelId }>()

  constructor(private readonly ctx: HostContext) {}

  /** Does this button click target one of our open conflict cards? */
  handles(interaction: ButtonInteraction): boolean {
    return interaction.customId.startsWith('cflt:')
  }

  /**
   * Post a conflict card with Take A / Take B / … / Write buttons. The branch
   * hashes are remembered against the message so a click resolves to a
   * merge.resolve. Returns the posted message id.
   */
  async postCard(post: ConflictCardPost): Promise<string | undefined> {
    const ch = await this.ctx.client.channels.fetch(post.channelId).catch(() => null)
    if (!ch || !('send' in ch)) return undefined

    const buttons = post.branchHashes.slice(0, LETTERS.length).map((_, idx) =>
      new ButtonBuilder()
        .setCustomId(`cflt:take:${idx}`)
        .setLabel(`Take ${String.fromCharCode(65 + idx)}`)
        .setEmoji(LETTERS[idx]!)
        .setStyle(ButtonStyle.Secondary),
    )
    buttons.push(
      new ButtonBuilder()
        .setCustomId('cflt:write')
        .setLabel('Write my own')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
    )
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)

    const sent = await (ch as { send: Function }).send({ content: post.text, components: [row] })
    this.cards.set(sent.id, { branchHashes: post.branchHashes, channelId: post.channelId })
    this.ctx.noteBotMsg(sent.id)
    return sent.id
  }

  /** Resolve a conflict-card button click into a merge.resolve. */
  async resolve(interaction: ButtonInteraction): Promise<void> {
    const card = this.cards.get(interaction.message.id)
    if (!card) {
      await interaction.reply({ content: 'This conflict is no longer open.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }
    const ownerId = this.ctx.getOwnerForChannel(card.channelId)
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the owner can resolve this.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    if (interaction.customId === 'cflt:write') {
      await interaction
        .reply({ content: 'Reply in this channel with your merge — it supersedes both drafts.', flags: MessageFlags.Ephemeral })
        .catch(() => {})
      return
    }

    const m = /^cflt:take:(\d+)$/.exec(interaction.customId)
    if (!m) return
    const idx = Number(m[1])
    const chosen = card.branchHashes[idx]
    if (!chosen) return

    // The resolution itself is a headless ledger verb — record merge.resolve,
    // flip lifecycles, surface the drop to each loser's inbox. This Discord
    // handler is now a thin adapter over it (the owner gate above is the
    // identity boundary the core trusts).
    const result = await resolveConflict(this.ctx.store, this.ctx.ledger, {
      ownerId,
      channel: card.channelId,
      branchHashes: card.branchHashes,
      chosenHash: chosen,
      label: `took ${LETTERS[idx]}`,
    })
    if (!result) return

    this.cards.delete(interaction.message.id)
    await interaction
      .update({ content: `${interaction.message.content}\n\n-# ✓ took ${LETTERS[idx]}`, components: [] })
      .catch(() => {})
  }
}
