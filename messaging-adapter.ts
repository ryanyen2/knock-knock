/**
 * MessagingAdapter seam — the interface the relay/host uses to talk to a
 * messaging platform. Discord is the live surface. The sibling of
 * `agent-adapter.ts`: that one abstracts the *agent runtime*, this one abstracts
 * the *chat surface*. No platform SDK is imported here; this module is the
 * contract only. Adding a platform means writing one new adapter against this
 * interface (in `adapters-msg/`), nothing else.
 *
 * The ledger, the synchronizations, the concepts, and the pure render layer
 * never import a platform SDK and never branch on platform NAME — they branch on
 * `Capabilities`. Every gap a platform has (no reactions, no threads, no
 * buttons) is declared here and covered by the pure fallback layer in `lib.ts`.
 */

/** A scope is a thread, a channel, or a chat — the conversation a message lives
 *  in. Same string space as the ledger's `ChannelId` (an Interaction's
 *  `channel` field). Kept as a bare string so this seam has no ledger import. */
export type ScopeId = string

/** A single unicode glyph from the project vocabulary (`GLYPHS` in
 *  ledger/render/surface.ts). Universal as message text; mapped per-platform
 *  when used as a reaction (`mapGlyphToReaction`). */
export type Glyph = string

/** A handle to a posted message: its platform id plus the scope it lives in, so
 *  an adapter that must fetch-then-act (react/edit/pin) can resolve both. A DM's
 *  scope is the private-chat id, which may differ from where work happens. */
export type MessageRef = { id: string; scope: ScopeId }

/** One selectable option on an interactive prompt (approval, conflict, session
 *  pick). The adapter renders these as native buttons, tap-a-reaction options,
 *  or a numbered text menu depending on `Capabilities`; either way the user's
 *  response comes back as an `IncomingAction` carrying `actionId === id`. */
export type Choice = {
  /** Stable id echoed back in IncomingAction.actionId (e.g. `appr:allow:<hash>`). */
  id: string
  label: string
  glyph?: Glyph
  style?: 'primary' | 'danger' | 'neutral'
}

/** A file the agent/relay wants to send out. `data` is the bytes (the host reads
 *  workspace files itself) or a `{path}` the adapter reads. Adapters that can't
 *  attach files degrade via `outboundFileNotice` (messaging-fallback). */
export type OutgoingFile = {
  name: string
  data: Uint8Array | { path: string }
  contentType?: string
}

export type SendOpts = {
  /** Interactive options. Rendering + fallback is the adapter's job (§3 of the doc). */
  choices?: Choice[]
  /** Ping/address this user id at the head of the message, where supported. */
  mentionUser?: string
  /** Prefer a private/ephemeral delivery if the platform has one. */
  ephemeral?: boolean
  /** Files to attach. Honored only where `Capabilities.files.outbound` is true;
   *  otherwise the host posts a text notice instead (see messaging-fallback). */
  files?: OutgoingFile[]
}

/** What a platform can do. The host and the pure render layer branch on THIS,
 *  never on a platform name, so a new platform needs no edits outside its
 *  adapter. */
export type Capabilities = {
  /** 'any' = arbitrary emoji; 'whitelist' = a fixed set (Telegram); 'none' = no
   *  reactions at all (iMessage) → status/controls degrade to text. */
  reactions: 'none' | 'whitelist' | 'any'
  /** The permitted reactions when `reactions === 'whitelist'`. */
  reactionWhitelist?: Glyph[]
  /** Native sub-conversations (Discord/Slack threads, Telegram topics). When
   *  false, task scope collapses to the room/chat. */
  threads: boolean
  /** Inline interactive components (buttons / keyboards). */
  buttons: boolean
  /** Can an already-posted message be edited in place (Workbench, card updates). */
  edit: boolean
  /** Can a message be pinned (Workbench). */
  pin: boolean
  /** Private message to a user (approval prompts, override notices). */
  dm: boolean
  /** How "addressed to me" is expressed: a real mention, a reply-to, or just
   *  text directed at the bot (or implicit in a 1:1). Drives `directed`. */
  mentions: 'native' | 'reply' | 'text'
  /** Outbound chunking boundary (Discord 2000, Telegram 4096, …). */
  maxMessageLength: number
  /** File attachments. `inbound` = the platform delivers attachment metadata on
   *  messages; `outbound` = it accepts files on send; `maxBytes` = the per-file
   *  ceiling (Discord's 10 MiB floor). Absent or `!inbound` → the ingest path is
   *  skipped; `!outbound` → outbound shares degrade to a text notice. The host
   *  and syncs branch on this, never on a platform name. */
  files?: { inbound: boolean; outbound: boolean; maxBytes: number }
}

/** A file attached to an inbound message. All fields are uploader-controlled and
 *  untrusted. `url` is how the adapter fetches the bytes (may be signed/expiring
 *  or require auth); `ref` is an opaque platform handle when the URL alone isn't
 *  enough to fetch (e.g. a Slack file id). */
export type IncomingAttachment = {
  name: string
  url: string
  contentType?: string
  sizeBytes?: number
  ref?: string
}

/** A normalized inbound message. The adapter surfaces the platform *mechanics*
 *  (native mention of us, reply target, thread structure); the host owns mention
 *  *policy* (room.requireMention, custom mentionPatterns, reply-to-recent-bot)
 *  and computes the final routing decision from these signals — so policy stays
 *  platform-agnostic and lives in one place. */
export type IncomingMessage = {
  ref: MessageRef
  scope: ScopeId
  authorId: string
  authorName: string
  text: string
  /** Did this message *natively* address us (Discord @mention, Slack app_mention,
   *  Telegram @botname)? On platforms without mentions this is false and the room
   *  is expected to run mention-optional. */
  mentionsBot: boolean
  /** The platform id of the message this one replies to, if any (the host checks
   *  it against the bot's recent message ids to treat a reply as "directed"). */
  replyToMessageId?: string
  /** Is `scope` a sub-conversation (thread/topic) rather than the room itself? */
  isThread: boolean
  /** Files attached to this message, when the platform delivers them and
   *  `Capabilities.files.inbound` is true. Everything here is uploader-controlled
   *  and untrusted: the `url` may be signed/expiring or need auth (download at
   *  ingest), the `contentType`/`name` are spoofable (sniff bytes, sanitize name). */
  attachments?: IncomingAttachment[]
  /** A human-readable label for the scope the message arrived in (e.g.
   *  `#general › task-thread`), for the operator console + DM-courier header. The
   *  label is platform-specific formatting, computed by the adapter; the host
   *  treats it as opaque text. */
  scopeLabel?: string
}

/** A user tapped a button / chose an option (or typed the text fallback that the
 *  adapter parsed into a choice). `respond`/`update` let the resolver answer
 *  without importing a platform SDK. */
export type IncomingAction = {
  /** The chosen Choice.id (e.g. `appr:deny:<hash>`, `cflt:take:1`, `sess:pick:2`). */
  actionId: string
  userId: string
  /** The message the prompt was attached to. */
  ref: MessageRef
  scope: ScopeId
  /** The current text of the prompt message, so a resolver can append a verdict
   *  line to it (e.g. `${message}\n\n✅ Allowed`) when calling `update`. */
  message: string
  /** Reply to the actor (ephemeral where supported), e.g. "Not authorized." */
  respond(text: string, opts?: { ephemeral?: boolean }): Promise<void>
  /** Rewrite the prompt message to reflect the decision and drop its controls
   *  (pass `choices` to re-render controls instead of clearing them). */
  update(text: string, opts?: SendOpts): Promise<void>
}

/** A user added an emoji reaction to a message. */
export type IncomingReaction = {
  ref: MessageRef
  glyph: Glyph
  userId: string
}

/**
 * The contract. Implementations live in `adapters-msg/` and are selected by
 * `makeMessagingAdapter(platform, …)`. Lifecycle mirrors a Discord client:
 * construct, register handlers, `connect(token)`.
 */
export interface MessagingAdapter {
  /** Stable platform key, stamped onto inbound `channel.message` intents
   *  (replaces today's hardcoded 'discord'). */
  readonly platform: string

  // ─── lifecycle ────────────────────────────────────────────────────────────
  connect(token: string): Promise<void>
  disconnect(): Promise<void>
  /** Our own user id on this platform once connected (self-message filtering). */
  readonly botUserId: string | undefined
  /** A human-readable label for the bot account (e.g. Discord's `name#1234`),
   *  once connected — for the operator console line. Optional; falls back to
   *  botUserId. */
  readonly botLabel?: string | undefined
  capabilities(): Capabilities

  // ─── inbound (host registers handlers; adapter normalizes platform events) ──
  onMessage(handler: (m: IncomingMessage) => void): void
  onAction(handler: (a: IncomingAction) => void): void
  onReaction(handler: (r: IncomingReaction) => void): void
  /** Was the message `messageId` in `scope` authored by the bot? Used by the
   *  host's mention policy to treat a reply to one of our messages as "directed"
   *  when it isn't already in the in-process recent-message cache. Best-effort:
   *  false when it can't be resolved (the reply isn't treated as a mention). */
  authoredByBot(scope: ScopeId, messageId: string): Promise<boolean>

  // ─── outbound ───────────────────────────────────────────────────────────────
  /** Post to a scope; returns a ref for later react/edit/pin, or undefined on failure. */
  send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  /** Edit a posted message in place (capability `edit`). Returns false when the
   *  edit could not be applied — the target was deleted, or the platform can't
   *  edit — so a caller that needs the message to exist (the Workbench pill) can
   *  re-post instead. */
  edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean>
  react(ref: MessageRef, glyph: Glyph): Promise<void>
  unreact(ref: MessageRef, glyph: Glyph): Promise<void>
  /** Pin a message (capability `pin`). */
  pin(ref: MessageRef): Promise<void>
  /** Private message to a user; returns the ref in the DM scope. */
  dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  /** Best-effort typing indicator; fire-and-forget. */
  typing(scope: ScopeId): void
  /** Fetch the bytes of an inbound attachment (capability `files.inbound`). The
   *  ingest sync calls this at receive time because platform attachment URLs are
   *  signed/expiring or require auth. `ref` is the opaque IncomingAttachment.ref
   *  for platforms that need more than the URL. Undefined on failure or when the
   *  platform has no file support. */
  downloadAttachment?(url: string, ref?: string): Promise<Uint8Array | undefined>

  // ─── structure (capability-gated) ────────────────────────────────────────────
  /** Spawn a task sub-scope from a message (capability `threads`); undefined when
   *  unsupported, so the host runs the task at the room scope. */
  startThread(ref: MessageRef, name: string): Promise<ScopeId | undefined>
  /** Resolve a sub-scope to its parent room, else undefined (a room resolves to
   *  itself upstream). The single scope→room seam, per-platform. */
  parentOf(scope: ScopeId): Promise<ScopeId | undefined>
  /** Synchronous, no-I/O variant of `parentOf` — returns a thread's parent room
   *  only if the adapter already knows it from its local cache, else undefined.
   *  The host's `roomForScope` is called in many synchronous code paths, so it
   *  needs a cache-only probe; the async `parentOf` is for platforms that must
   *  fetch. On a cold cache this returns undefined and the host relies on the
   *  scope→room memo it built when the message first arrived. */
  parentOfSync(scope: ScopeId): ScopeId | undefined
}
