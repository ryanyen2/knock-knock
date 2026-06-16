/**
 * TelegramMessagingAdapter — WALKING SKELETON, pending live verification.
 *
 * Required credentials:
 *   - Bot token from @BotFather, passed to `connect(token)`.
 *     The token is the value of the env var named in each agent's `tokenEnv`
 *     field in access.json (same pattern as the Discord adapter).
 *
 * Stubbed / known limitations:
 *   - Forum topics (message_thread_id): Telegram supergroups with topics enabled
 *     can act like Discord threads. `isThread` is always false here; `message_thread_id`
 *     could be used as a sub-scope in a future iteration.
 *   - `startThread` / `parentOf` / `parentOfSync`: return undefined (no topic
 *     support in skeleton). The host runs each task at the chat scope.
 *   - `mentionUser` in `send`/`dm`: prefix is rendered as plain text
 *     `@username` when we know the username, or a tg://user Markdown link.
 *     The adapter does NOT track username→id mappings, so in practice the
 *     mention prefix is omitted (comment below at buildPayload).
 *   - Reactions: Telegram Bot API `setMessageReaction` is only available in
 *     supergroups and channels; it silently fails in private chats. The adapter
 *     attempts it regardless and swallows errors.
 *   - `unreact`: clears ALL reactions via empty array (Telegram has no per-emoji
 *     removal for bots); `glyph` param is ignored.
 *   - `authoredByBot`: resolved via a tiny in-process cache of message ids we
 *     sent; falls back to false on cache miss (no Bot API call exists for this).
 *   - Long-poll loop: a single async loop, no exponential back-off. A network
 *     error logs and immediately retries the next getUpdates (the 30 s server
 *     timeout provides natural pacing). Production use should add back-off.
 *   - `message_reaction` updates: only `new_reaction[0]` is surfaced; multi-
 *     emoji reactions yield one IncomingReaction per update dispatch, first only.
 */

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
import { mapGlyphToReaction, normalizeUnicodeReaction } from '../messaging-fallback.ts'

// ─── Telegram Bot API types (minimal, hand-rolled) ────────────────────────────

interface TgUser {
  id: number
  is_bot?: boolean
  first_name: string
  username?: string
}

interface TgChat {
  id: number
  type: string
}

interface TgMessageEntity {
  type: string
  user?: TgUser
  offset: number
  length: number
}

interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
  entities?: TgMessageEntity[]
  reply_to_message?: TgMessage
  /** Present in forum-topic supergroups; not used in this skeleton. */
  message_thread_id?: number
}

interface TgCallbackQuery {
  id: string
  from: TgUser
  data?: string
  message?: TgMessage
}

interface TgMessageReactionUpdated {
  chat: TgChat
  message_id: number
  user?: TgUser
  new_reaction: Array<{ type: string; emoji?: string }>
  old_reaction: Array<{ type: string; emoji?: string }>
}

interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
  message_reaction?: TgMessageReactionUpdated
}

interface TgResponse<T> {
  ok: boolean
  result?: T
}

// ─── Telegram reaction whitelist ───────────────────────────────────────────────

/**
 * The set of emoji Telegram bots are allowed to set as reactions.
 * Source: https://core.telegram.org/bots/api#reactiontypeemoji
 * (as of Bot API 7.x)
 */
const TELEGRAM_REACTION_WHITELIST: Glyph[] = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🎉', '🤩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '💯',
  '🤣', '⚡', '🏆', '💔', '🤨', '😐', '🤓', '👻', '👀', '🎃',
  '🙈', '😇', '😈', '😴', '😭', '🤝', '✍', '🤗', '🫡', '🎅',
  '🐳', '❤‍🔥', '💋', '🆒', '💘', '🙉', '🦄', '😘', '🌚', '🌭',
  '💅', '🤪', '🗿', '💊', '🙊', '😎', '👾',
]

// ─── Row builder for inline keyboard ──────────────────────────────────────────

/** Telegram inline keyboard row: up to 3 buttons per row for readability. */
function buildInlineKeyboard(choices: Choice[]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
  for (let i = 0; i < choices.length; i += 3) {
    const slice = choices.slice(i, i + 3)
    keyboard.push(
      slice.map(c => ({
        text: c.glyph ? `${c.glyph} ${c.label}` : c.label,
        // callback_data max is 64 bytes; Choice.id values in this project are
        // short strings like 'appr:allow:<hash-prefix>' — safe.
        callback_data: c.id,
      })),
    )
  }
  return { inline_keyboard: keyboard }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class TelegramMessagingAdapter implements MessagingAdapter {
  readonly platform = 'telegram'

  private _botUserId: string | undefined
  private _botLabel: string | undefined
  private _botUsername: string | undefined

  private token: string = ''
  private polling: boolean = false
  private pollOffset: number = 0

  /** Small cache of our own outbound message ids → true, for `authoredByBot`. */
  private readonly sentMessageIds = new Set<string>()
  /** Bounded to avoid unbounded growth: evict oldest when over limit. */
  private readonly sentMessageIdsQueue: string[] = []
  private static readonly SENT_CACHE_MAX = 2000

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    this.token = token

    // Resolve own identity
    const me = await this.call<TgUser>('getMe', {})
    this._botUserId = String(me.id)
    this._botUsername = me.username
    this._botLabel = me.username ? `@${me.username}` : me.first_name

    // Start long-poll loop (not awaited — runs in background)
    this.polling = true
    void this.pollLoop()
  }

  async disconnect(): Promise<void> {
    this.polling = false
    // No explicit teardown needed: the next getUpdates times out and the loop
    // checks `this.polling` before the next iteration.
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botLabel(): string | undefined {
    return this._botLabel
  }

  capabilities(): Capabilities {
    return {
      reactions: 'whitelist',
      reactionWhitelist: TELEGRAM_REACTION_WHITELIST,
      threads: false,    // forum-topic support deferred (message_thread_id)
      buttons: true,
      edit: true,
      pin: true,
      dm: true,
      mentions: 'native',
      maxMessageLength: 4096,
      experimental: true,
    }
  }

  // ─── inbound handler registration ────────────────────────────────────────────

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
    const payload = this.buildPayload(scope, text, opts)
    try {
      const result = await this.call<TgMessage>('sendMessage', payload)
      const ref: MessageRef = { id: String(result.message_id), scope }
      this.trackSent(ref.id)
      return ref
    } catch {
      return undefined
    }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        chat_id: ref.scope,
        message_id: Number(ref.id),
        text: this.trimText(text),
      }
      const resp = await this.callRaw('editMessageText', body)
      if (!resp.ok) return false

      // Update inline keyboard separately (clear when no choices)
      const choices = opts?.choices ?? []
      await this.callRaw('editMessageReplyMarkup', {
        chat_id: ref.scope,
        message_id: Number(ref.id),
        reply_markup: choices.length > 0 ? buildInlineKeyboard(choices) : {},
      })
      return true
    } catch {
      return false
    }
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const mapped = mapGlyphToReaction(glyph, this.capabilities())
    if (!mapped) return  // glyph has no acceptable equivalent → skip
    await this.callRaw('setMessageReaction', {
      chat_id: ref.scope,
      message_id: Number(ref.id),
      reaction: [{ type: 'emoji', emoji: mapped }],
    }).catch(() => {})
  }

  async unreact(ref: MessageRef, _glyph: Glyph): Promise<void> {
    // Telegram Bot API: set an empty reaction array to clear all reactions.
    // Per-emoji removal is not available for bots; _glyph is intentionally unused.
    await this.callRaw('setMessageReaction', {
      chat_id: ref.scope,
      message_id: Number(ref.id),
      reaction: [],
    }).catch(() => {})
  }

  async pin(ref: MessageRef): Promise<void> {
    await this.callRaw('pinChatMessage', {
      chat_id: ref.scope,
      message_id: Number(ref.id),
    }).catch(() => {})
  }

  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    // In Telegram, a user's DM chat_id IS their numeric user id.
    return this.send(userId, text, opts)
  }

  typing(scope: ScopeId): void {
    void this.callRaw('sendChatAction', {
      chat_id: scope,
      action: 'typing',
    }).catch(() => {})
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  async startThread(_ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    // No native thread support in this skeleton.
    // TODO: Telegram forum topics (supergroups with is_forum=true) could be
    // created via createForumTopic and the resulting message_thread_id used as
    // the sub-scope. Deferred until real forum-topic adoption is validated.
    return undefined
  }

  async parentOf(_scope: ScopeId): Promise<ScopeId | undefined> {
    // No topic→channel resolution in this skeleton (threads: false).
    return undefined
  }

  parentOfSync(_scope: ScopeId): ScopeId | undefined {
    // No local cache for topic→channel in this skeleton.
    return undefined
  }

  async authoredByBot(_scope: ScopeId, messageId: string): Promise<boolean> {
    // Best-effort: check our in-process cache of sent message ids.
    // There is no Telegram Bot API call to check a message's author by id alone.
    // A cache miss returns false; the host's reply-as-mention rule degrades
    // gracefully (the reply isn't treated as a mention, but the message still
    // routes normally if the room is mention-optional).
    return this.sentMessageIds.has(messageId)
  }

  // ─── long-poll loop ───────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.call<TgUpdate[]>('getUpdates', {
          offset: this.pollOffset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
        })
        for (const update of updates) {
          if (!this.polling) break
          this.pollOffset = update.update_id + 1
          this.dispatchUpdate(update)
        }
      } catch (err) {
        // A fast-failing error (bad token, revoked bot) would otherwise busy-loop
        // SILENTLY forever. Surface it and back off so it's diagnosable and doesn't
        // spin the CPU (a healthy long-poll blocks ~30s, so this only fires on error).
        console.warn(
          `knock-knock(telegram): getUpdates failed — ${err instanceof Error ? err.message : String(err)}`,
        )
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  private dispatchUpdate(update: TgUpdate): void {
    if (update.message && update.message.text !== undefined) {
      const h = this.onMessageHandler
      if (h) {
        try {
          h(this.toIncoming(update.message))
        } catch {
          /* handler errors isolated */
        }
      }
    } else if (update.callback_query) {
      const h = this.onActionHandler
      if (h) {
        try {
          void this.handleCallbackQuery(update.callback_query, h)
        } catch {
          /* handler errors isolated */
        }
      }
    } else if (update.message_reaction) {
      const h = this.onReactionHandler
      if (h) {
        try {
          this.handleMessageReaction(update.message_reaction, h)
        } catch {
          /* handler errors isolated */
        }
      }
    }
  }

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(msg: TgMessage): IncomingMessage {
    const scope = String(msg.chat.id)
    const botUsername = this._botUsername
    const botUserId = this._botUserId ? Number(this._botUserId) : undefined
    const text = msg.text ?? ''

    // mentionsBot: text contains @botUsername, OR an entity addresses us, OR
    // the message is a reply to one of our messages.
    let mentionsBot = false
    if (botUsername && text.includes(`@${botUsername}`)) {
      mentionsBot = true
    }
    if (!mentionsBot && msg.entities) {
      for (const entity of msg.entities) {
        if (
          (entity.type === 'mention' && botUsername) ||
          (entity.type === 'text_mention' && entity.user && botUserId !== undefined && entity.user.id === botUserId)
        ) {
          // For plain 'mention' entities the text slice IS `@username`; we
          // already checked the text above. text_mention targets a user without
          // a username — match on id.
          if (entity.type === 'text_mention' && entity.user?.id === botUserId) {
            mentionsBot = true
          }
        }
      }
    }
    if (!mentionsBot && msg.reply_to_message?.from?.id !== undefined && botUserId !== undefined) {
      if (msg.reply_to_message.from.id === botUserId) {
        mentionsBot = true
      }
    }

    return {
      ref: { id: String(msg.message_id), scope },
      scope,
      authorId: String(msg.from?.id ?? 0),
      authorName: msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? 0),
      text,
      mentionsBot,
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      // isThread: always false in this skeleton.
      // Telegram forum topics use message_thread_id for sub-scopes; deferred.
      isThread: false,
      scopeLabel: msg.chat.type === 'private' ? 'DM' : `chat:${msg.chat.id}`,
    }
  }

  private async handleCallbackQuery(
    cq: TgCallbackQuery,
    handler: (a: IncomingAction) => void,
  ): Promise<void> {
    // Acknowledge immediately to stop the spinner in the client.
    await this.callRaw('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})

    if (!cq.data || !cq.message) return

    const chatId = String(cq.message.chat.id)
    const messageId = String(cq.message.message_id)
    const scope = chatId

    const action: IncomingAction = {
      actionId: cq.data,
      userId: String(cq.from.id),
      ref: { id: messageId, scope },
      scope,
      message: cq.message.text ?? '',
      respond: async (text, _opts) => {
        // Telegram has no ephemeral replies; send a plain message to the chat.
        await this.callRaw('sendMessage', {
          chat_id: chatId,
          text: this.trimText(text),
        }).catch(() => {})
      },
      update: async (text, opts) => {
        const body: Record<string, unknown> = {
          chat_id: chatId,
          message_id: Number(messageId),
          text: this.trimText(text),
        }
        await this.callRaw('editMessageText', body).catch(() => {})
        const choices = opts?.choices ?? []
        await this.callRaw('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: Number(messageId),
          reply_markup: choices.length > 0 ? buildInlineKeyboard(choices) : {},
        }).catch(() => {})
      },
    }

    handler(action)
  }

  private handleMessageReaction(
    mr: TgMessageReactionUpdated,
    handler: (r: IncomingReaction) => void,
  ): void {
    // Only surface reactions added by a real user (not the bot itself).
    if (!mr.user) return  // anonymous reactions have no user
    if (this._botUserId && String(mr.user.id) === this._botUserId) return

    const emoji = mr.new_reaction[0]?.emoji
    if (!emoji) return  // reaction removed, or non-emoji type (custom_emoji)

    // Normalize the unicode reaction to the project control vocabulary; ignore
    // anything that isn't a control glyph the host acts on.
    const glyph = normalizeUnicodeReaction(emoji)
    if (!glyph) return

    handler({
      ref: { id: String(mr.message_id), scope: String(mr.chat.id) },
      glyph,
      userId: String(mr.user.id),
    })
  }

  // ─── outbound helpers ────────────────────────────────────────────────────────

  private buildPayload(
    chatId: ScopeId,
    text: string,
    opts?: SendOpts,
  ): Record<string, unknown> {
    // mentionUser: Telegram doesn't have a universal "@user" mention by id for
    // bots that haven't seen the user's username. We omit the mention prefix
    // rather than emit a broken link. If the username were known (from a prior
    // message) we'd prefix `@username ` as plain text.
    // TODO: maintain a userId→username map from inbound messages.
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: this.trimText(text),
    }
    if (opts?.choices && opts.choices.length > 0) {
      body.reply_markup = buildInlineKeyboard(opts.choices)
    }
    return body
  }

  private trimText(text: string): string {
    const max = 4096
    return text.length > max ? text.slice(0, max - 1) + '…' : text
  }

  // ─── Bot API low-level calls ──────────────────────────────────────────────────

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const resp = await this.callRaw(method, body)
    if (!resp.ok || resp.result === undefined) {
      throw new Error(`Telegram API error on ${method}: ok=${resp.ok}`)
    }
    return resp.result as T
  }

  private async callRaw(method: string, body: Record<string, unknown>): Promise<TgResponse<unknown>> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as TgResponse<unknown>
  }

  // ─── sent-message cache ───────────────────────────────────────────────────────

  private trackSent(id: string): void {
    if (this.sentMessageIds.has(id)) return
    this.sentMessageIds.add(id)
    this.sentMessageIdsQueue.push(id)
    if (this.sentMessageIdsQueue.length > TelegramMessagingAdapter.SENT_CACHE_MAX) {
      const evicted = this.sentMessageIdsQueue.shift()
      if (evicted) this.sentMessageIds.delete(evicted)
    }
  }
}
