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

import { Client } from '@notionhq/client'
import type {
  MessagingAdapter,
  Capabilities,
  IncomingMessage,
  IncomingAction,
  IncomingReaction,
  MessageRef,
  ScopeId,
  SendOpts,
  Glyph,
} from '../messaging-adapter.ts'
import { choiceMenuText, outboundFileNotice } from '../messaging-fallback.ts'

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

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  // Notion is single-token; `secrets` (unused) is part of the seam contract.
  async connect(token: string, _secrets?: Record<string, string>): Promise<void> {
    this.notion = new Client({ auth: token })
    try {
      const me = (await this.notion.users.me({})) as { id?: string; name?: string | null }
      this._botUserId = me.id
      this._botLabel = me.name ?? me.id
    } catch {
      // A bad token surfaces later on the first poll; don't throw out of connect.
    }
    this.stopped = false
    // Start the local poll loop — there is NO public server (the GA path).
    this.scheduleNextSweep(0)
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

  capabilities(): Capabilities {
    return {
      // No reactions API for comments → status presence degrades to text.
      reactions: 'none',
      // Comment threads are reply-only via the API (can't open a new thread), so
      // we report false — task scope collapses to the page and status stays text.
      threads: false,
      // No inline interactive components → choices render as a numbered text menu.
      buttons: false,
      // Comments aren't editable in place via the API, so edit() always returns
      // false (the seam treats that as "re-post"). The capability must agree —
      // advertising edit:true would make the host trust an edit that can't succeed.
      edit: false,
      pin: false,
      dm: false,
      // No native "integration was mentioned" event — detected by scanning text.
      mentions: 'text',
      maxMessageLength: MAX_LEN,
      // File exchange deferred for v1 (Notion has a multi-step file-upload API).
      files: { inbound: false, outbound: false, maxBytes: 0 },
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
    const trimmed = content.length > MAX_LEN ? content.slice(0, MAX_LEN - 1) + '…' : content
    try {
      const comment = (await this.notion.comments.create({
        parent: { page_id: scope },
        rich_text: [{ type: 'text', text: { content: trimmed } }],
      })) as { id: string }
      return { id: comment.id, scope }
    } catch {
      return undefined
    }
  }

  /** Notion comments are NOT editable in the seam's sense. (`comments.update`
   *  exists, but our contract is "false ⇒ caller re-posts"; treating a status
   *  edit as a fresh comment is the honest degradation, since callers expect
   *  edit-in-place and Notion's update semantics/visibility differ.) Returning
   *  false lets the host re-post a fresh status comment instead. */
  async edit(_ref: MessageRef, _text: string, _opts?: SendOpts): Promise<boolean> {
    return false
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
   * One poll sweep: discover accessible pages, then for each list its comments and
   * emit IncomingMessage for ones we haven't seen.
   *
   * TODO(coordinator): this scans EVERY page the integration can see, which is
   * crude and burns the ~3 req/s budget. The host should instead pass an explicit
   * set of "tracked" page/database ids — the `notion:<id>` channels from
   * access.json — so the loop only polls the project boundaries that matter. The
   * search-everything path below is the v1 placeholder until that config seam
   * exists. Requests are already serialized + spaced (`pace()`) to respect the
   * rate limit, but a large workspace still wants the explicit tracked set.
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

  /** Accessible page ids (v1: search-everything; see sweep() TODO for the
   *  tracked-ids config gap the coordinator should close). */
  private async discoverPages(): Promise<ScopeId[]> {
    if (!this.notion) return []
    try {
      await this.pace()
      const res = (await this.notion.search({
        filter: { property: 'object', value: 'page' },
        page_size: MAX_PAGES_PER_SWEEP,
      })) as { results?: Array<{ id?: string; object?: string; parent?: NotionPageParent }> }
      const out: ScopeId[] = []
      for (const r of res.results ?? []) {
        if (!r.id) continue
        // Opportunistically cache the scope→room parent so parentOfSync is warm.
        const room = roomFromParent(r.parent)
        if (room) this.scopeToRoom.set(r.id, room)
        out.push(r.id)
      }
      return out
    } catch {
      return []
    }
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

  // ─── translation ──────────────────────────────────────────────────────────────

  private toIncoming(pageId: ScopeId, c: NotionComment): IncomingMessage {
    const nodes = c.rich_text ?? []
    const text = nodes.map(n => n.plain_text ?? '').join('')
    const authorId = c.created_by?.id ?? 'unknown'
    const authorName = c.display_name?.resolved_name ?? authorId
    return {
      ref: { id: c.id, scope: pageId },
      scope: pageId,
      authorId,
      authorName,
      text,
      mentionsBot: this.detectMention(nodes, text),
      isThread: false, // comment threads collapse to the page scope (threads:false)
      scopeLabel: this.pageLabel.get(pageId) ?? `notion:${pageId}`,
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

/** Project a Notion page parent onto a room id (database / data_source / page /
 *  block). Workspace- and agent-parented pages have no room → undefined. Pure. */
function roomFromParent(parent: NotionPageParent | undefined): ScopeId | undefined {
  if (!parent) return undefined
  return (
    parent.database_id ??
    parent.data_source_id ??
    parent.page_id ??
    parent.block_id ??
    undefined
  )
}
