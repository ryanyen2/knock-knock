/**
 * SlackMessagingAdapter — the Slack implementation of MessagingAdapter.
 * The only module that imports `@slack/socket-mode` and `@slack/web-api`.
 *
 * Slack is the near-twin of Discord: Socket Mode is an OUTBOUND WebSocket (like
 * Discord's gateway), so a laptop receives every event — messages, reactions,
 * Block Kit button clicks — with NO public inbound server. That is the whole
 * reason Slack is Phase 1: the seam was modeled on this shape.
 *
 * Two-token dance (vs Discord's one): the primary `token` is the `xoxb-` bot
 * token (all Web API calls); `secrets.appToken` is the `xapp-` app-level token
 * that opens the socket. The host resolves the app token from the bot's
 * `secretEnv` and passes it via `requiredSecrets` — see `connect`.
 *
 * Scope encoding (the one non-obvious bit): Slack threads are NOT separate
 * channels — a thread is `(channel, thread_ts)`. We encode a room scope as the
 * bare `channel` id, and a thread scope as `"${channel}:${thread_ts}"`. A scope
 * containing ':' is a thread; `splitScope` is the single decode seam. Other
 * adapters whose sub-conversations are (parent, key) pairs should follow this
 * `parent:key` convention so the host's scope→room algebra stays uniform.
 */

import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
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
import { mapGlyphToReaction, normalizeUnicodeReaction } from '../messaging-fallback.ts'
import { toSlackMrkdwn } from './dialect.ts'

/** Slack's soft message cap is 4000 chars; we design for a 3800 floor with headroom. */
const MAX_LEN = 3800

/**
 * Slack's `reactions.add`/`reactions.remove` want an emoji NAME (`white_check_mark`),
 * never the unicode glyph. The control vocabulary is small and fixed, so a direct
 * map is enough; an unmapped glyph is skipped (status falls back to text upstream).
 * Inverse of the names Slack delivers on `reaction_added` (see `normalizeName`).
 */
const GLYPH_TO_NAME: Record<Glyph, string> = {
  '✅': 'white_check_mark',
  '❌': 'x',
  '🛑': 'octagonal_sign',
  '🔁': 'repeat',
  '⏪': 'rewind',
  '🧷': 'safety_pin',
  '👀': 'eyes',
  '🏁': 'checkered_flag',
  '⚠️': 'warning',
  '⏹': 'stop_button',
  '📥': 'inbox_tray',
  '📌': 'pushpin',
}

/**
 * Inbound reaction names Slack delivers (`reaction_added.reaction`) back to the
 * unicode control glyphs the host acts on. Slack uses `+1`/`-1` etc.; only the
 * reserved control reactions matter — everything else normalizes away.
 */
const NAME_TO_GLYPH: Record<string, Glyph> = {
  white_check_mark: '✅',
  heavy_check_mark: '✅',
  '+1': '✅',
  x: '❌',
  '-1': '❌',
  octagonal_sign: '🛑',
  repeat: '🔁',
  rewind: '⏪',
  safety_pin: '🧷',
}

/** Loose shape of a Socket Mode event envelope (the SDK types it as `any`). */
type SlackEnvelope = { ack: (response?: unknown) => Promise<void>; body: any; event?: any }

export class SlackMessagingAdapter implements MessagingAdapter {
  readonly platform = 'slack'
  // The host resolves the xapp- app-level token from the bot's secretEnv and
  // passes it as secrets.appToken; the primary token arg is the xoxb- bot token.
  readonly requiredSecrets = ['appToken'] as const

  private web: WebClient | undefined
  private socket: SocketModeClient | undefined
  private _botUserId: string | undefined
  private _botLabel: string | undefined
  private _botToken: string | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  // Slack delivers BOTH a `message` and an `app_mention` event for the same
  // @mention, so a single prompt would otherwise fire two turns. Dedup by the
  // message ts (unique per message; the two events share it). Bounded FIFO.
  private readonly seenMessageTs = new Set<string>()

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async connect(token: string, secrets?: Record<string, string>): Promise<void> {
    this._botToken = token
    this.web = new WebClient(token)
    // Socket Mode = outbound WebSocket, NO public server (the whole point — like
    // Discord's gateway). The SDK opens the socket via apps.connections.open and
    // refreshes the rotating URL internally, so reconnect needs no glue here.
    const appToken = secrets?.appToken
    if (!appToken) {
      // Fail fast with a clear message rather than `new SocketModeClient({appToken: undefined})`.
      throw new Error(
        'slack: missing app-level token. Set the env var named in the bot\'s secretEnv.appToken ' +
          '(an xapp- token with connections:write — api.slack.com/apps → Basic Information → App-Level Tokens).',
      )
    }
    this.socket = new SocketModeClient({ appToken })

    this.registerHandlers(this.socket)
    await this.socket.start()

    // auth.test identifies us for self-filtering + the console line.
    try {
      const auth = await this.web.auth.test()
      this._botUserId = (auth.user_id as string | undefined) ?? undefined
      this._botLabel = (auth.user as string | undefined) ?? this._botUserId
    } catch {
      /* leave ids undefined; the host degrades self-filtering gracefully */
    }
  }

  async disconnect(): Promise<void> {
    await this.socket?.disconnect().catch(() => {})
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botLabel(): string | undefined {
    return this._botLabel
  }

  discoveryCapabilities(): DiscoveryCapabilities {
    // conversations.list enumerates channels; conversations.members enumerates members;
    // conversations.create makes a transport channel.
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
      // Slack's per-file ceiling is workspace-tier dependent; design for the cap.
      // Inbound files are handled (toAttachments + downloadAttachment). Outbound
      // is honest-false until the 3-step files.getUploadURLExternal flow is wired —
      // with outbound:true the host would silently drop the file AND skip the
      // outboundFileNotice fallback. Flip to true once upload lands.
      files: { inbound: true, outbound: false, maxBytes: 1024 * 1024 * 1024 },
    }
  }

  // ─── discovery enumeration (duck-typed, three-valued) ──────────────────────────
  // OFF the MessagingAdapter interface (like fetchRecent): the gap-resolver duck-types
  // these. Present only where DiscoveryCapabilities says so. A present method never
  // returns `unsupported`; a Slack rejection (missing_scope, not_in_channel, no web
  // client before connect) degrades with a reason.

  /** Enumerate the public + private channels this bot can see. */
  async listChannels(): Promise<EnumerationOutcome> {
    if (!this.web) return { kind: 'degraded', reason: 'not connected' }
    try {
      const res = await this.web.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
      })
      const items: DiscoveredEntity[] = (res.channels ?? []).map(c => ({
        id: c.id ?? '',
        label: c.name ?? c.id ?? '',
      }))
      return { kind: 'results', items }
    } catch {
      return { kind: 'degraded', reason: 'cannot list Slack channels (missing scope?)' }
    }
  }

  /** Enumerate a channel's member user ids (label = id; no per-member users.info). */
  async listMembers(channelId: string): Promise<EnumerationOutcome> {
    if (!this.web) return { kind: 'degraded', reason: 'not connected' }
    try {
      const res = await this.web.conversations.members({ channel: channelId, limit: 200 })
      const items: DiscoveredEntity[] = (res.members ?? []).map(id => ({ id, label: id }))
      return { kind: 'results', items }
    } catch {
      return { kind: 'degraded', reason: 'cannot list channel members (missing scope / not in channel)' }
    }
  }

  /** Create a transport channel. */
  async createChannel(name: string): Promise<EnumerationOutcome> {
    if (!this.web) return { kind: 'degraded', reason: 'not connected' }
    try {
      const res = await this.web.conversations.create({ name })
      const ch = res.channel as { id?: string; name?: string } | undefined
      if (!ch?.id) return { kind: 'degraded', reason: 'channel created but no id returned' }
      return { kind: 'results', items: [{ id: ch.id, label: ch.name ?? name }] }
    } catch {
      return { kind: 'degraded', reason: 'cannot create Slack channel (missing scope?)' }
    }
  }

  // ─── inbound (host registers handlers; adapter normalizes platform events) ──

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.onMessageHandler = handler
  }

  onAction(handler: (a: IncomingAction) => void): void {
    this.onActionHandler = handler
  }

  onReaction(handler: (r: IncomingReaction) => void): void {
    this.onReactionHandler = handler
  }

  /** Wire the Socket Mode event stream to the seam. Every envelope must be
   *  ack()'d promptly or Slack redelivers — so we ack first, then translate. */
  private registerHandlers(socket: SocketModeClient): void {
    // Plain channel/group/im/mpim messages.
    socket.on('message', (env: SlackEnvelope) => {
      void env.ack()
      this.handleMessageEvent(env.event, false)
    })
    // Native @mention of the app — same shape, mentionsBot forced true.
    socket.on('app_mention', (env: SlackEnvelope) => {
      void env.ack()
      this.handleMessageEvent(env.event, true)
    })
    // Emoji reactions; only the reserved control glyphs surface.
    socket.on('reaction_added', (env: SlackEnvelope) => {
      void env.ack()
      this.handleReactionEvent(env.event)
    })
    // Block Kit button clicks arrive as type:'interactive' (block_actions payload).
    socket.on('interactive', (env: SlackEnvelope) => {
      void env.ack()
      this.handleInteractive(env.body)
    })
  }

  /** Translate a `message`/`app_mention` event into an IncomingMessage. */
  private handleMessageEvent(event: any, isMention: boolean): void {
    const h = this.onMessageHandler
    if (!h || !event) return
    // Admit human messages AND attributable peer-bot posts — the latter is how a peer
    // agent's handoff ("@other refine this") and the mesh coordination lines reach this
    // bot on Slack. A peer app message carries `bot_id` + `user` (its Slack user id, which
    // equals its directory `userId`); without a `user` we can't attribute it, and the host
    // can't gate/route it, so drop. Self-filter + allowlist stay the host's job.
    if (event.bot_id && !event.user) return
    // Drop system subtypes (edits, joins, channel events) that carry no usable shape; allow
    // plain posts, thread broadcasts, file shares, and bot posts.
    if (
      event.subtype &&
      event.subtype !== 'thread_broadcast' &&
      event.subtype !== 'file_share' &&
      event.subtype !== 'bot_message'
    )
      return

    const channel: string = event.channel
    const ts: string = event.ts

    // Drop the duplicate: the `message` + `app_mention` pair carry the same ts.
    // Whichever arrives first wins; mention detection below is text-based, so the
    // surviving event still resolves the mention regardless of which one it was.
    const dedupeKey = `${channel}:${ts}`
    if (this.seenMessageTs.has(dedupeKey)) return
    this.seenMessageTs.add(dedupeKey)
    if (this.seenMessageTs.size > 1000) {
      const first = this.seenMessageTs.values().next().value
      if (first) this.seenMessageTs.delete(first)
    }

    const threadTs: string | undefined = event.thread_ts
    // A thread reply lives in (channel, thread_ts); the room is the bare channel.
    const isThread = Boolean(threadTs) && threadTs !== ts
    const scope: ScopeId = isThread ? `${channel}:${threadTs}` : channel

    const text: string = event.text ?? ''
    const mentionsBot =
      isMention || (this._botUserId ? text.includes(`<@${this._botUserId}>`) : false)

    try {
      h({
        ref: { id: ts, scope },
        scope,
        authorId: event.user ?? '',
        authorName: event.user ?? '',
        text,
        mentionsBot,
        // Slack has no per-message reply pointer outside threads; thread_ts is the
        // closest "directed" signal and is already reflected in scope/isThread.
        replyToMessageId: undefined,
        isThread,
        scopeLabel: isThread ? `#${channel} › thread` : `#${channel}`,
        attachments: this.toAttachments(event.files),
      })
    } catch {
      /* handler errors are isolated by the host's own catch */
    }
  }

  /** Slack file objects → seam attachments (untrusted, downloaded at ingest). */
  private toAttachments(files: any): IncomingMessage['attachments'] {
    if (!Array.isArray(files) || files.length === 0) return undefined
    return files.map((f: any) => ({
      name: f.name ?? f.id,
      // url_private requires the bot token as a Bearer header (see downloadAttachment).
      url: f.url_private ?? f.url_private_download ?? '',
      contentType: f.mimetype ?? undefined,
      sizeBytes: typeof f.size === 'number' ? f.size : undefined,
      ref: f.id,
    }))
  }

  private handleReactionEvent(event: any): void {
    const h = this.onReactionHandler
    if (!h || !event) return
    if (this._botUserId && event.user === this._botUserId) return
    const glyph = this.normalizeName(event.reaction)
    if (!glyph) return
    const item = event.item ?? {}
    const channel: string = item.channel
    // reaction_added has no thread_ts; the room scope is enough to resolve the
    // message, and the host re-resolves scope→room anyway.
    h({ ref: { id: item.ts, scope: channel }, glyph, userId: event.user })
  }

  /** Normalize a Slack reaction name (`white_check_mark`, `+1`) to a control
   *  glyph; falls back to the unicode normalizer for raw-emoji edge cases. */
  private normalizeName(name: string | undefined): Glyph | undefined {
    if (!name) return undefined
    const base = name.split('::')[0] ?? name // strip skin-tone modifiers
    return NAME_TO_GLYPH[base] ?? normalizeUnicodeReaction(base)
  }

  /** Translate a block_actions interaction payload into an IncomingAction. */
  private handleInteractive(body: any): void {
    const h = this.onActionHandler
    if (!h || !body || body.type !== 'block_actions') return
    const action = body.actions?.[0]
    if (!action) return

    const channel: string = body.channel?.id ?? ''
    const messageTs: string = body.message?.ts ?? ''
    const threadTs: string | undefined = body.message?.thread_ts
    const isThread = Boolean(threadTs) && threadTs !== messageTs
    const scope: ScopeId = isThread ? `${channel}:${threadTs}` : channel
    const responseUrl: string | undefined = body.response_url

    try {
      h({
        actionId: action.action_id,
        userId: body.user?.id ?? '',
        ref: { id: messageTs, scope },
        scope,
        message: body.message?.text ?? '',
        // respond → ephemeral reply via the response_url POST (no SDK needed).
        respond: async (text, opts) => {
          if (!responseUrl) return
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              response_type: opts?.ephemeral === false ? 'in_channel' : 'ephemeral',
              replace_original: false,
            }),
          }).catch(() => {})
        },
        // update → rewrite the prompt in place via chat.update (bot-owned msg).
        update: async (text, opts) => {
          if (!channel || !messageTs) return
          await this.web?.chat
            .update({ channel, ts: messageTs, ...this.buildPayload(text, opts) })
            .catch(() => {})
        },
      })
    } catch {
      /* isolated */
    }
  }

  // ─── outbound ───────────────────────────────────────────────────────────────

  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    if (!this.web) return undefined
    const { channel, threadTs } = this.splitScope(scope)
    try {
      const res = await this.web.chat.postMessage({
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...this.buildPayload(text, opts),
      })
      const ts = res.ts as string | undefined
      // Reuse the same thread scope for the ref so follow-up react/edit resolve.
      return ts ? { id: ts, scope } : undefined
    } catch {
      return undefined
    }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    if (!this.web) return false
    const { channel } = this.splitScope(ref.scope)
    try {
      // chat.update only works on bot-owned messages; failure → false so the
      // caller can re-post.
      await this.web.chat.update({ channel, ts: ref.id, ...this.buildPayload(text, opts) })
      return true
    } catch {
      return false
    }
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    if (!this.web) return
    const name = this.glyphToName(glyph)
    if (!name) return // unmappable → skip (status conveyed in text upstream)
    const { channel } = this.splitScope(ref.scope)
    await this.web.reactions.add({ channel, timestamp: ref.id, name }).catch(() => {})
  }

  async unreact(ref: MessageRef, glyph: Glyph): Promise<void> {
    if (!this.web) return
    const name = this.glyphToName(glyph)
    if (!name) return
    const { channel } = this.splitScope(ref.scope)
    await this.web.reactions.remove({ channel, timestamp: ref.id, name }).catch(() => {})
  }

  async pin(ref: MessageRef): Promise<void> {
    if (!this.web) return
    const { channel } = this.splitScope(ref.scope)
    await this.web.pins.add({ channel, timestamp: ref.id }).catch(() => {})
  }

  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    if (!this.web) return undefined
    try {
      // Open (or reuse) the DM channel, then post into it.
      const open = await this.web.conversations.open({ users: userId })
      const channel = (open.channel as { id?: string } | undefined)?.id
      if (!channel) return undefined
      const res = await this.web.chat.postMessage({ channel, ...this.buildPayload(text, opts) })
      const ts = res.ts as string | undefined
      return ts ? { id: ts, scope: channel } : undefined
    } catch {
      return undefined
    }
  }

  typing(_scope: ScopeId): void {
    // Slack Web API has no typing-indicator endpoint (only the deprecated RTM
    // had one). Best-effort no-op; presence is conveyed via the 👀 reaction.
  }

  /** Download an inbound file's bytes. Slack's `url_private` is auth-gated, NOT
   *  signed/public — it requires the bot token as a Bearer header. */
  async downloadAttachment(url: string, _ref?: string): Promise<Uint8Array | undefined> {
    if (!url) return undefined
    try {
      const res = await fetch(url, {
        headers: this._botToken ? { Authorization: `Bearer ${this._botToken}` } : {},
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return undefined
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return undefined
    }
  }

  // ─── structure (capability-gated) ────────────────────────────────────────────

  /** Slack threads have no name and aren't pre-created: "starting" a thread just
   *  means future replies carry thread_ts = the message ts. Encode that as the
   *  `channel:ts` scope; the host posts the next turn into it. */
  async startThread(ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    const { channel } = this.splitScope(ref.scope)
    if (!channel || !ref.id) return undefined
    return `${channel}:${ref.id}`
  }

  /** Resolve a thread scope to its parent room (the bare channel id). */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return this.parentOfSync(scope)
  }

  /** Pure string split — no I/O. A thread scope `channel:ts` → its channel; a
   *  bare room scope has no parent. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    const { channel, threadTs } = this.splitScope(scope)
    return threadTs ? channel : undefined
  }

  /** Was `messageId` in `scope` authored by the bot? Best-effort via
   *  conversations.history; false on any failure. */
  async authoredByBot(scope: ScopeId, messageId: string): Promise<boolean> {
    if (!this.web || !this._botUserId) return false
    const { channel } = this.splitScope(scope)
    try {
      const res = await this.web.conversations.history({
        channel,
        latest: messageId,
        oldest: messageId,
        inclusive: true,
        limit: 1,
      })
      const msg = (res.messages as Array<{ user?: string; bot_id?: string }> | undefined)?.[0]
      return msg?.user === this._botUserId
    } catch {
      return false
    }
  }

  /** Page back the most recent messages in a channel, OLDEST-first — the source the mesh
   *  reads on reconnect to recover coordination lines it missed while offline. NOT on the
   *  MessagingAdapter interface (the host duck-types it). `conversations.history` returns
   *  newest-first, so the batch is reversed for the mesh's oldest-first contract. A peer
   *  bot's mesh line carries `user` (its Slack user id == its directory `userId`); a message
   *  with only `bot_id` and no `user` can't be attributed, so it's skipped — mirroring the
   *  live path's `if (event.bot_id && !event.user) return`, else its provenance fails silently. */
  async fetchRecent(scope: ScopeId, limit: number): Promise<{ authorId: string; text: string }[]> {
    if (!this.web) return []
    // Mesh lines live at the channel root (the transport channel / room), not in threads, so a
    // thread scope still replays its channel's history.
    const { channel } = this.splitScope(scope)
    // conversations.history may return fewer than `limit` per page even when more history
    // exists, so page with next_cursor up to `limit` — else replay silently under-covers and
    // the mesh's saturation warning never fires (Discord pages the same way).
    const collected: Array<{ user?: string; text?: string }> = []
    let cursor: string | undefined
    try {
      while (collected.length < limit) {
        const res = await this.web.conversations.history({
          channel,
          limit: Math.min(200, limit - collected.length),
          ...(cursor ? { cursor } : {}),
        })
        const page = (res.messages as Array<{ user?: string; text?: string }> | undefined) ?? []
        collected.push(...page) // newest-first within and across pages
        cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined
        if (!cursor || page.length === 0) break // no more history
      }
    } catch {
      return []
    }
    const out: { authorId: string; text: string }[] = []
    for (const m of collected.reverse()) {
      // newest-first → oldest-first
      if (!m.user) continue // unattributable (bot_id only) — provenance would fail
      out.push({ authorId: m.user, text: m.text ?? '' })
    }
    return out
  }

  // ─── Slack-specific helpers ───────────────────────────────────────────────────

  /** Decode a ScopeId into its channel + optional thread_ts. The single seam
   *  that knows the `channel:thread_ts` encoding. A DM/channel id has no ':'. */
  private splitScope(scope: ScopeId): { channel: string; threadTs?: string } {
    const idx = scope.indexOf(':')
    if (idx === -1) return { channel: scope }
    return { channel: scope.slice(0, idx), threadTs: scope.slice(idx + 1) }
  }

  /** Project glyph → Slack emoji name, honoring capability degradation first
   *  (always 'any' here, so a glyph passes through), then the name table. */
  private glyphToName(glyph: Glyph): string | undefined {
    const mapped = mapGlyphToReaction(glyph, this.capabilities())
    if (!mapped) return undefined
    return GLYPH_TO_NAME[mapped]
  }

  /** Build the Web API message payload: text (mention-prefixed, length-clamped)
   *  plus an optional Block Kit actions block from Choice[]. */
  private buildPayload(
    text: string,
    opts?: SendOpts,
  ): { text: string; blocks?: unknown[] } {
    const mention = opts?.mentionUser ? `<@${opts.mentionUser}> ` : ''
    // Translate the Discord-flavored render dialect into Slack mrkdwn so **bold**,
    // -# subtext, headings, links, and bare user ids render natively (the mention
    // prefix is already valid Slack and passes through untouched).
    const full = mention + toSlackMrkdwn(text)
    const trimmed = full.length > MAX_LEN ? full.slice(0, MAX_LEN - 1) + '…' : full
    const payload: { text: string; blocks?: unknown[] } = { text: trimmed }
    if (opts?.choices && opts.choices.length > 0) {
      // A section (the text) + a single actions block of buttons. action_id =
      // Choice.id so it round-trips back as IncomingAction.actionId.
      payload.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: trimmed } },
        { type: 'actions', elements: opts.choices.map(c => this.buttonElement(c)) },
      ]
    }
    return payload
  }

  /** One Block Kit button from a neutral Choice. */
  private buttonElement(c: Choice): Record<string, unknown> {
    const el: Record<string, unknown> = {
      type: 'button',
      action_id: c.id,
      text: { type: 'plain_text', text: c.glyph ? `${c.glyph} ${c.label}` : c.label },
    }
    // Slack only has primary/danger styles; neutral renders default (no style key).
    if (c.style === 'primary') el.style = 'primary'
    else if (c.style === 'danger') el.style = 'danger'
    return el
  }
}
