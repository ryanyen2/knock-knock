/**
 * NotionMessagingAdapter — the Notion implementation of MessagingAdapter, and the
 * only module that imports `@notionhq/client`.
 *
 * Notion is a LOCAL-RELAY transport via DB/comment-mediated polling (the GA,
 * "no-public-server" path from `docs/messaging-platforms-roadmap.md` §Phase 4-B).
 * There is no Discord-style outbound gateway and no app_mention event; instead the
 * relay POLLS the Notion REST API for new comments on the pages it can see and
 * writes back via `POST /v1/comments`. A Notion custom agent (or a human) enqueues
 * work by leaving a comment; the relay picks it up on its next poll and replies in
 * place. Fully async, no inbound endpoint, no waitlist.
 *
 * Mapping (see roadmap §Phase 4):
 *   page id           = ScopeId (the task lives on a page; its comment thread is
 *                       the turn lineage)
 *   parent db/page id = room (parentOf)  — the permission boundary
 *   comment id        = MessageRef.id
 *
 * Heavy degradations vs Discord (all encoded in `capabilities()`):
 *   no reactions, no buttons (choices degrade to a numbered text menu the host
 *   parses out of the reply comment), no DM, no editable comments, no file
 *   exchange, plain-text mention detection, and a ~3 req/s rate ceiling that makes
 *   the poll loop the cadence floor.
 *
 * DESIGN-ONLY (NOT implemented here): the cloud Worker / External-Agents-API
 * bidirectional bridge (roadmap §Phase 4-A). A Notion Worker is cloud-hosted and
 * our relay is local with no public URL, so the reachable-relay bridge needs a
 * tunnel + opt-in HTTPS endpoint. That breaks the "no server" purity and is left
 * to a fast-follow; this file is purely the polling substrate (B) it would sit on.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { Client } from '@notionhq/client'
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
  Glyph,
  WebhookRequest,
  WebhookResponse,
} from '../messaging-adapter.ts'
import { choiceMenuText, outboundFileNotice } from '../messaging-fallback.ts'
import { toNotionRichText } from './dialect.ts'

/** Notion rich_text is capped ~2000 chars per block; we design for that floor. */
const MAX_LEN = 2000

/** Politeness gap between Notion REST calls — the public API ceiling is ~3 req/s,
 *  so we serialize and space requests ~350ms apart to stay under it. */
const REQ_SPACING_MS = 350

/** How often the poll loop sweeps for new comments (the inbound cadence floor). */
const POLL_INTERVAL_MS = 10_000

/** Bound on accessible pages scanned per sweep, so a large workspace can't blow
 *  the rate budget on a single tick. */
const MAX_PAGES_PER_SWEEP = 25

// The Notion SDK response types are deep discriminated unions; we narrow the few
// fields we touch with small local shapes + pragmatic casts (mirroring how
// discord.ts casts channel/message unions). This keeps the file typecheck-clean
// without re-deriving the SDK's internal types.

type NotionRichTextNode = {
  type: string
  plain_text?: string
  mention?: { type: string; user?: { id?: string } }
}

type NotionComment = {
  id: string
  parent?: { type?: string; page_id?: string; block_id?: string }
  created_by?: { id?: string }
  rich_text?: NotionRichTextNode[]
  display_name?: { resolved_name?: string | null }
}

type NotionPageParent = {
  type?: string
  database_id?: string
  data_source_id?: string
  page_id?: string
  block_id?: string
}

export class NotionMessagingAdapter implements MessagingAdapter {
  readonly platform = 'notion'
  // A single Notion integration token (the primary `tokenEnv`); no extra secrets.
  readonly requiredSecrets = [] as const

  private notion: Client | undefined
  private _botUserId: string | undefined
  private _botLabel: string | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  // Registered for seam completeness; Notion has no buttons or reactions, so
  // these handlers are never invoked. Choices arrive as the human's reply comment
  // (a plain `channel.message`) which the HOST parses via `parseChoiceReply`.
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  // Dedup ledger: comment ids we've already surfaced, so a re-poll of the same
  // thread doesn't re-emit. Unbounded in v1 (a long-lived relay's comment set is
  // modest); a coordinator can cap/evict if needed.
  private readonly seenComments = new Set<string>()
  // First sweep only records existing comments as "seen" (a cold relay must not
  // replay the entire backlog as fresh inbound).
  private primed = false

  // Cache: page (scope) → its parent room id, populated as we resolve parents.
  private readonly scopeToRoom = new Map<ScopeId, ScopeId>()
  // Cache: page id → display label, for IncomingMessage.scopeLabel.
  private readonly pageLabel = new Map<ScopeId, string>()

  // ─── runtime config (configure, before connect) ──────────────────────────────
  /** Database / page ids this bot serves. When non-empty the sweep polls only these
   *  (a database room is expanded into its child pages), instead of search-everything.
   *  Empty ⇒ the v1 search-all fallback. */
  private trackedRooms: string[] = []
  /** 'poll' (default) or 'webhook' — in webhook mode the sweep is not armed. */
  private intake: 'poll' | 'webhook' = 'poll'
  /** Notion webhook `verification_token` (from the subscription handshake, or
   *  pre-seeded via the `notionVerificationToken` secret). When set, `X-Notion-Signature`
   *  is verified on each event. */
  private verificationToken: string | undefined

  configure(opts: { trackedRooms?: string[]; intake?: 'poll' | 'webhook' }): void {
    // Canonicalize tracked ids to the hyphenless form so they match scope ids the
    // adapter emits (and so a hyphenated entry in access.json still lines up).
    this.trackedRooms = (opts.trackedRooms ?? []).map(normalizeNotionId)
    if (opts.intake) this.intake = opts.intake
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  // Notion is single-token; `secrets` may carry a pre-seeded webhook verification token.
  async connect(token: string, secrets?: Record<string, string>): Promise<void> {
    this.notion = new Client({ auth: token })
    this.verificationToken = secrets?.notionVerificationToken
    try {
      const me = (await this.notion.users.me({})) as { id?: string; name?: string | null }
      this._botUserId = me.id
      this._botLabel = me.name ?? me.id
    } catch {
      // A bad token surfaces later on the first poll; don't throw out of connect.
    }
    this.stopped = false
    // INTAKE: poll comments locally (no public server) unless the host opted this bot
    // into webhook mode, in which case the WebhookReceiver feeds `ingestWebhook` instead.
    if (this.intake !== 'webhook') this.scheduleNextSweep(0)
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  get botLabel(): string | undefined {
    return this._botLabel
  }

  discoveryCapabilities(): DiscoveryCapabilities {
    // The channel is the page ID the operator names (no enumerable page list); the workspace
    // user list IS enumerable (member enumeration), but a bot cannot create a page as transport.
    return { selfId: true, channelEnumeration: false, memberEnumeration: true, channelCreation: false }
  }

  capabilities(): Capabilities {
    return {
      // No reactions API for comments → status presence degrades to text.
      reactions: 'none',
      // Comment threads are reply-only via the API (can't open a new thread), so
      // we report false — task scope collapses to the page and status stays text.
      threads: false,
      // No inline interactive components → choices render as a numbered text menu.
      buttons: false,
      // Comments ARE editable in place via `PATCH /v1/comments` (SDK
      // `comments.update`), so status/Workbench updates rewrite a comment instead of
      // spamming new ones.
      edit: true,
      pin: false,
      dm: false,
      // No native "integration was mentioned" event — detected by scanning text.
      mentions: 'text',
      maxMessageLength: MAX_LEN,
      // File exchange deferred for v1 (Notion has a multi-step file-upload API).
      files: { inbound: false, outbound: false, maxBytes: 0 },
    }
  }

  // ─── discovery enumeration (duck-typed, three-valued) ──────────────────────────
  // OFF the MessagingAdapter interface (like Discord's fetchRecent): the gap-resolver
  // duck-types this. Only member enumeration is supported (no page list, no page creation
  // as transport — see discoveryCapabilities), so only listMembers is present; its absence
  // for the others ⇒ the caller infers `unsupported`. A permission error degrades.

  /** Enumerate workspace people (the `channelId` is unused — Notion lists users
   *  workspace-wide, not per-page). Bot users are filtered out (`type === 'person'`). */
  async listMembers(_channelId: string): Promise<EnumerationOutcome> {
    if (!this.notion) return { kind: 'degraded', reason: 'not connected' }
    try {
      const res = (await this.notion.users.list({})) as {
        results?: Array<{ id?: string; type?: string; name?: string | null }>
      }
      const items: DiscoveredEntity[] = []
      for (const u of res.results ?? []) {
        if (u.type === 'person' && u.id) items.push({ id: u.id, label: u.name ?? u.id })
      }
      return { kind: 'results', items }
    } catch {
      return { kind: 'degraded', reason: 'cannot list Notion users (integration lacks access)' }
    }
  }

  // ─── inbound (host registers handlers; poll loop normalizes Notion events) ────

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.onMessageHandler = handler
  }

  // Never fires (no buttons). Registered only to satisfy the seam.
  onAction(handler: (a: IncomingAction) => void): void {
    this.onActionHandler = handler
  }

  // Never fires (no reactions). Registered only to satisfy the seam.
  onReaction(handler: (r: IncomingReaction) => void): void {
    this.onReactionHandler = handler
  }

  /** Was `messageId` (a comment) authored by us? Best-effort: compares the
   *  comment's `created_by.id` to our bot user id; false when unresolved. */
  async authoredByBot(_scope: ScopeId, messageId: string): Promise<boolean> {
    if (!this.notion || !this._botUserId) return false
    try {
      const c = (await this.notion.comments.retrieve({ comment_id: messageId })) as NotionComment
      return c.created_by?.id === this._botUserId
    } catch {
      return false
    }
  }

  // ─── outbound ─────────────────────────────────────────────────────────────────

  /** Post a comment on the page identified by `scope`. Choices (no buttons here)
   *  degrade to a numbered text menu the host parses out of the human's reply. */
  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    if (!this.notion) return undefined
    let content = text
    if (opts?.choices && opts.choices.length > 0) {
      content += `\n\n${choiceMenuText(opts.choices)}`
    }
    // Notion can't accept outbound files in v1 — append a text notice instead of
    // silently dropping the share.
    const notice = opts?.files ? outboundFileNotice(opts.files, this.capabilities()) : null
    if (notice) content += `\n${notice}`
    // Notion isn't markdown — translate the Discord render dialect into structured
    // rich_text nodes (bold/italic/code annotations, link nodes) instead of one
    // plain node that would show raw `**`/`-#`. Each node is ≤2000 chars; cap the
    // array at Notion's 100-element ceiling (post-on-reply already chunks upstream).
    const richText = toNotionRichText(content).slice(0, 100)
    try {
      const comment = (await this.notion.comments.create({
        parent: { page_id: scope },
        rich_text: richText,
      })) as { id: string }
      return { id: comment.id, scope }
    } catch {
      return undefined
    }
  }

  /** Edit a comment in place via `PATCH /v1/comments` (SDK `comments.update`). The
   *  body is re-rendered to rich_text the same way `send` builds it; returns false on
   *  any failure so the host can fall back to a re-post. */
  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    if (!this.notion) return false
    let content = text
    if (opts?.choices && opts.choices.length > 0) content += `\n\n${choiceMenuText(opts.choices)}`
    const notice = opts?.files ? outboundFileNotice(opts.files, this.capabilities()) : null
    if (notice) content += `\n${notice}`
    const richText = toNotionRichText(content).slice(0, 100)
    try {
      // `comments.update` is typed loosely across SDK minor versions; the REST shape
      // is { comment_id, rich_text }. Cast to satisfy the param type without re-deriving it.
      await this.notion.comments.update({ comment_id: ref.id, rich_text: richText } as never)
      return true
    } catch {
      return false
    }
  }

  // No reactions API for comments — no-op (capability reactions:'none').
  async react(_ref: MessageRef, _glyph: Glyph): Promise<void> {
    /* no-op: Notion has no reaction affordance on comments */
  }

  async unreact(_ref: MessageRef, _glyph: Glyph): Promise<void> {
    /* no-op: Notion has no reaction affordance on comments */
  }

  // No pinnable comment surface — no-op (capability pin:false).
  async pin(_ref: MessageRef): Promise<void> {
    /* no-op: Notion comments can't be pinned */
  }

  // No DM channel for an integration — undefined (capability dm:false). The host
  // degrades DM-shaped surfacing (e.g. dm-on-supersede) to an in-scope comment.
  async dm(_userId: string, _text: string, _opts?: SendOpts): Promise<MessageRef | undefined> {
    return undefined
  }

  // No typing indicator on Notion — no-op.
  typing(_scope: ScopeId): void {
    /* no-op: Notion has no typing indicator */
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  /** Notion can't open a new comment thread via the API (reply-only), so the host
   *  runs at page scope. Returns undefined (capability threads:false). */
  async startThread(_ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    return undefined
  }

  /** Resolve a page scope to its parent room (database / data_source / page id).
   *  Best-effort: undefined on failure. Caches the result for parentOfSync. */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    const cached = this.scopeToRoom.get(scope)
    if (cached) return cached
    if (!this.notion) return undefined
    try {
      const page = (await this.notion.pages.retrieve({ page_id: scope })) as {
        parent?: NotionPageParent
      }
      const room = roomFromParent(page.parent)
      if (room) this.scopeToRoom.set(scope, room)
      return room
    } catch {
      return undefined
    }
  }

  /** Sync, cache-only parent lookup (no I/O); undefined unless already resolved. */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    return this.scopeToRoom.get(scope)
  }

  // ─── poll loop (the local-pure inbound substrate; never throws) ────────────────

  private scheduleNextSweep(delayMs: number): void {
    if (this.stopped) return
    this.pollTimer = setTimeout(() => {
      void this.sweep()
        .catch(() => {
          /* a sweep must never crash the relay; errors are swallowed per-tick */
        })
        .finally(() => this.scheduleNextSweep(POLL_INTERVAL_MS))
    }, delayMs)
  }

  /**
   * One poll sweep: discover the pages to poll, then list each one's comments and
   * emit IncomingMessage for ones we haven't seen.
   *
   * When the host has configured `trackedRooms` (the `notion:<id>` channels from
   * access.json), the sweep polls only those project boundaries — closing the old
   * search-everything path that scanned (and was injection-exposed to) every page the
   * integration could see. Search-all remains only as the unconfigured fallback.
   * Requests are serialized + spaced (`pace()`) to respect the ~3 req/s ceiling.
   */
  private async sweep(): Promise<void> {
    if (!this.notion || this.stopped) return
    const pages = await this.discoverPages()
    for (const pageId of pages) {
      if (this.stopped) return
      await this.pollPageComments(pageId)
    }
    // After the first full sweep, everything seen so far is baseline — subsequent
    // sweeps emit only genuinely new comments.
    this.primed = true
  }

  /** The page ids to poll this sweep. With `trackedRooms` set: each tracked id is
   *  polled directly (a page room), and best-effort expanded as a data source into its
   *  child pages (a database room) — bounded by MAX_PAGES_PER_SWEEP. Unconfigured:
   *  fall back to v1 search-everything. */
  private async discoverPages(): Promise<ScopeId[]> {
    if (!this.notion) return []
    if (this.trackedRooms.length > 0) return this.discoverTrackedPages()
    try {
      await this.pace()
      const res = (await this.notion.search({
        filter: { property: 'object', value: 'page' },
        page_size: MAX_PAGES_PER_SWEEP,
      })) as { results?: Array<{ id?: string; object?: string; parent?: NotionPageParent }> }
      const out: ScopeId[] = []
      for (const r of res.results ?? []) {
        if (!r.id) continue
        const pageId = normalizeNotionId(r.id)
        // Opportunistically cache the scope→room parent so parentOfSync is warm.
        const room = roomFromParent(r.parent)
        if (room) this.scopeToRoom.set(pageId, room)
        out.push(pageId)
      }
      return out
    } catch {
      return []
    }
  }

  /** Expand the configured tracked rooms into pages to poll: the id itself (page
   *  room), plus any child pages when it's a data source (database room). */
  private async discoverTrackedPages(): Promise<ScopeId[]> {
    if (!this.notion) return []
    const out: ScopeId[] = []
    for (const id of this.trackedRooms) {
      if (out.length >= MAX_PAGES_PER_SWEEP) break
      // Always poll the id directly — comments on a page room live on the page itself.
      out.push(id)
      // Best-effort: if it's a data source (database), pull its child pages too. A page
      // id will just throw here and is skipped.
      try {
        await this.pace()
        const res = (await this.notion.dataSources.query({
          data_source_id: id,
          page_size: Math.max(1, MAX_PAGES_PER_SWEEP - out.length),
        } as never)) as { results?: Array<{ id?: string }> }
        for (const r of res.results ?? []) {
          if (r.id && out.length < MAX_PAGES_PER_SWEEP) {
            const childId = normalizeNotionId(r.id)
            this.scopeToRoom.set(childId, id) // child page's room is the database
            out.push(childId)
          }
        }
      } catch {
        // Not a data source (or query unsupported) — the direct poll above covers it.
      }
    }
    return out
  }

  /** List one page's comments and emit IncomingMessage for new, non-self ones. */
  private async pollPageComments(pageId: ScopeId): Promise<void> {
    if (!this.notion) return
    let cursor: string | undefined
    do {
      try {
        await this.pace()
        const res = (await this.notion.comments.list({
          block_id: pageId,
          ...(cursor ? { start_cursor: cursor } : {}),
        })) as {
          results?: NotionComment[]
          has_more?: boolean
          next_cursor?: string | null
        }
        for (const c of res.results ?? []) {
          this.handleComment(pageId, c)
        }
        cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined
      } catch {
        // A single page's comments failing must not abort the whole sweep.
        return
      }
    } while (cursor && !this.stopped)
  }

  /** Dedup, self-filter, normalize, and surface a single comment. */
  private handleComment(pageId: ScopeId, c: NotionComment): void {
    if (!c.id || this.seenComments.has(c.id)) return
    this.seenComments.add(c.id)
    // On the cold first sweep, record-but-don't-emit (no backlog replay).
    if (!this.primed) return
    // Self-filter our own comments (the host also self-filters, belt-and-braces).
    if (c.created_by?.id && c.created_by.id === this._botUserId) return
    const h = this.onMessageHandler
    if (!h) return
    try {
      h(this.toIncoming(pageId, c))
    } catch {
      /* handler errors are isolated by the host's own catch */
    }
  }

  // ─── webhook intake (event-driven mode; the relay's WebhookReceiver feeds this) ──

  /**
   * Parse a pushed Notion webhook. Handles the one-time subscription **verification**
   * handshake (Notion POSTs `{ verification_token }` when you create the subscription —
   * we capture it and echo 200), then `comment.created` events. Notion payloads are
   * ID-only, so we fetch the comment body via REST (reusing the poll path's shape),
   * dedup against `seenComments`, self-filter, and emit an IncomingMessage. When a
   * verification token is known, `X-Notion-Signature` is verified (401 on mismatch).
   */
  async ingestWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    let payload: {
      verification_token?: string
      type?: string
      entity?: { id?: string; type?: string }
      data?: { page_id?: string }
    }
    try {
      payload = JSON.parse(req.body)
    } catch {
      return { status: 400 }
    }

    // 1. Verification handshake — capture the token, echo it, and surface it on the
    //    relay console so the operator can paste it into Notion's "Verify" dialog and
    //    save it as NOTION_VERIFICATION_TOKEN to survive restarts.
    if (payload.verification_token) {
      this.verificationToken = payload.verification_token
      return {
        status: 200,
        body: payload.verification_token,
        log:
          `Notion webhook verification token (paste into the subscription's Verify ` +
          `dialog, and save as NOTION_VERIFICATION_TOKEN to persist):\n    ${payload.verification_token}`,
      }
    }

    // 2. Signature check when we have a token to verify against.
    if (this.verificationToken) {
      const sig = req.headers['x-notion-signature']
      if (!verifyNotionSignature(this.verificationToken, req.body, sig)) return { status: 401 }
    }

    // 3. Only act on new comments; other event types are accepted but ignored.
    if (payload.type !== 'comment.created') return { status: 202 }
    const commentId = payload.entity?.id
    const pageId = payload.data?.page_id ? normalizeNotionId(payload.data.page_id) : undefined
    if (!commentId || !pageId) return { status: 200 }
    if (this.seenComments.has(commentId)) return { status: 200 }
    this.seenComments.add(commentId)

    // 4. Fetch the comment body (the payload is ID-only), then emit.
    if (this.notion) {
      try {
        const c = (await this.notion.comments.retrieve({ comment_id: commentId })) as NotionComment
        if (!c.created_by?.id || c.created_by.id !== this._botUserId) {
          const h = this.onMessageHandler
          if (h) h(this.toIncoming(pageId, c))
        }
      } catch {
        /* best-effort; a failed fetch just drops this event */
      }
    }
    return { status: 200 }
  }

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(pageId: ScopeId, c: NotionComment): IncomingMessage {
    const nodes = c.rich_text ?? []
    const text = nodes.map(n => n.plain_text ?? '').join('')
    const authorId = c.created_by?.id ?? 'unknown'
    const authorName = c.display_name?.resolved_name ?? authorId
    // Canonicalize the page id so the scope matches the hyphenless room key in
    // access.json regardless of whether it arrived via poll (already hyphenless) or
    // webhook (hyphenated). Without this the host's exact-key room lookup misses.
    const scope = normalizeNotionId(pageId)
    return {
      ref: { id: c.id, scope },
      scope,
      authorId,
      authorName,
      text,
      mentionsBot: this.detectMention(nodes, text),
      isThread: false, // comment threads collapse to the page scope (threads:false)
      scopeLabel: this.pageLabel.get(scope) ?? `notion:${scope}`,
    }
  }

  /** Notion has no native "integration was mentioned" signal. Detect either a
   *  rich_text `mention` node referencing our bot user id, or our bot name in the
   *  plain text (case-insensitive). */
  private detectMention(nodes: NotionRichTextNode[], text: string): boolean {
    if (this._botUserId) {
      for (const n of nodes) {
        if (n.type === 'mention' && n.mention?.type === 'user' && n.mention.user?.id === this._botUserId) {
          return true
        }
      }
    }
    const label = this._botLabel
    if (label && label.length > 0 && text.toLowerCase().includes(label.toLowerCase())) {
      return true
    }
    return false
  }

  // ─── rate limiting ──────────────────────────────────────────────────────────

  /** Serialize + space REST calls ~350ms apart to respect Notion's ~3 req/s
   *  ceiling. Requests are issued sequentially in the sweep, so a single shared
   *  delay between calls is sufficient. */
  private async pace(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, REQ_SPACING_MS))
  }
}

/** Verify a Notion `X-Notion-Signature` header (`sha256=<hex>`) against the raw body,
 *  keyed by the subscription's `verification_token`. Constant-time; false on any
 *  malformed input. Pure (unit-testable). */
export function verifyNotionSignature(
  token: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false
  const expected = 'sha256=' + createHmac('sha256', token).update(body).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Canonicalize a Notion id to the hyphenless, lowercase form. The REST API and
 *  webhooks return hyphenated UUIDs, while `access.json` channel ids are stored
 *  hyphenless (`notionId` in setup) — so scope/room ids MUST be normalized to one form
 *  or an exact-key room lookup in the host fails (a webhook'd comment would be dropped).
 *  Pure; idempotent; passes non-id strings through unchanged. */
export function normalizeNotionId(id: string | undefined): string {
  return (id ?? '').replace(/-/g, '').toLowerCase()
}

/** Project a Notion page parent onto a room id (database / data_source / page /
 *  block), normalized to the hyphenless form. Workspace- and agent-parented pages have
 *  no room → undefined. Pure. */
function roomFromParent(parent: NotionPageParent | undefined): ScopeId | undefined {
  const raw =
    parent?.database_id ??
    parent?.data_source_id ??
    parent?.page_id ??
    parent?.block_id ??
    undefined
  return raw ? normalizeNotionId(raw) : undefined
}
