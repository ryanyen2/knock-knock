/**
 * Approvals — relay-level service for interactive tool-permission requests.
 * Mints a correlationId, posts Allow/Deny buttons to Discord, verifies the
 * approver's identity, and resolves the pending promise on click or timeout.
 * Supports both button interactions (interactionCreate) and ✅/❌ reactions
 * (messageReactionAdd).
 */

import {
  type Client,
  type ButtonInteraction,
  type TextBasedChannel,
  type GuildTextBasedChannel,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js'
import type { AgentConfig } from './lib.ts'
import { approverForAgent } from './lib.ts'
import type { Verdict } from './agent-adapter.ts'

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

type PendingApproval = {
  resolver: (verdict: Verdict) => void
  timer: ReturnType<typeof setTimeout>
  channelId: string
  messageId?: string
}

export class Approvals {
  private pending = new Map<string, PendingApproval>()
  private msgToCorr = new Map<string, string>() // Discord msgId → correlationId

  constructor(
    private readonly client: Client,
    /** Re-read on each resolution so owner changes take effect without restart. */
    private readonly getAgent: () => AgentConfig,
  ) {}

  request(opts: {
    channelId: string
    toolName: string
    input: unknown
  }): Promise<Verdict> {
    const { channelId, toolName, input } = opts
    const correlationId = Math.random().toString(36).slice(2, 10)

    return new Promise<Verdict>(resolve => {
      const pending: PendingApproval = {
        resolver: resolve,
        channelId,
        timer: setTimeout(() => {
          this.pending.delete(correlationId)
          if (pending.messageId) this.msgToCorr.delete(pending.messageId)
          resolve({ behavior: 'deny', message: 'Approval timed out.' })
        }, APPROVAL_TIMEOUT_MS),
      }
      this.pending.set(correlationId, pending)

      void this._postPrompt(correlationId, pending, channelId, toolName, input)
    })
  }

  private async _postPrompt(
    correlationId: string,
    pending: PendingApproval,
    channelId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> {
    try {
      const ch = await this.client.channels.fetch(channelId)
      if (!ch || !('send' in ch)) {
        this._fail(correlationId, pending, 'Cannot reach channel for approval prompt.')
        return
      }

      const agent = this.getAgent()
      const ownerId = approverForAgent(agent, channelId)

      const preview = JSON.stringify(input, null, 2)
      const shortPreview = preview.length > 280 ? preview.slice(0, 280) + '…' : preview
      let text = ownerId ? `<@${ownerId}> ` : ''
      text += `🔐 Permission request: **${toolName}**`
      text += `\n\`\`\`\n${shortPreview}\n\`\`\``
      if (text.length > 1900) text = text.slice(0, 1899) + '…'

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`appr:allow:${correlationId}`)
          .setLabel('Allow')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`appr:deny:${correlationId}`)
          .setLabel('Deny')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger),
      )

      const sent = await (ch as TextBasedChannel & { send: Function }).send({
        content: text,
        components: [row],
      })
      pending.messageId = sent.id
      this.msgToCorr.set(sent.id, correlationId)
    } catch (e) {
      this._fail(correlationId, pending, `Failed to post approval request: ${e}`)
    }
  }

  private _fail(correlationId: string, pending: PendingApproval, message: string): void {
    clearTimeout(pending.timer)
    this.pending.delete(correlationId)
    pending.resolver({ behavior: 'deny', message })
  }

  async resolveInteraction(interaction: ButtonInteraction): Promise<void> {
    const m = /^appr:(allow|deny):(\w+)$/.exec(interaction.customId)
    if (!m) return

    const [, behavior, correlationId] = m

    // Fetch pending first so we have channelId for the per-channel owner check.
    const pending = this.pending.get(correlationId!)
    if (!pending) {
      await interaction.reply({ content: 'Request no longer pending.', ephemeral: true }).catch(() => {})
      return
    }

    const agent = this.getAgent()
    const ownerId = approverForAgent(agent, pending.channelId)
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
      return
    }

    clearTimeout(pending.timer)
    this.pending.delete(correlationId!)
    if (pending.messageId) this.msgToCorr.delete(pending.messageId)

    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction
      .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
      .catch(() => {})

    const verdict: Verdict =
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied by owner.' }
    pending.resolver(verdict)
  }

  async resolveReaction(messageId: string, emoji: string, userId: string): Promise<void> {
    const correlationId = this.msgToCorr.get(messageId)
    if (!correlationId) return
    if (emoji !== '✅' && emoji !== '❌') return

    // Fetch pending before the owner check so we have channelId for approverForAgent.
    const pending = this.pending.get(correlationId)
    if (!pending) return

    const agent = this.getAgent()
    const ownerId = approverForAgent(agent, pending.channelId)
    if (!ownerId || userId !== ownerId) return

    clearTimeout(pending.timer)
    this.pending.delete(correlationId)
    this.msgToCorr.delete(messageId)

    // Update the prompt message to reflect the decision
    try {
      const ch = await this.client.channels.fetch(pending.channelId)
      if (ch && ch.isTextBased() && !ch.isDMBased()) {
        const msg = await (ch as GuildTextBasedChannel).messages.fetch(messageId)
        const label = emoji === '✅' ? '✅ Allowed' : '❌ Denied'
        await msg.edit({ content: `${msg.content}\n\n${label}`, components: [] })
      }
    } catch {}

    const behavior = emoji === '✅' ? 'allow' : 'deny'
    const verdict: Verdict =
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied by owner.' }
    pending.resolver(verdict)
  }
}
