/**
 * DiscordMessagingAdapter — the Discord implementation of the MessagingAdapter
 * seam. This is the ONLY module in the relay that imports `discord.js`. It owns
 * the `Client` (intents/partials), translates discord.js gateway events into the
 * normalized inbound shapes (`IncomingMessage` / `IncomingAction` /
 * `IncomingReaction`), and implements every outbound method by wrapping
 * discord.js. The host and its collaborators speak only `MessagingAdapter`.
 *
 * Lifecycle mirrors a Discord client: construct (registers handlers eagerly so
 * they're live the instant the gateway connects), `connect(token)` = login,
 * `disconnect()` = destroy. `botUserId`/`botLabel` are filled on `clientReady`.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  type Message,
  type ThreadChannel,
  type Interaction,
  type ButtonInteraction,
} from 'discord.js'
import type {
  MessagingAdapter,
  Capabilities,
  IncomingMessage,
  IncomingAction,
  IncomingReaction,
  MessageRef,
  ScopeId,
  SendOpts,
  Choice,
  Glyph,
} from '../messaging-adapter.ts'
import { normalizeUnicodeReaction } from '../messaging-fallback.ts'

/** Map a neutral Choice.style onto a Discord ButtonStyle. */
function buttonStyle(style: Choice['style']): ButtonStyle {
  switch (style) {
    case 'primary':
      return ButtonStyle.Primary
    case 'danger':
      return ButtonStyle.Danger
    default:
      return ButtonStyle.Secondary
  }
}

/** Build Discord ActionRow(s) from neutral choices. Discord caps a row at five
 *  components, so overflow spills into additional rows (the existing cards never
 *  exceed this, so behavior is identical for them). */
function rowsFor(choices: Choice[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let i = 0; i < choices.length; i += 5) {
    const slice = choices.slice(i, i + 5)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...slice.map(c => {
        const b = new ButtonBuilder().setCustomId(c.id).setLabel(c.label).setStyle(buttonStyle(c.style))
        if (c.glyph) b.setEmoji(c.glyph)
        return b
      }),
    )
    rows.push(row)
  }
  return rows
}

/** Discord's 2000-char message cap; we trim a hair under it (the old code used
 *  1899/1900 in spots — kept identical at each call site by the caller, this is
 *  only the hard ceiling). */
const MAX_LEN = 2000

export class DiscordMessagingAdapter implements MessagingAdapter {
  readonly platform = 'discord'

  private readonly client: Client
  private _botUserId: string | undefined
  /** The bot's tag (`name#1234`) once connected — for the operator console line. */
  private _botLabel: string | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Message, Partials.Reaction, Partials.Channel],
    })

    this.client.once('clientReady', c => {
      this._botUserId = c.user.id
      this._botLabel = c.user.tag
    })

    this.client.on('messageCreate', (msg: Message) => {
      const h = this.onMessageHandler
      if (!h) return
      // Self-filter is the host's job historically; we surface everyone and let
      // the host drop our own id. (Kept here too would be redundant.)
      try {
        h(this.toIncoming(msg))
      } catch {
        /* handler errors are isolated by the host's own catch */
      }
    })

    this.client.on('interactionCreate', (interaction: Interaction) => {
      if (!interaction.isButton()) return
      const h = this.onActionHandler
      if (!h) return
      h(this.toIncomingAction(interaction))
    })

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user.bot) return
      // Normalize to the project control vocabulary; ignore anything else so the
      // host only ever sees glyphs it acts on (Discord surfaces unicode names).
      const glyph = reaction.emoji.name ? normalizeUnicodeReaction(reaction.emoji.name) : undefined
      if (!glyph) return
      const h = this.onReactionHandler
      if (!h) return
      h({
        ref: { id: reaction.message.id, scope: reaction.message.channelId },
        glyph,
        userId: user.id,
      })
    })
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    await this.client.login(token)
  }

  async disconnect(): Promise<void> {
    await this.client.destroy()
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  /** The bot's display label (`name#1234`) once connected — for the console. */
  get botLabel(): string | undefined {
    return this._botLabel
  }

  capabilities(): Capabilities {
    return {
      reactions: 'any',
      threads: true,
      buttons: true,
      edit: true,
      pin: true,
      dm: true,
      mentions: 'native',
      maxMessageLength: MAX_LEN,
      // 10 MiB is Discord's default per-file floor; boosted servers allow more,
      // but we design for the floor (the ingest budget caps here too).
      files: { inbound: true, outbound: true, maxBytes: 10 * 1024 * 1024 },
    }
  }

  // ─── inbound ──────────────────────────────────────────────────────────────────

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.onMessageHandler = handler
  }

  onAction(handler: (a: IncomingAction) => void): void {
    this.onActionHandler = handler
  }

  onReaction(handler: (r: IncomingReaction) => void): void {
    this.onReactionHandler = handler
  }

  // ─── outbound ─────────────────────────────────────────────────────────────────

  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    const ch = await this.client.channels.fetch(scope).catch(() => null)
    if (!ch || !('send' in ch)) return undefined
    try {
      const sent = await (ch as { send: Function }).send(this.buildPayload(text, opts))
      return { id: sent.id, scope }
    } catch {
      return undefined
    }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    const ch = await this.client.channels.fetch(ref.scope).catch(() => null)
    if (!ch || !ch.isTextBased()) return false
    try {
      const msg = await (ch as { messages: { fetch: (id: string) => Promise<any> } }).messages.fetch(ref.id)
      await msg.edit(this.buildPayload(text, opts))
      return true
    } catch {
      return false
    }
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const msg = await this.fetchMessage(ref)
    await msg?.react(glyph).catch(() => {})
  }

  async unreact(ref: MessageRef, glyph: Glyph): Promise<void> {
    const msg = await this.fetchMessage(ref)
    const botId = this._botUserId ?? ''
    await msg?.reactions.cache.get(glyph)?.users.remove(botId).catch(() => {})
  }

  async pin(ref: MessageRef): Promise<void> {
    const msg = await this.fetchMessage(ref)
    await (msg as { pin?: () => Promise<unknown> } | undefined)?.pin?.().catch(() => {})
  }

  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    try {
      const user = await this.client.users.fetch(userId)
      const dm = await user.createDM()
      const sent = await dm.send(this.buildPayload(text, opts))
      return { id: sent.id, scope: dm.id }
    } catch {
      return undefined
    }
  }

  typing(scope: ScopeId): void {
    void this.client.channels
      .fetch(scope)
      .then(ch => {
        if (ch && 'sendTyping' in ch) {
          return (ch as { sendTyping: () => Promise<void> }).sendTyping()
        }
      })
      .catch(() => {})
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  /** Spawn (or reuse) a task thread off a message. Race-tolerant: a concurrent
   *  starter wins and we refetch to adopt its thread. Returns undefined when a
   *  thread can't be made (missing perms), so the host runs at the room scope. */
  async startThread(ref: MessageRef, name: string): Promise<ScopeId | undefined> {
    const msg = await this.fetchMessage(ref)
    if (!msg) return undefined
    if (msg.hasThread) return (msg.thread as ThreadChannel | null)?.id
    try {
      const thread = (await msg.startThread({ name, autoArchiveDuration: 1440 })) as ThreadChannel
      return thread.id
    } catch {
      const fresh = await msg.fetch().catch(() => null)
      return (fresh?.thread as ThreadChannel | null)?.id
    }
  }

  /** Resolve a thread scope to its parent room channel id, else undefined (a
   *  plain channel has no parent here — the caller treats that as "is its own
   *  room"). Reads the Discord channel cache (no fetch). */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return this.parentOfSync(scope)
  }

  /** Synchronous cache-only parent lookup — the same `client.channels.cache`
   *  read the host's `roomForScope` did inline before this seam existed. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    const ch = this.client.channels.cache.get(scope) as { parentId?: string | null } | undefined
    return ch?.parentId ?? undefined
  }

  // ─── Discord-specific helpers (no neutral home) ───────────────────────────────

  /** Human-readable label for a scope, from the live Message — the same content
   *  agent-host.describeChannel produced. Discord-specific formatting, so it
   *  lives here; surfaced to the host as `IncomingMessage.scopeLabel`. */
  private describeChannel(msg: Message): string {
    const ch = msg.channel as { name?: string; isThread?: () => boolean; parent?: { name?: string } }
    if (msg.channel.isThread?.() && ch.parent?.name) {
      return `#${ch.parent.name} › ${ch.name ?? 'thread'}`
    }
    if (ch.name) return `#${ch.name}`
    if (msg.channel.isDMBased?.()) return 'DM'
    return `#${msg.channelId}`
  }

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(msg: Message): IncomingMessage {
    return {
      ref: { id: msg.id, scope: msg.channelId },
      scope: msg.channelId,
      authorId: msg.author.id,
      authorName: msg.author.username ?? msg.author.id,
      text: msg.content,
      // `mentions.has(id)` matches a direct @user, a role the bot has, or
      // @everyone — exactly what the host's old `msg.mentions.has(client.user)`
      // check did. Only true once we know our own id (post-clientReady).
      mentionsBot: this._botUserId ? msg.mentions.has(this._botUserId) : false,
      replyToMessageId: msg.reference?.messageId ?? undefined,
      isThread: msg.channel.isThread(),
      scopeLabel: this.describeChannel(msg),
      attachments: msg.attachments.size
        ? [...msg.attachments.values()].map(a => ({
            name: a.name ?? a.id,
            url: a.url,
            contentType: a.contentType ?? undefined,
            sizeBytes: a.size,
            ref: a.id,
          }))
        : undefined,
    }
  }

  private toIncomingAction(interaction: ButtonInteraction): IncomingAction {
    return {
      actionId: interaction.customId,
      userId: interaction.user.id,
      ref: { id: interaction.message.id, scope: interaction.message.channelId },
      scope: interaction.message.channelId,
      message: interaction.message.content,
      respond: async (text, opts) => {
        await interaction
          .reply({ content: text, ...(opts?.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) })
          .catch(() => {})
      },
      update: async (text, opts) => {
        const components = opts?.choices ? rowsFor(opts.choices) : []
        await interaction.update({ content: text, components }).catch(() => {})
      },
    }
  }

  /** Resolve the bot's reply-target check: is `messageId` one of OUR messages?
   *  Discord exposes a reply target only by fetching the referenced message; the
   *  host needs this for the "reply to a recent bot message counts as a mention"
   *  rule. Surfaced as an adapter helper because it's Discord plumbing. */
  async authoredByBot(scope: ScopeId, messageId: string): Promise<boolean> {
    const ch = await this.client.channels.fetch(scope).catch(() => null)
    if (!ch || !ch.isTextBased()) return false
    try {
      const msg = await (ch as { messages: { fetch: (id: string) => Promise<any> } }).messages.fetch(messageId)
      return msg.author.id === this._botUserId
    } catch {
      return false
    }
  }

  private buildPayload(
    text: string,
    opts?: SendOpts,
  ): { content: string; components?: any[]; files?: AttachmentBuilder[] } {
    const mention = opts?.mentionUser ? `<@${opts.mentionUser}> ` : ''
    const full = mention + text
    const trimmed = full.length > MAX_LEN ? full.slice(0, MAX_LEN - 1) + '…' : full
    const payload: { content: string; components?: any[]; files?: AttachmentBuilder[] } = {
      content: trimmed,
    }
    if (opts?.choices && opts.choices.length > 0) payload.components = rowsFor(opts.choices)
    if (opts?.files && opts.files.length > 0) {
      payload.files = opts.files.map(f => {
        const src = 'path' in f.data ? f.data.path : Buffer.from(f.data)
        return new AttachmentBuilder(src as any, { name: f.name })
      })
    }
    return payload
  }

  /** Download an inbound attachment's bytes. Discord CDN URLs are signed and
   *  expiring, so the ingest sync fetches immediately rather than persisting the
   *  URL. Returns undefined on failure (the caller surfaces a fetch-failed note). */
  async downloadAttachment(url: string): Promise<Uint8Array | undefined> {
    try {
      // Bounded: ingest runs inline ahead of the turn (see relay registration
      // order), so a hung fetch must not stall the turn indefinitely.
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return undefined
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return undefined
    }
  }

  private async fetchMessage(ref: MessageRef): Promise<Message | undefined> {
    const ch = await this.client.channels.fetch(ref.scope).catch(() => null)
    if (!ch || !ch.isTextBased()) return undefined
    try {
      return await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(ref.id)
    } catch {
      return undefined
    }
  }
}
