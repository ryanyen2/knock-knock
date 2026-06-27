/**
 * MessagingAdapter seam — the contract the relay/host uses to talk to a messaging platform (Discord is live). No platform SDK here.
 * The ledger/syncs/concepts/render layer never branch on platform NAME — they branch on `Capabilities`; every gap is covered by the pure fallback layer.
 */

/** A scope is a thread/channel/chat — the conversation a message lives in. Same string space as the ledger's `ChannelId`; bare string so this seam has no ledger import. */
export type ScopeId = string

/** A single unicode glyph from the project vocabulary (`GLYPHS`); mapped per-platform when used as a reaction. */
export type Glyph = string

/** A handle to a posted message: platform id + the scope it lives in (so fetch-then-act can resolve both). */
export type MessageRef = { id: string; scope: ScopeId }

/** One selectable option on an interactive prompt; rendered as buttons / reactions / numbered menu per `Capabilities`. The response returns as an `IncomingAction` with `actionId === id`. */
export type Choice = {
  /** Stable id echoed back in IncomingAction.actionId (e.g. `appr:allow:<hash>`). */
  id: string
  label: string
  glyph?: Glyph
  style?: 'primary' | 'danger' | 'neutral'
}

/** A file to send out. `data` is the bytes or a `{path}` the adapter reads. Adapters that can't attach degrade via `outboundFileNotice`. */
export type OutgoingFile = {
  name: string
  data: Uint8Array | { path: string }
  contentType?: string
}

export type SendOpts = {
  /** Interactive options; rendering + fallback is the adapter's job. */
  choices?: Choice[]
  /** Ping/address this user id at the head of the message, where supported. */
  mentionUser?: string
  /** Prefer a private/ephemeral delivery if the platform has one. */
  ephemeral?: boolean
  /** Suppress all pings from this message where supported. Bot-authored status surfaces
   *  (Workbench, billboard) echo the prompt verbatim, which contains live `<@id>` markup;
   *  without suppression the platform re-parses those as real mentions and re-triggers the
   *  named bots (the cross-machine status cascade). Real replies leave this off so a
   *  directed handoff (`@next-bot do X`) still pings. */
  suppressMentions?: boolean
  /** Files to attach. Honored only where `Capabilities.files.outbound`; otherwise the host posts a text notice. */
  files?: OutgoingFile[]
}

/** What a platform can do. The host and render layer branch on THIS, never on a platform name. */
export type Capabilities = {
  /** 'any' = arbitrary emoji; 'whitelist' = fixed set (Telegram); 'none' = no reactions → status degrades to text. */
  reactions: 'none' | 'whitelist' | 'any'
  /** The permitted reactions when `reactions === 'whitelist'`. */
  reactionWhitelist?: Glyph[]
  /** Native sub-conversations (threads/topics). When false, task scope collapses to the room/chat. */
  threads: boolean
  /** Inline interactive components (buttons / keyboards). */
  buttons: boolean
  /** Can a posted message be edited in place. */
  edit: boolean
  /** Can a message be pinned. */
  pin: boolean
  /** Private message to a user. */
  dm: boolean
  /** How "addressed to me" is expressed: native mention, reply-to, or plain text. Drives `directed`. */
  mentions: 'native' | 'reply' | 'text'
  /** Outbound chunking boundary (Discord 2000, Telegram 4096, …). */
  maxMessageLength: number
  /** File attachments. `inbound`/`outbound` capability + per-file `maxBytes`. `!inbound` skips ingest; `!outbound` degrades shares to a text notice. */
  files?: { inbound: boolean; outbound: boolean; maxBytes: number }
}

/** A file on an inbound message. All fields uploader-controlled and untrusted. `url` fetches bytes (may be signed/expiring/auth'd); `ref` is an opaque handle when the URL isn't enough. */
export type IncomingAttachment = {
  name: string
  url: string
  contentType?: string
  sizeBytes?: number
  ref?: string
}

/** A normalized inbound message. The adapter surfaces platform mechanics (native mention, reply target, thread structure); the host owns mention policy and routing — so policy stays platform-agnostic in one place. */
export type IncomingMessage = {
  ref: MessageRef
  scope: ScopeId
  authorId: string
  authorName: string
  text: string
  /** Did this message natively address us (@mention / app_mention / @botname)? False on platforms without mentions. */
  mentionsBot: boolean
  /** Platform id of the replied-to message, if any (host treats a reply to one of our messages as "directed"). */
  replyToMessageId?: string
  /** Platform-native author-trust signal, when the platform exposes one (e.g. GitHub's
   *  `author_association`: OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/NONE). The host uses it
   *  as an open-surface allowlist floor (see `githubAssociationTrusted`); absent on
   *  platforms without the concept. */
  authorAssociation?: string
  /** Is `scope` a sub-conversation (thread/topic) rather than the room itself? */
  isThread: boolean
  /** Attached files when delivered + `Capabilities.files.inbound`. Uploader-controlled/untrusted: download at ingest, sniff bytes, sanitize name. */
  attachments?: IncomingAttachment[]
  /** Human-readable scope label (e.g. `#general › task-thread`) for console + DM-courier header; opaque to the host. */
  scopeLabel?: string
}

/** A user tapped a button / chose an option (or typed the parsed text fallback). `respond`/`update` answer without a platform SDK. */
export type IncomingAction = {
  /** The chosen Choice.id (e.g. `appr:deny:<hash>`, `cflt:take:1`, `sess:pick:2`). */
  actionId: string
  userId: string
  /** The message the prompt was attached to. */
  ref: MessageRef
  scope: ScopeId
  /** Current prompt text, so a resolver can append a verdict line when calling `update`. */
  message: string
  /** Reply to the actor (ephemeral where supported). */
  respond(text: string, opts?: { ephemeral?: boolean }): Promise<void>
  /** Rewrite the prompt to reflect the decision and drop its controls (pass `choices` to re-render them). */
  update(text: string, opts?: SendOpts): Promise<void>
}

/** A user added an emoji reaction to a message. */
export type IncomingReaction = {
  ref: MessageRef
  glyph: Glyph
  userId: string
}

/** Host→adapter runtime configuration, applied once before `connect`. Optional and
 *  additive: an adapter that doesn't implement `configure` is unaffected. */
export type AdapterConfig = {
  /** The room ids (channel keys' platform-native part) this bot serves — lets a
   *  poll-based adapter scope its sweep to project boundaries instead of the whole
   *  workspace/account (Notion especially). Empty/absent ⇒ adapter's own default. */
  trackedRooms?: string[]
  /** 'poll' (default) or 'webhook' (event-driven; the relay opens a local HTTP
   *  receiver and routes pushes to `ingestWebhook`). Poll adapters suppress their
   *  sweep when 'webhook'. */
  intake?: 'poll' | 'webhook'
}

/** A raw inbound HTTP webhook delivered by the relay's WebhookReceiver to an adapter
 *  running in `intake: 'webhook'` mode. `body` is the exact request body string (so
 *  signature verification can hash it byte-for-byte). */
export type WebhookRequest = { headers: Record<string, string>; body: string }

/** The HTTP response the adapter wants the receiver to return (e.g. 200 for a parsed
 *  event, the echoed challenge for a platform verification handshake, 401 on a bad
 *  signature). `log`, when set, is printed to the relay console by the receiver — used
 *  to surface a one-time verification token the operator must copy. */
export type WebhookResponse = { status: number; body?: string; log?: string }

/** The contract. Implementations live in `adapters-msg/`, selected by `makeMessagingAdapter`. Lifecycle: construct, register handlers, `connect(token)`. */
export interface MessagingAdapter {
  /** Stable platform key, stamped onto inbound `channel.message` intents. */
  readonly platform: string

  /** Logical names of ADDITIONAL secrets this adapter needs beyond the primary
   *  token (e.g. Slack's app-level token, a GitHub App private key). The host
   *  resolves each from the bot's `secretEnv[<name>]` env var and passes the bundle
   *  to `connect`. Empty/absent ⇒ single-token platforms (Discord, Telegram). */
  readonly requiredSecrets?: readonly string[]

  // ─── lifecycle ────────────────────────────────────────────────────────────
  /** `token` is the primary platform token (from the bot's `tokenEnv`). `secrets`
   *  carries any `requiredSecrets`, keyed by logical name (resolved by the host
   *  from `secretEnv`). Single-token adapters ignore `secrets`. */
  connect(token: string, secrets?: Record<string, string>): Promise<void>
  disconnect(): Promise<void>
  /** Our own user id on this platform once connected (self-message filtering). */
  readonly botUserId: string | undefined
  /** Human-readable bot account label for the console line; falls back to botUserId. */
  readonly botLabel?: string | undefined
  /** Platform mention handle, where the platform addresses bots by handle rather than
   *  `<@id>` markup (Telegram `@username`). Published in the directory so directed routing
   *  can match the handle in message text. Absent ⇒ mentions carry the user id. */
  readonly botHandle?: string | undefined
  /** Platform role ids this bot holds, if the platform has roles (Discord). Published in
   *  the agent directory so a ROLE mention (`<@&roleId>`) can be routed to this bot —
   *  `@cc` resolves to the bot's managed role, not its user. Absent ⇒ no role concept. */
  readonly botRoleIds?: string[] | undefined
  capabilities(): Capabilities

  // ─── inbound (host registers handlers; adapter normalizes platform events) ──
  onMessage(handler: (m: IncomingMessage) => void): void
  onAction(handler: (a: IncomingAction) => void): void
  onReaction(handler: (r: IncomingReaction) => void): void
  /** Was `messageId` in `scope` authored by the bot? Lets the host treat a reply to one of our messages as "directed". Best-effort: false when unresolved. */
  authoredByBot(scope: ScopeId, messageId: string): Promise<boolean>

  // ─── outbound ───────────────────────────────────────────────────────────────
  /** Post to a scope; returns a ref for later react/edit/pin, or undefined on failure. */
  send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  /** Edit a posted message in place. Returns false when not applied (deleted / unsupported) so the caller can re-post. */
  edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean>
  react(ref: MessageRef, glyph: Glyph): Promise<void>
  unreact(ref: MessageRef, glyph: Glyph): Promise<void>
  /** Pin a message (capability `pin`). */
  pin(ref: MessageRef): Promise<void>
  /** Private message to a user; returns the ref in the DM scope. */
  dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  /** Best-effort typing indicator; fire-and-forget. */
  typing(scope: ScopeId): void
  /** Fetch an inbound attachment's bytes (capability `files.inbound`); called at receive time since URLs are signed/expiring/auth'd. Undefined on failure / no file support. */
  downloadAttachment?(url: string, ref?: string): Promise<Uint8Array | undefined>

  // ─── structure (capability-gated) ────────────────────────────────────────────
  /** Spawn a task sub-scope from a message (capability `threads`); undefined when unsupported (host runs at room scope). */
  startThread(ref: MessageRef, name: string): Promise<ScopeId | undefined>
  /** Resolve a sub-scope to its parent room, else undefined. The single scope→room seam, per-platform. */
  parentOf(scope: ScopeId): Promise<ScopeId | undefined>
  /** Sync, no-I/O variant of `parentOf` — parent room only if already cached, else undefined (host then falls back to its scope→room memo). */
  parentOfSync(scope: ScopeId): ScopeId | undefined

  // ─── optional runtime configuration & event-driven intake ────────────────────
  /** Apply host runtime config (tracked rooms, intake mode) once before `connect`.
   *  Optional — adapters that don't need it omit it. */
  configure?(opts: AdapterConfig): void
  /** Parse a pushed webhook in `intake: 'webhook'` mode: emit `IncomingMessage`s via
   *  the registered `onMessage` handler and return the HTTP response (200, an echoed
   *  verification challenge, or 401). Optional — only event-capable adapters implement it. */
  ingestWebhook?(req: WebhookRequest): Promise<WebhookResponse>
}
