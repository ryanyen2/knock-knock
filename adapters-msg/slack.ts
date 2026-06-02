/**
 * SlackMessagingAdapter — WALKING SKELETON, pending live verification.
 *
 * The Slack implementation of the MessagingAdapter seam. Dependency-free: it
 * hand-rolls the Slack Web API (HTTPS POST via the global `fetch`) and Socket
 * Mode (the global `WebSocket`) so the relay never imports `@slack/*` (or any
 * npm package). The host and its collaborators speak only `MessagingAdapter`;
 * this module is the only place that knows Slack mechanics.
 *
 * Lifecycle mirrors the Discord adapter: construct (registers handlers eagerly),
 * `connect(token)` = auth + open Socket Mode, `disconnect()` = close the socket.
 * `botUserId`/`botLabel` are filled by `auth.test` during `connect`.
 *
 * ── Required credentials ──────────────────────────────────────────────────────
 *  - Bot token  `xoxb-…`  — Web API auth. Passed to `connect(token)` (the seam's
 *                           single-token signature) and used as `Authorization:
 *                           Bearer <botToken>` on every Web API call.
 *  - App token  `xapp-…`  — App-level token with the `connections:write` scope,
 *                           required to open a Socket Mode connection. The seam's
 *                           `connect` takes ONE token, so the app token is read
 *                           from `process.env.SLACK_APP_TOKEN`.  *** SKELETON
 *                           LIMITATION: two-token model squeezed through a
 *                           one-token seam; the lead may widen the seam later. ***
 *    Required Slack scopes (live setup, not enforced here): `chat:write`,
 *    `reactions:read`/`reactions:write`, `pins:write`, `im:write`,
 *    `channels:history`/`groups:history`, `app_mentions:read`. Socket Mode +
 *    Event Subscriptions (message, app_mention, reaction_added) + Interactivity
 *    must be enabled on the Slack app.
 *
 * ── What is REAL vs STUBBED (be honest — this is a skeleton) ──────────────────
 *  REAL (best-effort, untested against a live workspace):
 *    - auth.test handshake; Socket Mode open + envelope ACK + payload dispatch.
 *    - send / edit / react / unreact / pin / dm via the documented Web API.
 *    - thread modeling as `"${channel}#${thread_ts}"`; scope splitting on every
 *      outbound; startThread / parentOf / parentOfSync / isThread.
 *    - block_actions → IncomingAction with respond()/update().
 *    - block-kit `actions` rendering of `opts.choices`.
 *  STUBBED / WALKING-SKELETON CAVEATS:
 *    - RECONNECTION: a closed socket triggers a single best-effort re-open via a
 *      fresh `apps.connections.open`; there is no backoff/jitter/retry budget,
 *      and an in-flight `disconnect()` suppresses re-open. Production needs a
 *      proper reconnect policy.
 *    - REACTION NAME MAPPING: Slack `reactions.add` wants a shortcode ("eyes"),
 *      not a unicode emoji. `mapGlyphToReaction` returns the raw glyph (caps are
 *      'any'); we then run it through a small GLYPH→shortcode table
 *      (`SLACK_SHORTCODE`). Unknown glyphs fall back to a stripped name and will
 *      likely be rejected by Slack — flagged, not solved.
 *    - TWO-TOKEN ISSUE: see above (app token via env, not the seam).
 *    - typing(): no public Web API typing indicator → no-op.
 *    - authoredByBot(): Slack gives no cheap per-message author lookup without a
 *      history scope + ts; we approximate by checking the message id against the
 *      bot's own recently-sent ts cache, else false (the host falls back to its
 *      own recent-message memo).
 *    - scopeLabel: we surface the bare channel id (optionally `#thread`); we do
 *      not resolve human channel names (would need an extra conversations.info
 *      call per message).
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
import { mapGlyphToReaction } from '../messaging-fallback.ts'

/** Slack message text cap is generous (~40k) but block text fields are smaller;
 *  we declare a conservative 3000 the way the brief specifies. */
const MAX_LEN = 3000

const SLACK_API = 'https://slack.com/api'

/**
 * GLYPH → Slack reaction shortcode. Slack's `reactions.add` takes an emoji NAME
 * (no colons), not a unicode character, so the project glyph vocabulary is
 * mapped here. WALKING-SKELETON: covers the glyphs knock-knock actually reacts
 * with; anything else falls through to a best-effort stripped name.
 */
const SLACK_SHORTCODE: Record<string, string> = {
  '👀': 'eyes', // saw / working
  '🏁': 'checkered_flag', // done
  '⚠️': 'warning', // failed / stale
  '⏹': 'stop_button', // stopped
  '🛑': 'octagonal_sign', // owner stop control
  '🔁': 'repeat', // override / retry
  '⏪': 'rewind', // rewind
  '🧷': 'pushpin', // checkpoint (no safety-pin emoji in Slack default set)
  '📥': 'inbox_tray', // session sharing
  '✅': 'white_check_mark', // approve
  '❌': 'x', // deny
  '👍': 'thumbsup',
  '👎': 'thumbsdown',
  '🎉': 'tada',
  '🔥': 'fire',
  '📌': 'pushpin',
  '🙏': 'pray',
}

/** Best-effort glyph → Slack shortcode (no colons). Returns null when there is
 *  nothing sensible to send (so `react`/`unreact` skip rather than error). */
function slackReactionName(glyph: Glyph, caps: Capabilities): string | null {
  const mapped = mapGlyphToReaction(glyph, caps)
  if (!mapped) return null
  // Slack only accepts a known emoji NAME; never send raw unicode (it 400s and
  // the failure is swallowed). An unmapped glyph → null → react() skips it.
  return SLACK_SHORTCODE[mapped] ?? null
}

/** Map a neutral Choice.style onto a Slack block-button `style`. Slack only has
 *  'primary' and 'danger'; neutral/undefined → omit (default look). */
function blockButtonStyle(style: Choice['style']): 'primary' | 'danger' | undefined {
  if (style === 'primary') return 'primary'
  if (style === 'danger') return 'danger'
  return undefined
}

/** A thread scope is encoded as `"${channel}#${thread_ts}"`; a plain channel is
 *  just `"${channel}"`. Split it back into its API parts. */
function splitScope(scope: ScopeId): { channel: string; threadTs?: string } {
  const hash = scope.indexOf('#')
  if (hash < 0) return { channel: scope }
  return { channel: scope.slice(0, hash), threadTs: scope.slice(hash + 1) }
}

export class SlackMessagingAdapter implements MessagingAdapter {
  readonly platform = 'slack'

  private _botToken: string | undefined
  private _appToken: string | undefined
  private _botUserId: string | undefined
  private _botLabel: string | undefined

  private ws: WebSocket | undefined
  /** Set during disconnect() so a socket-close handler doesn't re-open. */
  private closing = false

  /** ts values we recently posted, so authoredByBot can answer without a
   *  history scope (best-effort; bounded). */
  private readonly ourMessageIds = new Set<string>()

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  constructor() {
    // Handlers are registered eagerly via on* so they're live the instant the
    // socket connects — mirrors the Discord adapter. No client to build here:
    // the WebSocket is opened in connect() once we have the Socket Mode URL.
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    this._botToken = token
    this.closing = false

    // (1) auth.test → who are we.
    const auth = await this.web<{ user_id?: string; user?: string; bot_id?: string }>('auth.test', {})
    if (auth?.user_id) this._botUserId = auth.user_id
    this._botLabel = auth?.user ?? auth?.user_id

    // (2) Socket Mode: the app-level token is read from the env because the seam
    //     hands us only the bot token. SKELETON LIMITATION (see header).
    this._appToken = process.env.SLACK_APP_TOKEN
    if (!this._appToken) {
      // Without an app token we can authenticate + post but receive nothing.
      // Surface it loudly; outbound still works for live verification.
      console.warn(
        'knock-knock(slack): SLACK_APP_TOKEN not set — Socket Mode disabled, ' +
          'inbound events will NOT be received (outbound API still works).',
      )
      return
    }
    await this.openSocket()
  }

  /** Open (or re-open) the Socket Mode WebSocket. Best-effort; a failure here is
   *  logged and left for the next reconnect attempt. */
  private async openSocket(): Promise<void> {
    const appToken = this._appToken
    if (!appToken || this.closing) return
    const res = await this.webWith<{ url?: string }>(appToken, 'apps.connections.open', {})
    const url = res?.url
    if (!url) {
      console.warn('knock-knock(slack): apps.connections.open returned no url; inbound disabled.')
      return
    }

    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('message', ev => {
      try {
        this.handleSocketMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        /* envelope errors are isolated; one bad frame never tears down the socket */
      }
    })

    ws.addEventListener('close', () => {
      // WALKING-SKELETON reconnect: a single best-effort re-open with no backoff.
      if (this.closing) return
      if (this.ws === ws) this.ws = undefined
      void this.openSocket().catch(() => {})
    })

    ws.addEventListener('error', () => {
      /* close will follow; reconnect is handled there */
    })
  }

  /** Parse one Socket Mode frame, ACK it, and dispatch its payload. */
  private handleSocketMessage(raw: string): void {
    const env = JSON.parse(raw) as {
      type?: string
      envelope_id?: string
      payload?: SlackPayload
    }

    // `hello` and `disconnect` control frames carry no payload to dispatch.
    if (env.type === 'hello') return

    // ACK any enveloped event/interaction immediately (Slack requires it within
    // a few seconds or it redelivers).
    if (env.envelope_id && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
      } catch {
        /* a failed ack just means Slack redelivers; nothing to do here */
      }
    }

    // Server-initiated disconnect (token refresh / scaling): re-open.
    if (env.type === 'disconnect') {
      if (!this.closing) void this.openSocket().catch(() => {})
      return
    }

    if (env.payload) this.dispatch(env.payload)
  }

  /** Route a Socket Mode payload to the right normalized inbound shape. */
  private dispatch(payload: SlackPayload): void {
    // Interactive component (button tap).
    if (payload.type === 'block_actions') {
      const h = this.onActionHandler
      if (h) h(this.toIncomingAction(payload))
      return
    }

    // Events API envelope (messages, mentions, reactions).
    const event = payload.event
    if (!event) return

    if (event.type === 'message' || event.type === 'app_mention') {
      // Ignore our own messages, other bots, and edit/delete/system subtypes.
      if (event.bot_id) return
      if (this._botUserId && event.user === this._botUserId) return
      if (event.subtype) return // edits/deletes/joins etc.
      const h = this.onMessageHandler
      if (h) h(this.toIncoming(event))
      return
    }

    if (event.type === 'reaction_added') {
      if (this._botUserId && event.user === this._botUserId) return // filter our own
      const item = event.item
      if (!item?.channel || !item?.ts) return
      const h = this.onReactionHandler
      if (h) {
        h({
          ref: { id: item.ts, scope: item.channel },
          glyph: event.reaction ?? '', // Slack gives a shortcode w/o colons
          userId: event.user ?? '',
        })
      }
      return
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    this.ws = undefined
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botLabel(): string | undefined {
    return this._botLabel
  }

  capabilities(): Capabilities {
    return {
      // Slack reactions are named shortcodes, not arbitrary unicode — declare
      // the glyphs we can actually map so mapGlyphToReaction degrades correctly
      // (an unmappable glyph resolves to null and react() skips it).
      reactions: 'whitelist',
      reactionWhitelist: Object.keys(SLACK_SHORTCODE),
      threads: true,
      buttons: true,
      edit: true,
      pin: true,
      dm: true,
      mentions: 'native',
      maxMessageLength: MAX_LEN,
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

  /** Best-effort: did WE post `messageId`? Slack has no cheap author lookup
   *  without a history scope, so we consult the bounded set of ts values we
   *  ourselves posted. Returns false otherwise (the host falls back to its own
   *  recent-message memo). */
  async authoredByBot(_scope: ScopeId, messageId: string): Promise<boolean> {
    return this.ourMessageIds.has(messageId)
  }

  // ─── outbound ─────────────────────────────────────────────────────────────────

  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    const { channel, threadTs } = splitScope(scope)
    const body = this.buildPayload(channel, text, opts, threadTs)
    const res = await this.web<{ ts?: string }>('chat.postMessage', body)
    if (!res?.ts) return undefined
    this.remember(res.ts)
    return { id: res.ts, scope }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    const { channel } = splitScope(ref.scope)
    const body: Record<string, unknown> = {
      channel,
      ts: ref.id,
      text: this.trim(this.withMention(text, opts)),
    }
    // chat.update replaces blocks; pass the (possibly empty) computed blocks so
    // controls are re-rendered or cleared.
    body.blocks = this.blocksFor(text, opts)
    const res = await this.web<{ ts?: string }>('chat.update', body)
    return !!res?.ts
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const name = slackReactionName(glyph, this.capabilities())
    if (!name) return
    const { channel } = splitScope(ref.scope)
    await this.web('reactions.add', { channel, timestamp: ref.id, name })
  }

  async unreact(ref: MessageRef, glyph: Glyph): Promise<void> {
    const name = slackReactionName(glyph, this.capabilities())
    if (!name) return
    const { channel } = splitScope(ref.scope)
    await this.web('reactions.remove', { channel, timestamp: ref.id, name })
  }

  async pin(ref: MessageRef): Promise<void> {
    const { channel } = splitScope(ref.scope)
    await this.web('pins.add', { channel, timestamp: ref.id })
  }

  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    // Open (or reuse) the IM channel, then post into it.
    const opened = await this.web<{ channel?: { id?: string } }>('conversations.open', { users: userId })
    const dmChannel = opened?.channel?.id
    if (!dmChannel) return undefined
    const body = this.buildPayload(dmChannel, text, opts)
    const res = await this.web<{ ts?: string }>('chat.postMessage', body)
    if (!res?.ts) return undefined
    this.remember(res.ts)
    return { id: res.ts, scope: dmChannel }
  }

  /** Slack has no public typing indicator over the Web API — no-op. */
  typing(_scope: ScopeId): void {
    /* intentional no-op (see header comment) */
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  /** A Slack thread IS the parent message `ts` within its channel; there is no
   *  separate thread id and threads are unnamed (the name is ignored). We encode
   *  the sub-scope as `"${channel}#${thread_ts}"`. */
  async startThread(ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    const { channel } = splitScope(ref.scope)
    return `${channel}#${ref.id}`
  }

  /** Resolve a thread sub-scope to its parent room (the bare channel id), else
   *  undefined (a plain channel is its own room upstream). Synchronous-only
   *  knowledge here, so this just defers to parentOfSync. */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return this.parentOfSync(scope)
  }

  /** Synchronous, no-I/O parent lookup — the channel id before the `#`, or
   *  undefined when `scope` is already a plain channel. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    const hash = scope.indexOf('#')
    if (hash < 0) return undefined
    return scope.slice(0, hash)
  }

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(event: SlackMessageEvent): IncomingMessage {
    const channel = event.channel ?? ''
    const threadTs = event.thread_ts
    // A reply in a thread carries thread_ts !== ts; the scope is the thread.
    const isThread = !!threadTs && threadTs !== event.ts
    const scope: ScopeId = isThread ? `${channel}#${threadTs}` : channel
    const mentionsBot = event.type === 'app_mention' || this.textMentionsBot(event.text ?? '')
    return {
      ref: { id: event.ts ?? '', scope },
      scope,
      authorId: event.user ?? '',
      authorName: event.user ?? '', // Slack events carry only the user id; name needs a users.info lookup (deferred)
      text: event.text ?? '',
      mentionsBot,
      // Slack has no first-class reply id; a thread parent is the closest analog,
      // surfaced so the host can treat a threaded reply to us as directed.
      replyToMessageId: isThread ? threadTs : undefined,
      isThread,
      scopeLabel: isThread ? `#${channel} › thread` : `#${channel}`,
    }
  }

  /** Does the message text contain a native mention of the bot (`<@USERID>`)? */
  private textMentionsBot(text: string): boolean {
    if (!this._botUserId) return false
    return text.includes(`<@${this._botUserId}>`)
  }

  private toIncomingAction(payload: SlackPayload): IncomingAction {
    const action = payload.actions?.[0]
    const channel = payload.channel?.id ?? ''
    const messageTs = payload.message?.ts ?? ''
    const threadTs = payload.message?.thread_ts
    const isThread = !!threadTs && threadTs !== messageTs
    const scope: ScopeId = isThread ? `${channel}#${threadTs}` : channel
    return {
      // The chosen action_id IS the Choice.id we stamped onto the button.
      actionId: action?.action_id ?? '',
      userId: payload.user?.id ?? '',
      ref: { id: messageTs, scope },
      scope,
      message: payload.message?.text ?? '',
      respond: async (text, opts) => {
        const method = opts?.ephemeral ? 'chat.postEphemeral' : 'chat.postMessage'
        const body: Record<string, unknown> = { channel, text: this.trim(text) }
        if (opts?.ephemeral) body.user = payload.user?.id
        if (isThread) body.thread_ts = threadTs
        await this.web(method, body)
      },
      update: async (text, opts) => {
        // chat.update on the prompt's own message; empty blocks clear controls.
        await this.web('chat.update', {
          channel,
          ts: messageTs,
          text: this.trim(this.withMention(text, opts)),
          blocks: this.blocksFor(text, opts),
        })
      },
    }
  }

  // ─── payload + transport helpers ──────────────────────────────────────────────

  /** Build a chat.postMessage body for a channel scope, including thread_ts when
   *  posting into a thread and block-kit controls when `choices` are present. */
  private buildPayload(
    channel: string,
    text: string,
    opts: SendOpts | undefined,
    threadTs?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      channel,
      text: this.trim(this.withMention(text, opts)),
    }
    if (threadTs) body.thread_ts = threadTs
    const blocks = this.blocksFor(text, opts)
    if (blocks.length > 0) body.blocks = blocks
    return body
  }

  /** Prefix a `<@USERID>` mention when requested (Slack's native mention form). */
  private withMention(text: string, opts?: SendOpts): string {
    return opts?.mentionUser ? `<@${opts.mentionUser}> ${text}` : text
  }

  private trim(text: string): string {
    return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text
  }

  /** Build the block-kit blocks for a message: a `section` for the text plus an
   *  `actions` block of buttons when `choices` are present. Returns [] when there
   *  is nothing interactive (so plain `text` rendering is used / controls clear). */
  private blocksFor(text: string, opts?: SendOpts): unknown[] {
    const choices = opts?.choices
    if (!choices || choices.length === 0) return []
    const body = this.trim(this.withMention(text, opts))
    const elements = choices.map(c => {
      const el: Record<string, unknown> = {
        type: 'button',
        action_id: c.id,
        text: { type: 'plain_text', text: c.label, emoji: true },
      }
      const style = blockButtonStyle(c.style)
      if (style) el.style = style
      return el
    })
    return [
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      { type: 'actions', elements },
    ]
  }

  /** Remember a ts we posted so authoredByBot can answer (bounded to avoid an
   *  unbounded set in a long-lived relay). */
  private remember(ts: string): void {
    this.ourMessageIds.add(ts)
    if (this.ourMessageIds.size > 500) {
      const first = this.ourMessageIds.values().next().value
      if (first !== undefined) this.ourMessageIds.delete(first)
    }
  }

  /** POST a Slack Web API method with the bot token. Returns the parsed JSON when
   *  `ok` is true, else undefined (callers degrade — never throw at the seam). */
  private web<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T | undefined> {
    return this.webWith<T>(this._botToken, method, body)
  }

  /** POST a Slack Web API method with an explicit token (bot or app-level). */
  private async webWith<T = Record<string, unknown>>(
    token: string | undefined,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T | undefined> {
    if (!token) return undefined
    try {
      const res = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { ok?: boolean } & Record<string, unknown>
      if (!json?.ok) {
        if (process.env.KNOCK_KNOCK_DEBUG === '1') {
          console.warn(`knock-knock(slack): ${method} failed:`, json?.error ?? json)
        }
        return undefined
      }
      return json as unknown as T
    } catch (err) {
      if (process.env.KNOCK_KNOCK_DEBUG === '1') {
        console.warn(`knock-knock(slack): ${method} threw:`, err)
      }
      return undefined
    }
  }
}

// ─── Slack Socket Mode payload shapes (minimal, only what we read) ──────────────

type SlackMessageEvent = {
  type?: string
  subtype?: string
  channel?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  bot_id?: string
}

type SlackReactionEvent = {
  type?: string
  user?: string
  reaction?: string
  item?: { channel?: string; ts?: string }
}

type SlackEvent = SlackMessageEvent & SlackReactionEvent

type SlackAction = { action_id?: string; value?: string }

type SlackPayload = {
  type?: string
  // events API
  event?: SlackEvent
  // interactive (block_actions)
  actions?: SlackAction[]
  user?: { id?: string }
  channel?: { id?: string }
  message?: { ts?: string; text?: string; thread_ts?: string }
}
