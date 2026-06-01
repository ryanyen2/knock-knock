/**
 * Approvals — Discord UX for ask-tier tool permission requests.
 *
 * Phase 3 collapses this service to its UX role: it posts Discord prompts,
 * routes button clicks and reactions to ledger admissions. The Promise-
 * resolving `pending: Map` from Phase 0 is gone — the adapter's permission
 * handler now waits via `await-verdict.ts`, which subscribes to the store
 * and resolves on any admitted tool.approved/tool.denied caused_by the
 * tool.requested hash.
 *
 * Only state held here is an in-memory `messageToHash: Map<string, Hash>`
 * so a ✅/❌ reaction can find the interaction that the Discord message
 * was prompting for. The map IS recoverable from the ledger (an
 * `approval.posted` verb in Phase 3.1 would journal it), but for Phase 3
 * we keep it in-process and document the gap.
 *
 * The button customId embeds a 10-char prefix of the tool.requested hash —
 * Discord caps customId at 100 chars and `appr:allow:<10-hex>` fits with
 * room to spare. Cross-host approval flow (Phase 4) resolves the full hash
 * via fold lookup over the approval concept.
 */

import {
  type Client,
  type ButtonInteraction,
  type TextBasedChannel,
  type GuildTextBasedChannel,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js'
import type { AgentConfig } from './lib.ts'
import { approverForAgent } from './lib.ts'
import type { ChannelId, Hash } from './ledger/interaction.ts'
import type { Store } from './ledger/store.ts'
import { admit } from './ledger/admit.ts'

const HASH_PREFIX_LEN = 10
const RECENT_HASHES_CAP = 256

type PromptDelivery = { destination: 'dm' | 'channel'; reason?: string }

type PostedPrompt = {
  /** Full tool.requested hash. */
  hash: Hash
  /** The originating channel — used to look up the approver and to set the
   *  channel on admitted tool.approved/denied so the audit is per-channel. */
  originChannelId: ChannelId
  /** Where the prompt landed (DM channel id or origin channel id). */
  promptChannelId: string
  discordMessageId: string
}

export class Approvals {
  /** messageId → posted prompt (for reaction lookup). */
  private readonly byMessageId = new Map<string, PostedPrompt>()
  /** hashPrefix → posted prompt (for button customId lookup). */
  private readonly byHashPrefix = new Map<string, PostedPrompt>()
  /** Rolling cap so dead messages don't leak memory. */
  private readonly recencyOrder: string[] = []

  constructor(
    private readonly client: Client,
    /** Re-read on each resolution so owner changes take effect without restart. */
    private readonly getAgent: () => AgentConfig,
    /** The shared ledger store; verdicts admit through admit() here. */
    private readonly store: Store,
    /** Operator console hook so the destination of each prompt is visible. */
    private readonly onDelivery?: (info: PromptDelivery) => void,
  ) {}

  /**
   * Post a Discord prompt for the given tool.requested. Returns void —
   * the caller doesn't wait on this. The await for the verdict happens via
   * `awaitVerdict` (ledger subscription) elsewhere.
   */
  async postDiscord(opts: {
    channelId: ChannelId
    toolRequestedHash: Hash
    toolName: string
    input: unknown
  }): Promise<void> {
    const prefix = opts.toolRequestedHash.slice(0, HASH_PREFIX_LEN)

    const agent = this.getAgent()
    const approverId = approverForAgent(agent, opts.channelId)
    const preview = JSON.stringify(opts.input, null, 2)
    const shortPreview = preview.length > 280 ? preview.slice(0, 280) + '…' : preview
    const body = `🔐 Permission request: **${opts.toolName}**\n\`\`\`\n${shortPreview}\n\`\`\``

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`appr:allow:${prefix}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`appr:deny:${prefix}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )

    const target = await this._resolveTarget(approverId, opts.channelId)
    if (!target) {
      // Can't reach a channel — emit a `tool.denied` so the awaiter resolves.
      await this._emitVerdict(opts, 'system:approvals', 'deny', 'Cannot reach a channel for approval prompt.')
      return
    }

    try {
      const content =
        target.kind === 'dm'
          ? body
          : (approverId ? `<@${approverId}> ` : '') + body
      const trimmed = content.length > 1900 ? content.slice(0, 1899) + '…' : content
      const sent = await (target.channel as TextBasedChannel & { send: Function }).send({
        content: trimmed,
        components: [row],
      })
      const posted: PostedPrompt = {
        hash: opts.toolRequestedHash,
        originChannelId: opts.channelId,
        promptChannelId: target.channel.id,
        discordMessageId: sent.id,
      }
      this._remember(posted, prefix)
      this.onDelivery?.({ destination: target.kind, reason: target.reason })
    } catch (e) {
      // Posting failed — admit a synthetic deny so the awaiter doesn't hang.
      await this._emitVerdict(
        opts,
        'system:approvals',
        'deny',
        `Failed to post approval request: ${e}`,
      )
    }
  }

  async resolveInteraction(interaction: ButtonInteraction): Promise<void> {
    const m = /^appr:(allow|deny):(\w+)$/.exec(interaction.customId)
    if (!m) return
    const [, behavior, prefix] = m
    const posted = this.byHashPrefix.get(prefix!)
    if (!posted) {
      await interaction.reply({ content: 'Request no longer pending.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    const agent = this.getAgent()
    const approverId = approverForAgent(agent, posted.originChannelId)
    if (!approverId || interaction.user.id !== approverId) {
      await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    // Update the prompt message to reflect the decision.
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction
      .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
      .catch(() => {})

    await this._emitVerdict(
      { channelId: posted.originChannelId, toolRequestedHash: posted.hash },
      approverId,
      behavior as 'allow' | 'deny',
      behavior === 'allow' ? undefined : 'Denied by owner.',
    )
    this._forget(posted)
  }

  async resolveReaction(messageId: string, emoji: string, userId: string): Promise<void> {
    if (emoji !== '✅' && emoji !== '❌') return
    const posted = this.byMessageId.get(messageId)
    if (!posted) return
    const agent = this.getAgent()
    const approverId = approverForAgent(agent, posted.originChannelId)
    if (!approverId || userId !== approverId) return

    try {
      const ch = await this.client.channels.fetch(posted.promptChannelId)
      if (ch && ch.isTextBased()) {
        const msg = await (ch as GuildTextBasedChannel).messages.fetch(messageId)
        const label = emoji === '✅' ? '✅ Allowed' : '❌ Denied'
        await msg.edit({ content: `${msg.content}\n\n${label}`, components: [] })
      }
    } catch {}

    const behavior: 'allow' | 'deny' = emoji === '✅' ? 'allow' : 'deny'
    await this._emitVerdict(
      { channelId: posted.originChannelId, toolRequestedHash: posted.hash },
      approverId,
      behavior,
      behavior === 'allow' ? undefined : 'Denied by owner.',
    )
    this._forget(posted)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _remember(posted: PostedPrompt, prefix: string): void {
    this.byMessageId.set(posted.discordMessageId, posted)
    this.byHashPrefix.set(prefix, posted)
    this.recencyOrder.push(posted.discordMessageId)
    while (this.recencyOrder.length > RECENT_HASHES_CAP) {
      const old = this.recencyOrder.shift()
      if (old) {
        const p = this.byMessageId.get(old)
        if (p) {
          this.byMessageId.delete(old)
          this.byHashPrefix.delete(p.hash.slice(0, HASH_PREFIX_LEN))
        }
      }
    }
  }

  private _forget(posted: PostedPrompt): void {
    this.byMessageId.delete(posted.discordMessageId)
    this.byHashPrefix.delete(posted.hash.slice(0, HASH_PREFIX_LEN))
  }

  private async _emitVerdict(
    opts: { channelId: ChannelId; toolRequestedHash: Hash },
    actor: string,
    behavior: 'allow' | 'deny',
    deniedReason: string | undefined,
  ): Promise<void> {
    await admit(this.store, {
      actor,
      role: 'owner',
      channel: opts.channelId,
      target: {
        artifactId: `extp:tool/${opts.toolRequestedHash}`,
        anchor: { kind: 'proxy', proxyId: opts.toolRequestedHash },
      },
      verb: behavior === 'allow' ? 'tool.approved' : 'tool.denied',
      patch: {
        kind: 'external',
        intent: {
          channel: 'tool',
          op: 'verdict',
          args: deniedReason ? { behavior, reason: deniedReason } : { behavior },
        },
      },
      effect: 'external',
      caused_by: [opts.toolRequestedHash],
    })
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
}
