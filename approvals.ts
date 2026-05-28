/**
 * Approvals — relay-level service for interactive tool-permission requests.
 * Mints a correlationId, posts Allow/Deny buttons to Discord, verifies the
 * approver's identity, and resolves the pending promise on click or timeout.
 * Supports both button interactions (interactionCreate) and ✅/❌ reactions
 * (messageReactionAdd).
 *
 * Delivery preference: the prompt is sent to the approver's DM whenever
 * possible — that way private tool decisions stay private. If the DM cannot
 * be opened (DMs closed, blocked, etc.) we fall back to the originating
 * channel so the agent never silently stalls.
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
  /** Where the prompt actually landed (DM channel id or origin channel id). */
  promptChannelId: string
  /** Where the work originated; used to resolve the approver via approverForAgent. */
  originChannelId: string
  messageId?: string
}

export class Approvals {
  private pending = new Map<string, PendingApproval>()
  private msgToCorr = new Map<string, string>() // Discord msgId → correlationId

  constructor(
    private readonly client: Client,
    /** Re-read on each resolution so owner changes take effect without restart. */
    private readonly getAgent: () => AgentConfig,
    /** Optional hook for the operator console to note where the prompt landed. */
    private readonly onDelivery?: (info: { destination: 'dm' | 'channel'; reason?: string }) => void,
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
        promptChannelId: channelId,
        originChannelId: channelId,
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
      const agent = this.getAgent()
      const approverId = approverForAgent(agent, channelId)

      const preview = JSON.stringify(input, null, 2)
      const shortPreview = preview.length > 280 ? preview.slice(0, 280) + '…' : preview
      const body =
        `🔐 Permission request: **${toolName}**` +
        `\n\`\`\`\n${shortPreview}\n\`\`\``

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

      // Prefer the approver's DM; fall back to the originating channel.
      const target = await this._resolveTarget(approverId, channelId)
      if (!target) {
        this._fail(correlationId, pending, 'Cannot reach a channel for approval prompt.')
        return
      }

      const content =
        target.kind === 'dm'
          ? body
          : (approverId ? `<@${approverId}> ` : '') + body
      const trimmed = content.length > 1900 ? content.slice(0, 1899) + '…' : content

      const sent = await (target.channel as TextBasedChannel & { send: Function }).send({
        content: trimmed,
        components: [row],
      })
      pending.promptChannelId = target.channel.id
      pending.messageId = sent.id
      this.msgToCorr.set(sent.id, correlationId)
      this.onDelivery?.({ destination: target.kind, reason: target.reason })
    } catch (e) {
      this._fail(correlationId, pending, `Failed to post approval request: ${e}`)
    }
  }

  /** Try DM first; on failure, return the origin channel so the agent isn't stuck. */
  private async _resolveTarget(
    approverId: string | undefined,
    originChannelId: string,
  ): Promise<
    | { kind: 'dm'; channel: TextBasedChannel & { id: string }; reason?: string }
    | { kind: 'channel'; channel: TextBasedChannel & { id: string }; reason?: string }
    | undefined
  > {
    if (approverId) {
      try {
        const user = await this.client.users.fetch(approverId)
        const dm = await user.createDM()
        return { kind: 'dm', channel: dm }
      } catch (e) {
        // DM unavailable — fall through to the originating channel.
        const reason = `DM unavailable: ${e instanceof Error ? e.message : String(e)}`
        const ch = await this.client.channels.fetch(originChannelId).catch(() => null)
        if (ch && 'send' in ch) {
          return { kind: 'channel', channel: ch as TextBasedChannel & { id: string }, reason }
        }
        return undefined
      }
    }
    const ch = await this.client.channels.fetch(originChannelId).catch(() => null)
    if (ch && 'send' in ch) {
      return { kind: 'channel', channel: ch as TextBasedChannel & { id: string } }
    }
    return undefined
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
    const approverId = approverForAgent(agent, pending.originChannelId)
    if (!approverId || interaction.user.id !== approverId) {
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

    const pending = this.pending.get(correlationId)
    if (!pending) return

    const agent = this.getAgent()
    const approverId = approverForAgent(agent, pending.originChannelId)
    if (!approverId || userId !== approverId) return

    clearTimeout(pending.timer)
    this.pending.delete(correlationId)
    this.msgToCorr.delete(messageId)

    // Update the prompt message to reflect the decision.
    try {
      const ch = await this.client.channels.fetch(pending.promptChannelId)
      if (ch && ch.isTextBased()) {
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
