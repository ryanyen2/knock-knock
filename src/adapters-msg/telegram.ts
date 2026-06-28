/**
 * TelegramMessagingAdapter — the Telegram implementation of MessagingAdapter.
 * The only module that imports `grammy`.
 *
 * Intake is `getUpdates` long polling (`bot.start()`): a local process receives
 * events with no public inbound URL — the same "borrow the platform's event bus"
 * property Discord's gateway gives us. NOTE: group **privacy mode** is ON by
 * default in BotFather; with it on the bot only sees @mentions/commands/replies
 * in groups. Disable it in BotFather (`/setprivacy` → Disable) to see all group
 * messages. `message_reaction` updates also require the bot to be a group ADMIN.
 */

import { Bot } from 'grammy'
import type { Context } from 'grammy'
import type { ReactionType } from '@grammyjs/types'
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
  IncomingAttachment,
} from '../messaging-adapter.ts'
import {
  mapGlyphToReaction,
  CONTROL_REACTIONS,
} from '../messaging-fallback.ts'
import { toTelegramText } from './dialect.ts'

/** Telegram's per-message character cap. */
const MAX_LEN = 4096

/** Telegram's plain-bot file download ceiling (getFile is valid ≤ 20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Telegram only permits a fixed set of reaction emoji; the rest are rejected.
 *  We expose this as the `reactionWhitelist` so `mapGlyphToReaction` can pick the
 *  nearest permitted equivalent for a project glyph (or skip → status in text). */
const REACTION_WHITELIST: Glyph[] = [
  '👍', '👎', '❤️', '🔥', '🎉', '🤔', '😱', '🙏', '👏', '🤩', '👀',
]

/** A control reaction that is also in the Telegram whitelist is a no-op to map;
 *  control reactions that aren't (✅/❌/🛑/…) arrive only as their own emoji, so
 *  we normalize an incoming Telegram reaction by membership in CONTROL_REACTIONS. */
const CONTROL_SET = new Set<string>(CONTROL_REACTIONS)

/** Telegram parses `@handle` mentions from message text (no `allowedMentions` to opt out).
 *  To honor `SendOpts.suppressMentions`, insert a zero-width WORD JOINER (U+2060) after each
 *  `@`: it breaks the mention so Telegram won't ping the user AND a peer's inbound
 *  `text.includes('@handle')` check no longer matches — while the joiner is invisible, so the
 *  message still reads as `@handle`. Mirrors Discord's `allowedMentions: { parse: [] }`. Pure. */
export function defangMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_])/g, '@⁠')
}

/** ScopeId encoding for forum topics: a bare `chatId` is the group/room; a
 *  `"${chatId}:${message_thread_id}"` is a forum topic (a sub-scope). */
function splitScope(scope: ScopeId): { chatId: string; threadId?: number } {
  const i = scope.indexOf(':')
  if (i < 0) return { chatId: scope }
  const chatId = scope.slice(0, i)
  const tid = Number(scope.slice(i + 1))
  return Number.isFinite(tid) ? { chatId, threadId: tid } : { chatId }
}

export class TelegramMessagingAdapter implements MessagingAdapter {
  readonly platform = 'telegram'
  // Telegram is single-token (the BotFather bot token); no extra secrets.
  readonly requiredSecrets = [] as const

  private bot: Bot | undefined
  private _botUserId: string | undefined
  private _botLabel: string | undefined
  private _botUsername: string | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  // ─── callback_data ≤ 64 BYTES ───────────────────────────────────────────────
  // A Choice.id like `appr:allow:<hash>` can exceed Telegram's 64-byte
  // callback_data ceiling. So inline-keyboard buttons carry a SHORT token
  // (`a<counter>`) as callback_data, and this side table maps that token back to
  // the full Choice.id. On callback_query we resolve the token → real actionId.
  // (Mirrors how Discord keeps attachment handles host-side: the wire stays small,
  // the real id lives in-process.) Lives for the process lifetime; ids are tiny.
  private actionIds = new Map<string, string>()
  private actionCounter = 0

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  // Telegram is single-token; `secrets` (unused) is part of the seam contract.
  async connect(token: string, _secrets?: Record<string, string>): Promise<void> {
    const bot = new Bot(token)
    this.bot = bot

    bot.on('message', ctx => {
      const h = this.onMessageHandler
      if (!h) return
      try {
        const m = this.toIncoming(ctx)
        if (m) h(m)
      } catch {
        /* handler errors are isolated by the host's own catch */
      }
    })

    bot.on('callback_query:data', ctx => {
      // Always clear the inline-button spinner, even if we can't route it.
      void ctx.answerCallbackQuery().catch(() => {})
      const h = this.onActionHandler
      if (!h) return
      try {
        const a = this.toIncomingAction(ctx)
        if (a) h(a)
      } catch {
        /* isolated */
      }
    })

    bot.on('message_reaction', ctx => {
      const h = this.onReactionHandler
      if (!h) return
      try {
        const r = this.toIncomingReaction(ctx)
        if (r) h(r)
      } catch {
        /* isolated */
      }
    })

    // Populate bot.botInfo (id + username) before we start receiving.
    await bot.init()
    this._botUserId = String(bot.botInfo.id)
    this._botUsername = bot.botInfo.username
    this._botLabel = bot.botInfo.username ?? this._botUserId

    // Long-poll getUpdates loop. Fire-and-forget: start() only resolves on stop,
    // so awaiting it would block forever. No public server is needed — the point.
    // Subscribe to message_reaction explicitly (it's off by default in Bot API).
    void bot
      .start({ allowed_updates: ['message', 'callback_query', 'message_reaction'] })
      .catch(() => {})
  }

  async disconnect(): Promise<void> {
    await this.bot?.stop().catch(() => {})
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botLabel(): string | undefined {
    return this._botLabel
  }

  get botHandle(): string | undefined {
    return this._botUsername
  }

  capabilities(): Capabilities {
    return {
      reactions: 'whitelist',
      reactionWhitelist: REACTION_WHITELIST,
      threads: true,
      buttons: true,
      edit: true,
      pin: true,
      dm: true,
      mentions: 'native',
      maxMessageLength: MAX_LEN,
      files: { inbound: true, outbound: true, maxBytes: MAX_FILE_BYTES },
    }
  }

  // ─── inbound (handler registration) ──────────────────────────────────────────

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
    const bot = this.bot
    if (!bot) return undefined
    const { chatId, threadId } = splitScope(scope)
    const { text: body, entities } = this.bodyWithMention(text, opts)
    const base = {
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...this.replyMarkup(opts),
    }
    try {
      const sent = await bot.api.sendMessage(chatId, body, entities ? { ...base, entities } : base)
      return { id: String(sent.message_id), scope }
    } catch {
      // A mention entity Telegram won't resolve (e.g. a user it can't see) would otherwise
      // sink the whole prompt — and an approvals send that returns undefined auto-DENIES the
      // tool. Retry once without the ping so the prompt still posts; the owner sees it in-channel.
      if (!entities) return undefined
      try {
        const sent = await bot.api.sendMessage(chatId, body, base)
        return { id: String(sent.message_id), scope }
      } catch {
        return undefined
      }
    }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    const bot = this.bot
    if (!bot) return false
    const { chatId } = splitScope(ref.scope)
    try {
      await bot.api.editMessageText(chatId, Number(ref.id), this.bodyText(text, opts), {
        ...this.replyMarkup(opts),
      })
      return true
    } catch {
      // Deleted / identical content / not bot-owned → caller can re-post.
      return false
    }
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const bot = this.bot
    if (!bot) return
    const mapped = mapGlyphToReaction(glyph, this.capabilities())
    if (!mapped) return // no permitted equivalent → status conveyed in text instead
    const { chatId } = splitScope(ref.scope)
    await bot.api
      // `mapped` is one of REACTION_WHITELIST, all members of Telegram's permitted
      // set; grammy types `emoji` as that literal union, so the cast is safe.
      .setMessageReaction(chatId, Number(ref.id), [
        { type: 'emoji', emoji: mapped } as ReactionType,
      ])
      .catch(() => {})
  }

  async unreact(ref: MessageRef, _glyph: Glyph): Promise<void> {
    const bot = this.bot
    if (!bot) return
    // Telegram clears a bot's reaction by setting an empty reaction list.
    const { chatId } = splitScope(ref.scope)
    await bot.api.setMessageReaction(chatId, Number(ref.id), []).catch(() => {})
  }

  async pin(ref: MessageRef): Promise<void> {
    const bot = this.bot
    if (!bot) return
    const { chatId } = splitScope(ref.scope)
    await bot.api.pinChatMessage(chatId, Number(ref.id)).catch(() => {})
  }

  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    const bot = this.bot
    if (!bot) return undefined
    // COLD-DM DEGRADE: sendMessage to a user id fails ("chat not found" / "bot
    // can't initiate") unless the user has /started the bot. The host treats
    // undefined as "couldn't DM" and degrades to an in-scope @mention reply.
    try {
      const sent = await bot.api.sendMessage(userId, this.bodyText(text, opts), {
        ...this.replyMarkup(opts),
      })
      return { id: String(sent.message_id), scope: userId }
    } catch {
      return undefined
    }
  }

  typing(scope: ScopeId): void {
    const bot = this.bot
    if (!bot) return
    const { chatId, threadId } = splitScope(scope)
    void bot.api
      .sendChatAction(
        chatId,
        'typing',
        threadId !== undefined ? { message_thread_id: threadId } : undefined,
      )
      .catch(() => {})
  }

  /** Fetch an inbound attachment's bytes. `ref` is the Telegram file_id; the
   *  synthetic `url` we put on the IncomingAttachment isn't directly fetchable
   *  (the real path is resolved here via getFile, then the file-download URL). */
  async downloadAttachment(url: string, ref?: string): Promise<Uint8Array | undefined> {
    const bot = this.bot
    if (!bot) return undefined
    try {
      const fileId = ref ?? url
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) return undefined
      const dl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
      const res = await fetch(dl, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return undefined
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return undefined
    }
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  /** Open a forum topic as a task sub-scope. Returns the encoded
   *  `"${chatId}:${message_thread_id}"`, or undefined (host runs at room scope —
   *  e.g. the chat has no forum topics enabled, or the bot lacks the right). */
  async startThread(ref: MessageRef, name: string): Promise<ScopeId | undefined> {
    const bot = this.bot
    if (!bot) return undefined
    const { chatId } = splitScope(ref.scope)
    try {
      const topic = await bot.api.createForumTopic(chatId, name)
      return `${chatId}:${topic.message_thread_id}`
    } catch {
      return undefined
    }
  }

  /** Resolve a forum-topic scope to its parent chat (room). */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return this.parentOfSync(scope)
  }

  /** Sync, no-I/O parent lookup: derived purely from the scope encoding. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    const { chatId, threadId } = splitScope(scope)
    return threadId !== undefined ? chatId : undefined
  }

  /** Best-effort: was `messageId` authored by the bot? Telegram's getUpdates
   *  doesn't let us refetch an arbitrary historical message, so we can't confirm
   *  authorship after the fact — fail false (the host then relies on an explicit
   *  reply or @mention to treat a message as directed). */
  async authoredByBot(_scope: ScopeId, _messageId: string): Promise<boolean> {
    return false
  }

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(ctx: Context): IncomingMessage | undefined {
    const msg = ctx.message
    if (!msg) return undefined
    const chatId = String(msg.chat.id)
    const threadId = msg.is_topic_message ? msg.message_thread_id : undefined
    const scope: ScopeId = threadId !== undefined ? `${chatId}:${threadId}` : chatId

    const text = msg.text ?? msg.caption ?? ''
    const from = msg.from
    const authorId = from ? String(from.id) : 'unknown'
    const authorName = from?.username ?? from?.first_name ?? authorId

    // Native mention: text contains @botusername, OR this is a reply to a message
    // the bot itself sent (reply_to_message.from.id === botUserId).
    const uname = this._botUsername ? `@${this._botUsername}` : undefined
    const mentionsBot =
      (!!uname && text.includes(uname)) ||
      (!!msg.reply_to_message?.from && String(msg.reply_to_message.from.id) === this._botUserId)

    const replyToMessageId = msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined

    const attachments = this.attachmentsOf(msg)

    return {
      ref: { id: String(msg.message_id), scope },
      scope,
      authorId,
      authorName,
      text,
      mentionsBot,
      replyToMessageId,
      isThread: threadId !== undefined,
      scopeLabel: this.describeScope(ctx),
      attachments,
    }
  }

  /** Map a Telegram document / photo / common file onto IncomingAttachment(s).
   *  `ref` is the file_id (the real download handle); `url` is synthetic — only
   *  downloadAttachment(url, ref) resolves bytes (URLs are signed/expiring). */
  private attachmentsOf(
    msg: NonNullable<Context['message']>,
  ): IncomingAttachment[] | undefined {
    const out: IncomingAttachment[] = []
    if (msg.document) {
      const d = msg.document
      out.push({
        name: d.file_name ?? d.file_id,
        url: `tg:${d.file_id}`,
        contentType: d.mime_type,
        sizeBytes: d.file_size,
        ref: d.file_id,
      })
    }
    if (msg.photo && msg.photo.length > 0) {
      // Telegram sends several sizes; the last is the largest.
      const p = msg.photo[msg.photo.length - 1]!
      out.push({
        name: `${p.file_unique_id}.jpg`,
        url: `tg:${p.file_id}`,
        contentType: 'image/jpeg',
        sizeBytes: p.file_size,
        ref: p.file_id,
      })
    }
    return out.length > 0 ? out : undefined
  }

  private toIncomingAction(ctx: Context): IncomingAction | undefined {
    const cq = ctx.callbackQuery
    const data = cq?.data
    const msg = cq?.message
    if (!cq || !data || !msg) return undefined

    // Resolve the short callback token back to the full Choice.id (64-byte limit).
    const actionId = this.actionIds.get(data) ?? data
    const chatId = String(msg.chat.id)
    const threadId =
      'is_topic_message' in msg && msg.is_topic_message ? msg.message_thread_id : undefined
    const scope: ScopeId = threadId !== undefined ? `${chatId}:${threadId}` : chatId
    const message = 'text' in msg ? (msg.text ?? '') : ''
    const messageId = msg.message_id

    return {
      actionId,
      userId: String(cq.from.id),
      ref: { id: String(messageId), scope },
      scope,
      message,
      // A callback toast (ephemeral-ish) — clears/answers the inline spinner.
      respond: async (text, _opts) => {
        await ctx.answerCallbackQuery({ text }).catch(() => {})
      },
      // Rewrite the prompt in place, re-rendering the keyboard from `choices`.
      update: async (text, opts) => {
        const bot = this.bot
        if (!bot) return
        await bot.api
          .editMessageText(chatId, messageId, this.bodyText(text, opts), {
            ...this.replyMarkup(opts),
          })
          .catch(() => {})
      },
    }
  }

  private toIncomingReaction(ctx: Context): IncomingReaction | undefined {
    const mr = ctx.messageReaction
    if (!mr) return undefined
    // The newly-added reactions are in new_reaction (emoji type only — the
    // control reactions ✅/❌/🛑/🔁/⏪/🧷 are plain emoji).
    let emoji: string | undefined
    for (const r of mr.new_reaction) {
      if (r.type === 'emoji' && CONTROL_SET.has(r.emoji)) {
        emoji = r.emoji
        break
      }
    }
    if (!emoji) return undefined
    const userId = mr.user ? String(mr.user.id) : ''
    if (!userId) return undefined
    // LIMITATION: a message_reaction update carries no message_thread_id, so a
    // reaction on a message INSIDE a forum topic surfaces at the bare chat (room)
    // scope, not the `chatId:topicId` scope. Control reactions (✅/❌/🛑/🔁) on a
    // threaded task therefore land at room scope — they resolve for top-level
    // tasks but may not match a per-topic turn/approval lineage. Recovering the
    // topic would need a message_id→scope side table; deferred (see roadmap §D).
    const chatId = String(mr.chat.id)
    return {
      ref: { id: String(mr.message_id), scope: chatId },
      glyph: emoji as Glyph,
      userId,
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** Human-readable scope label for the console / DM-courier header. */
  private describeScope(ctx: Context): string {
    const chat = ctx.chat
    const title = chat && 'title' in chat ? chat.title : undefined
    const base = title ?? (chat?.type === 'private' ? 'DM' : String(chat?.id ?? '?'))
    const msg = ctx.message
    if (msg?.is_topic_message) return `${base} › topic ${msg.message_thread_id}`
    return base
  }

  /** Translate the Discord render dialect to clean plaintext and clamp to the cap. */
  private bodyText(text: string, opts?: SendOpts): string {
    // mentionUser is a numeric Telegram id; a tg://user link pings without a
    // username. We send WITHOUT parse_mode, so `toTelegramText` unwraps every
    // markdown marker to bare text — otherwise the render layer's `**`/`-#` would
    // show literally. The host's mention policy stays platform-agnostic.
    const unwrapped = toTelegramText(text)
    // Honor SendOpts.suppressMentions: Telegram has no `allowedMentions`, so neutralize
    // the `@handle`s in text (status surfaces echo the prompt verbatim — without this the
    // echoed mentions stay live and re-ping the named bots, the cross-machine cascade).
    const full = opts?.suppressMentions ? defangMentions(unwrapped) : unwrapped
    return full.length > MAX_LEN ? full.slice(0, MAX_LEN - 1) + '…' : full
  }

  /** Body text plus an optional `text_mention` entity that pings `opts.mentionUser`. Telegram
   *  has no `<@id>` markup and we send without parse_mode, so a `text_mention` entity is how a
   *  numeric id gets pinged without needing a @username. The label is prepended at offset 0. */
  private bodyWithMention(
    text: string,
    opts?: SendOpts,
  ): { text: string; entities?: { type: 'text_mention'; offset: number; length: number; user: { id: number; is_bot: boolean; first_name: string } }[] } {
    const body = this.bodyText(text, opts)
    const id = opts?.mentionUser ? Number(opts.mentionUser) : NaN
    if (!opts?.mentionUser || !Number.isFinite(id)) return { text: body }
    const label = 'owner'
    return {
      text: `${label} ${body}`,
      entities: [{ type: 'text_mention', offset: 0, length: label.length, user: { id, is_bot: false, first_name: label } }],
    }
  }

  /** Build an inline-keyboard reply_markup from neutral choices, registering each
   *  Choice.id under a short callback token (≤ 64-byte callback_data). */
  private replyMarkup(opts?: SendOpts): { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } {
    const choices = opts?.choices
    if (!choices || choices.length === 0) return {}
    const rows: { text: string; callback_data: string }[][] = []
    for (const c of choices) {
      const token = this.tokenFor(c.id)
      const label = c.glyph ? `${c.glyph} ${c.label}` : c.label
      rows.push([{ text: label, callback_data: token }])
    }
    return { reply_markup: { inline_keyboard: rows } }
  }

  /** Map a (possibly >64-byte) Choice.id to a short, stable callback token. */
  private tokenFor(choiceId: string): string {
    for (const [tok, id] of this.actionIds) if (id === choiceId) return tok
    const tok = `a${this.actionCounter++}`
    this.actionIds.set(tok, choiceId)
    return tok
  }
}
