/**
 * DiscordMessagingAdapter — the Discord implementation of MessagingAdapter.
 * The only module that imports `discord.js`.
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
  DiscoveryCapabilities,
  DiscoveredEntity,
  EnumerationOutcome,
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

/** Build Discord ActionRow(s) from neutral choices (5 per row, overflow spills). */
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

/** Discord's 2000-char message cap. */
const MAX_LEN = 2000

export class DiscordMessagingAdapter implements MessagingAdapter {
  readonly platform = 'discord'

  private readonly client: Client
  private _botUserId: string | undefined
  private _botLabel: string | undefined
  private _botRoleIds: string[] | undefined

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
      // Collect this bot's role ids across the guilds it's in. A bot whose name collides
      // with its managed role gets addressed via that role's mention (`<@&roleId>`), so the
      // directory must know which roles map back to this bot for directed routing.
      const roles = new Set<string>()
      for (const g of c.guilds.cache.values()) {
        const me = g.members.me
        if (!me) continue
        // Skip @everyone (its role id == the guild id) — it's never an explicit mention.
        for (const id of me.roles.cache.keys()) if (id !== g.id) roles.add(id)
      }
      this._botRoleIds = [...roles]
    })

    this.client.on('messageCreate', (msg: Message) => {
      const h = this.onMessageHandler
      if (!h) return
      // Self-filter is the host's job; surface everyone.
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
      // Normalize to the control vocabulary; ignore anything else.
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

  // Discord is single-token; `secrets` (unused) is part of the seam contract.
  async connect(token: string, _secrets?: Record<string, string>): Promise<void> {
    // `login()` resolves once the gateway handshake STARTS — before the `clientReady`
    // event that populates `_botUserId`/`_botLabel`. Callers (AgentHost.start →
    // publishIdentity) need the bot's own user id immediately after connect, so wait
    // for ready. Without this, publishIdentity sees `botUserId === undefined` and
    // silently skips — leaving the agent absent from the shared directory, which breaks
    // @mention routing, peer-bot recognition, and mesh provenance.
    const ready = this._botUserId
      ? Promise.resolve()
      : new Promise<void>(resolve => this.client.once('clientReady', () => resolve()))
    await this.client.login(token)
    await ready
  }

  async disconnect(): Promise<void> {
    await this.client.destroy()
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botRoleIds(): string[] | undefined {
    return this._botRoleIds
  }

  /** The bot's display label (`name#1234`) once connected. */
  get botLabel(): string | undefined {
    return this._botLabel
  }

  discoveryCapabilities(): DiscoveryCapabilities {
    // Guild channels and members are both enumerable (members need the privileged
    // guild-members intent — if it's been revoked the runtime call degrades), and the
    // bot can create a channel for transport.
    return { selfId: true, channelEnumeration: true, memberEnumeration: true, channelCreation: true }
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
      // 10 MiB is Discord's default per-file floor; we design for the floor.
      files: { inbound: true, outbound: true, maxBytes: 10 * 1024 * 1024 },
    }
  }

  // ─── discovery enumeration (duck-typed, three-valued) ──────────────────────────
  // Deliberately OFF the MessagingAdapter interface (like fetchRecent): the gap-resolver
  // duck-types these. Present only where DiscoveryCapabilities says so — absence ⇒ the
  // caller infers `unsupported`. A present method NEVER returns `unsupported`; a runtime
  // platform rejection (e.g. revoked guild-members intent) degrades with a reason.

  /** Enumerate the bot's text CHANNELS (not threads) across the guilds it can see. Threads are
   *  sub-scopes of a channel, not a project boundary, so they're excluded from the channel pick. */
  async listChannels(): Promise<EnumerationOutcome> {
    try {
      const items: DiscoveredEntity[] = []
      for (const guild of this.client.guilds.cache.values()) {
        for (const ch of guild.channels.cache.values()) {
          if (ch.isTextBased() && !ch.isThread() && ch.name) items.push({ id: ch.id, label: ch.name })
        }
      }
      return { kind: 'results', items }
    } catch {
      return { kind: 'degraded', reason: 'could not list Discord channels' }
    }
  }

  /** Enumerate non-bot members of a channel's guild. Needs the privileged Guild Members intent;
   *  without it `members.fetch()` would HANG waiting for chunks, so it's bounded by `time` and a
   *  timeout/rejection degrades to the nonce/manual rung (R21). */
  async listMembers(channelId: string): Promise<EnumerationOutcome> {
    try {
      const ch =
        this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId))
      const guild = (ch as { guild?: import('discord.js').Guild } | null)?.guild
      if (!guild) return { kind: 'degraded', reason: 'channel is not in a guild' }
      const members = await guild.members.fetch({ time: 7_000 })
      const items: DiscoveredEntity[] = []
      for (const m of members.values()) {
        if (!m.user.bot) items.push({ id: m.id, label: m.user.username })
      }
      return { kind: 'results', items }
    } catch {
      return { kind: 'degraded', reason: 'member list unavailable — enable the Server Members Intent in the Discord developer portal, or use nonce capture' }
    }
  }

  /** Create a transport channel in the first guild this bot is in. */
  async createChannel(name: string): Promise<EnumerationOutcome> {
    try {
      const guild = this.client.guilds.cache.values().next().value
      if (!guild) return { kind: 'degraded', reason: 'bot is not in any guild' }
      const ch = await guild.channels.create({ name })
      return { kind: 'results', items: [{ id: ch.id, label: ch.name }] }
    } catch {
      return { kind: 'degraded', reason: 'could not create Discord channel' }
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

  /** Spawn (or reuse) a task thread off a message. Race-tolerant. Returns
   *  undefined when a thread can't be made, so the host runs at the room scope. */
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

  /** Resolve a thread scope to its parent room channel id, else undefined. */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return this.parentOfSync(scope)
  }

  /** Synchronous cache-only parent lookup. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    const ch = this.client.channels.cache.get(scope) as { parentId?: string | null } | undefined
    return ch?.parentId ?? undefined
  }

  // ─── Discord-specific helpers ───────────────────────────────

  /** Human-readable label for a scope, from the live Message. */
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
      // Only true once we know our own id (post-clientReady).
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

  /** Is `messageId` one of OUR messages? (reply-to-bot counts as a mention). */
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
  ): {
    content: string
    components?: any[]
    files?: AttachmentBuilder[]
    allowedMentions?: { parse: []; users?: string[] }
  } {
    const mention = opts?.mentionUser ? `<@${opts.mentionUser}> ` : ''
    const full = mention + text
    const trimmed = full.length > MAX_LEN ? full.slice(0, MAX_LEN - 1) + '…' : full
    const payload: {
      content: string
      components?: any[]
      files?: AttachmentBuilder[]
      allowedMentions?: { parse: []; users?: string[] }
    } = {
      content: trimmed,
    }
    // Suppress pings on status surfaces: the echoed prompt's `<@id>` markup stays in the
    // text but Discord won't parse it as a mention, so peer bots aren't re-triggered.
    // `mentionOnly` is the same suppression but whitelists one user (the approver).
    if (opts?.mentionOnly) payload.allowedMentions = { parse: [], users: [opts.mentionOnly] }
    else if (opts?.suppressMentions) payload.allowedMentions = { parse: [] }
    if (opts?.choices && opts.choices.length > 0) payload.components = rowsFor(opts.choices)
    if (opts?.files && opts.files.length > 0) {
      payload.files = opts.files.map(f => {
        const src = 'path' in f.data ? f.data.path : Buffer.from(f.data)
        return new AttachmentBuilder(src as any, { name: f.name })
      })
    }
    return payload
  }

  /** Download an inbound attachment's bytes (signed/expiring CDN URL, never persisted). */
  async downloadAttachment(url: string): Promise<Uint8Array | undefined> {
    try {
      // Bounded: a hung fetch must not stall the turn indefinitely.
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

  /** Page back the most recent messages in a channel, OLDEST-first — the source the mesh
   *  reads on reconnect to recover coordination lines it missed while offline. Deliberately
   *  NOT on the MessagingAdapter interface (the host duck-types it), to keep that interface
   *  thin. Discord caps `messages.fetch` at 100/call, so we page with a `before` cursor up to
   *  `limit`; the API returns newest-first, so the accumulated batch is reversed to honor the
   *  mesh's oldest-first contract (`createdAt` rides in-band in each line, so no timestamp). */
  async fetchRecent(scope: ScopeId, limit: number): Promise<{ authorId: string; text: string }[]> {
    const ch = await this.client.channels.fetch(scope).catch(() => null)
    if (!ch || !ch.isTextBased()) return []
    const api = ch as {
      messages: { fetch: (opts: { limit: number; before?: string }) => Promise<Map<string, Message>> }
    }
    const collected: Message[] = []
    let before: string | undefined
    while (collected.length < limit) {
      const pageSize = Math.min(100, limit - collected.length)
      const page = await api.messages
        .fetch({ limit: pageSize, ...(before ? { before } : {}) })
        .catch(() => null)
      if (!page || page.size === 0) break
      const arr = [...page.values()] // newest-first within the page
      collected.push(...arr)
      before = arr[arr.length - 1]?.id // oldest id in this page → cursor for the next, older page
      if (page.size < pageSize) break // a short page means we've reached the start of history
    }
    // `collected` is newest-first overall; the mesh contract is oldest-first.
    return collected.reverse().map(m => ({ authorId: m.author.id, text: m.content }))
  }
}
