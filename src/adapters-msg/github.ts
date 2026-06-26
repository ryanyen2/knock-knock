/**
 * GitHubMessagingAdapter — the GitHub implementation of MessagingAdapter.
 * The only module that imports `@octokit/rest`.
 *
 * GitHub is a LOCAL-RELAY POLLING transport: there is NO public webhook server
 * and NO GitHub Actions runner. Intake is the Notifications API long-poll
 * (`GET /notifications?participating=true`) run on a timer inside `connect()`,
 * exactly the way `getUpdates` works for Telegram — the platform's own endpoint
 * is borrowed as the event bus, so a laptop with no inbound URL still receives
 * events. See docs/messaging-platforms-roadmap.md "Phase 3 — GitHub".
 *
 * Scope/room mapping:
 *   - room  = a repo:            `"${owner}/${repo}"`
 *   - scope = an issue / PR:     `"${owner}/${repo}#${issue_number}"`
 *   - a new comment              = an inbound `channel.message`
 *   - the bot's reply            = `POST .../issues/{n}/comments`
 * The repo is the permission boundary (room); each issue/PR is a task thread
 * (scope) — so an issue scope reports `isThread: true`.
 *
 * Latency: the `X-Poll-Interval` header floors polling at ~60s, so this is an
 * ASYNC surface — right for coding work, wrong for live chat. Document, don't fight.
 *
 * Identity (v1): a single PAT machine-user token (simplest). A GitHub App with
 * webhooks disabled (higher rate ceiling, `name[bot]` author) is a future
 * enhancement — it would add `requiredSecrets` for the App private key + ids and
 * mint installation tokens; the rest of this adapter is unchanged by that.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { Octokit } from '@octokit/rest'
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
  WebhookRequest,
  WebhookResponse,
} from '../messaging-adapter.ts'
import { choiceMenuText, outboundFileNotice } from '../messaging-fallback.ts'
import { toGitHubMarkdown } from './dialect.ts'

/** GitHub's fixed reaction enum (the only content values the API accepts). */
type GitHubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes'

/**
 * Project glyph → GitHub reaction enum. GitHub reactions are a `whitelist`
 * (`reactions: 'whitelist'`); we advertise the unicode we can map in
 * `reactionWhitelist` and translate each here. Anything not in this table is
 * unmappable and the reaction is silently skipped (status lives in text).
 */
const GLYPH_TO_GH: Record<string, GitHubReactionContent> = {
  '👀': 'eyes', // saw / working
  '🏁': 'hooray', // done
  '⚠️': 'confused', // failed
  '⏹': '-1', // stopped
  '🛑': '-1', // owner stop control
  '🔁': 'rocket', // retry / override
  '✅': '+1', // approve
  '❌': '-1', // deny
  '👍': '+1',
  '👎': '-1',
  '🎉': 'hooray',
  '❤️': 'heart',
  '🚀': 'rocket',
}

/** The unicode glyphs we can render as a GitHub reaction (advertised whitelist). */
const REACTION_WHITELIST: Glyph[] = Object.keys(GLYPH_TO_GH)

/** GitHub's per-comment body cap (generous; 65536 chars). */
const MAX_LEN = 65_536

/** Default poll cadence when the server doesn't send `X-Poll-Interval` (seconds). */
const DEFAULT_POLL_INTERVAL_S = 60

// ─── scope encoding (pure helpers) ───────────────────────────────────────────

type ParsedScope = { owner: string; repo: string; issue_number: number }

/** Build a scope id from its parts: `"owner/repo#123"`. */
export function buildScopeId(owner: string, repo: string, issue_number: number): ScopeId {
  return `${owner}/${repo}#${issue_number}`
}

/** Build a room id (repo) from its parts: `"owner/repo"`. */
export function buildRoomId(owner: string, repo: string): ScopeId {
  return `${owner}/${repo}`
}

/** Parse `"owner/repo#123"` → its parts, or undefined if malformed. */
export function parseScopeId(scope: ScopeId): ParsedScope | undefined {
  const hash = scope.indexOf('#')
  if (hash < 0) return undefined
  const repoPart = scope.slice(0, hash)
  const numPart = scope.slice(hash + 1)
  const slash = repoPart.indexOf('/')
  if (slash < 0) return undefined
  const owner = repoPart.slice(0, slash)
  const repo = repoPart.slice(slash + 1)
  const issue_number = Number(numPart)
  if (!owner || !repo || !Number.isInteger(issue_number) || issue_number <= 0) return undefined
  return { owner, repo, issue_number }
}

/** The room (repo) a scope belongs to: `"owner/repo#123"` → `"owner/repo"`. */
export function roomOf(scope: ScopeId): ScopeId | undefined {
  const p = parseScopeId(scope)
  return p ? buildRoomId(p.owner, p.repo) : undefined
}

export class GitHubMessagingAdapter implements MessagingAdapter {
  readonly platform = 'github'

  // v1 is a single PAT machine-user token; no extra secrets. A future GitHub App
  // identity would populate this with the App id / installation id / private key.
  readonly requiredSecrets = [] as const

  private octokit: Octokit | undefined
  private _botUserId: string | undefined
  private _botLabel: string | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  // ─── poll-loop state ──────────────────────────────────────────────────────
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  /** `Last-Modified` from the previous notifications response → next `If-Modified-Since`. */
  private lastModified: string | undefined
  /** Comment ids we've already surfaced, so re-polling a thread never double-fires. */
  private readonly seenComments = new Set<number>()
  /** Per-scope cursor: only fetch comments created after this ISO timestamp. */
  private readonly threadCursor = new Map<ScopeId, string>()

  // ─── runtime config (configure, before connect) ──────────────────────────────
  /** Repos (`owner/repo`) this bot serves; notifications from other repos are
   *  skipped. Empty ⇒ accept any mentioning repo (back-compat). */
  private trackedRepos = new Set<string>()
  /** 'poll' (default) or 'webhook' — in webhook mode the poll loop is not armed. */
  private intake: 'poll' | 'webhook' = 'poll'
  /** Optional `X-Hub-Signature-256` secret for webhook verification (from `secrets`). */
  private webhookSecret: string | undefined

  configure(opts: { trackedRooms?: string[]; intake?: 'poll' | 'webhook' }): void {
    this.trackedRepos = new Set(opts.trackedRooms ?? [])
    if (opts.intake) this.intake = opts.intake
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  /** GitHub is single-token (PAT) in v1; `secrets` may carry a `webhookSecret`. */
  async connect(token: string, secrets?: Record<string, string>): Promise<void> {
    this.octokit = new Octokit({ auth: token })
    this.stopped = false
    this.webhookSecret = secrets?.webhookSecret
    try {
      const me = await this.octokit.users.getAuthenticated()
      this._botUserId = me.data.login
      this._botLabel = me.data.name ? `${me.data.name} (@${me.data.login})` : me.data.login
    } catch {
      // Auth probe failed; leave ids undefined (host falls back to undefined).
    }
    // INTAKE: poll the Notifications API (no public server) unless the host opted
    // this bot into webhook mode, in which case the WebhookReceiver feeds us instead.
    if (this.intake !== 'webhook') this.scheduleNextPoll(0)
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
      // GitHub permits only a fixed reaction set — map presence glyphs, else text.
      reactions: 'whitelist',
      reactionWhitelist: REACTION_WHITELIST,
      // The issue/PR IS the scope; the repo is the room. No sub-threads in v1.
      threads: false,
      // No inline buttons — choices degrade to a numbered text menu (host parses replies).
      buttons: false,
      edit: true, // PATCH a comment
      pin: false, // GitHub has no comment pin
      dm: false, // GitHub has no DM — degrades to an @mention comment (host side)
      mentions: 'text', // surfaced via the notification `reason: "mention"`
      maxMessageLength: MAX_LEN,
      // File exchange deferred for v1 (no inbound download, no outbound upload).
      files: { inbound: false, outbound: false, maxBytes: 0 },
    }
  }

  // ─── inbound (host registers handlers) ────────────────────────────────────

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.onMessageHandler = handler
  }

  /**
   * GitHub has NO native interactive components (no buttons), so this adapter
   * never emits an `IncomingAction` from a platform event. Choices are rendered
   * as a numbered text menu (see `send`); the user's free-text reply arrives as
   * an ordinary `IncomingMessage`, and the HOST parses it (`parseChoiceReply`)
   * back into an action. We register the handler to honor the seam, but it is
   * never invoked from here.
   */
  onAction(handler: (a: IncomingAction) => void): void {
    this.onActionHandler = handler
  }

  onReaction(handler: (r: IncomingReaction) => void): void {
    this.onReactionHandler = handler
  }

  // ─── the poll loop (intake) ───────────────────────────────────────────────

  /** Arm the next poll `delayMs` from now (cleared on disconnect). */
  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      void this.pollOnce()
    }, delayMs)
  }

  /**
   * One poll tick. Resilient by construction: every network call is wrapped so a
   * single failed request NEVER kills the loop — we always reschedule in a
   * `finally`. A 304 (not modified) costs no rate quota and means "no new data".
   */
  private async pollOnce(): Promise<void> {
    let nextDelayS = DEFAULT_POLL_INTERVAL_S
    const oc = this.octokit
    if (!oc) {
      this.scheduleNextPoll(DEFAULT_POLL_INTERVAL_S * 1000)
      return
    }
    try {
      const headers: Record<string, string> = {}
      if (this.lastModified) headers['If-Modified-Since'] = this.lastModified

      const res = await oc.activity.listNotificationsForAuthenticatedUser({
        participating: true,
        all: false,
        per_page: 50,
        headers,
      })

      // Honor the server's pacing for the next tick.
      const pollHdr = res.headers['x-poll-interval']
      const parsed = pollHdr ? Number(pollHdr) : NaN
      if (Number.isFinite(parsed) && parsed > 0) nextDelayS = parsed
      const lm = res.headers['last-modified']
      if (typeof lm === 'string' && lm) this.lastModified = lm

      for (const thread of res.data) {
        // First-class: only surface threads we were @mentioned in. No body parsing.
        if (thread.reason !== 'mention') continue
        try {
          await this.handleMentionThread(thread)
        } catch {
          // One bad thread never aborts the rest of this tick.
          continue
        }
      }
    } catch (err: unknown) {
      // 304 Not Modified: Octokit throws for non-2xx. Treat it as "no new data",
      // which is the normal cheap path — not an error.
      const status = (err as { status?: number })?.status
      if (status === 304) {
        // no-op; quota-free
      }
      // Any other failure (rate limit, network, 5xx): swallow and keep polling.
      // Honor a rate-limit reset hint if present so we back off instead of hammering.
      const resetHdr = (err as { response?: { headers?: Record<string, string> } })?.response
        ?.headers?.['x-ratelimit-reset']
      const reset = resetHdr ? Number(resetHdr) : NaN
      if (status === 403 && Number.isFinite(reset)) {
        const waitS = Math.max(0, Math.ceil(reset - Date.now() / 1000))
        nextDelayS = Math.max(nextDelayS, Math.min(waitS, 3600))
      }
    } finally {
      this.scheduleNextPoll(nextDelayS * 1000)
    }
  }

  /**
   * Fetch the new comments on one mentioning issue/PR and surface each as an
   * IncomingMessage. Deduped by comment id (so re-polling never double-fires) and
   * windowed by a per-scope `since` cursor (so we don't re-walk old comments).
   */
  private async handleMentionThread(thread: {
    subject?: { url?: string | null } | null
    repository?: { owner?: { login?: string } | null; name?: string | null } | null
    updated_at?: string | null
  }): Promise<void> {
    const oc = this.octokit
    const h = this.onMessageHandler
    if (!oc || !h) return

    const owner = thread.repository?.owner?.login
    const repo = thread.repository?.name
    const issueNumber = issueNumberFromSubjectUrl(thread.subject?.url ?? undefined)
    if (!owner || !repo || issueNumber == null) return

    // Scope the sweep to the repos this bot serves (when the host configured a set).
    if (this.trackedRepos.size > 0 && !this.trackedRepos.has(buildRoomId(owner, repo))) return

    const scope = buildScopeId(owner, repo, issueNumber)
    const since = this.threadCursor.get(scope)

    const comments = await oc.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      ...(since ? { since } : {}),
      per_page: 100,
    })

    let newestSeen = since
    for (const c of comments.data) {
      if (this.seenComments.has(c.id)) continue
      this.seenComments.add(c.id)

      // Track the newest comment timestamp as the next cursor.
      if (c.created_at && (!newestSeen || c.created_at > newestSeen)) newestSeen = c.created_at

      // Skip our own comments (self-message filtering is also the host's job, but
      // we avoid a feedback loop on the surface we're polling).
      const authorLogin = c.user?.login ?? ''
      if (this._botUserId && authorLogin === this._botUserId) continue

      const body = c.body ?? ''
      // We only reach here because the notification reason was "mention", so the
      // bot was addressed by definition. (A literal `@${botUserId}` in the body
      // would also qualify, but the reason gate already guarantees it.)
      const mentionsBot = true

      try {
        h({
          ref: { id: String(c.id), scope },
          scope,
          authorId: authorLogin,
          authorName: authorLogin,
          text: body,
          mentionsBot,
          authorAssociation: c.author_association,
          isThread: true, // the issue/PR is the task scope; the repo is the room
          scopeLabel: scope,
        })
      } catch {
        // Handler errors are isolated by the host's own catch.
      }
    }
    if (newestSeen) this.threadCursor.set(scope, newestSeen)
  }

  // ─── webhook intake (event-driven mode; the relay's WebhookReceiver feeds this) ──

  /**
   * Parse a pushed GitHub webhook and surface new `issue_comment` events as
   * `IncomingMessage`s. Handles the `ping` handshake (200) and verifies
   * `X-Hub-Signature-256` when a `webhookSecret` is configured (401 on mismatch).
   * No extra REST call is needed — the payload carries the comment body, author,
   * and `author_association` directly. Deduped against the same `seenComments` the
   * poll path uses, so flipping modes (or a hybrid) never double-fires.
   */
  async ingestWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const event = req.headers['x-github-event']
    if (event === 'ping') return { status: 200, body: 'pong' }

    if (this.webhookSecret) {
      const sig = req.headers['x-hub-signature-256']
      if (!verifyGitHubSignature(this.webhookSecret, req.body, sig)) return { status: 401 }
    }
    if (event !== 'issue_comment') return { status: 202 } // accepted but not acted on

    const parsed = parseIssueCommentEvent(req.body)
    if (!parsed || parsed.action === 'deleted') return { status: 200 }

    // Scope to the repos this bot serves, when configured.
    if (this.trackedRepos.size > 0 && !this.trackedRepos.has(parsed.room)) return { status: 200 }
    // Self-filter and dedup against the poll path's seen set.
    if (this._botUserId && parsed.authorLogin === this._botUserId) return { status: 200 }
    if (this.seenComments.has(parsed.commentId)) return { status: 200 }
    this.seenComments.add(parsed.commentId)

    const h = this.onMessageHandler
    if (h) {
      try {
        h({
          ref: { id: String(parsed.commentId), scope: parsed.scope },
          scope: parsed.scope,
          authorId: parsed.authorLogin,
          authorName: parsed.authorLogin,
          text: parsed.body,
          // A webhook subscription delivers every comment on subscribed repos, not
          // only @mentions — leave directedness to the host's mention gate.
          mentionsBot: this._botUserId ? parsed.body.includes(`@${this._botUserId}`) : false,
          authorAssociation: parsed.authorAssociation,
          isThread: true,
          scopeLabel: parsed.scope,
        })
      } catch {
        /* host isolates handler errors */
      }
    }
    return { status: 200 }
  }

  // ─── outbound ─────────────────────────────────────────────────────────────

  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    const oc = this.octokit
    const p = parseScopeId(scope)
    if (!oc || !p) return undefined
    try {
      const body = this.buildBody(text, opts)
      const res = await oc.issues.createComment({
        owner: p.owner,
        repo: p.repo,
        issue_number: p.issue_number,
        body,
      })
      return { id: String(res.data.id), scope }
    } catch {
      return undefined
    }
  }

  async edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<boolean> {
    const oc = this.octokit
    const p = parseScopeId(ref.scope)
    const commentId = Number(ref.id)
    if (!oc || !p || !Number.isInteger(commentId)) return false
    try {
      await oc.issues.updateComment({
        owner: p.owner,
        repo: p.repo,
        comment_id: commentId,
        body: this.buildBody(text, opts),
      })
      return true
    } catch {
      return false
    }
  }

  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const oc = this.octokit
    const p = parseScopeId(ref.scope)
    const commentId = Number(ref.id)
    const content = GLYPH_TO_GH[glyph]
    // Unmappable glyph → skip (status conveyed in text instead).
    if (!oc || !p || !Number.isInteger(commentId) || !content) return
    try {
      await oc.reactions.createForIssueComment({
        owner: p.owner,
        repo: p.repo,
        comment_id: commentId,
        content,
      })
    } catch {
      /* best-effort */
    }
  }

  async unreact(ref: MessageRef, glyph: Glyph): Promise<void> {
    const oc = this.octokit
    const p = parseScopeId(ref.scope)
    const commentId = Number(ref.id)
    const content = GLYPH_TO_GH[glyph]
    if (!oc || !p || !Number.isInteger(commentId) || !content) return
    try {
      // Find our reaction of this content on the comment, then delete it by id.
      const list = await oc.reactions.listForIssueComment({
        owner: p.owner,
        repo: p.repo,
        comment_id: commentId,
        content,
        per_page: 100,
      })
      const mine = list.data.find(
        r => r.content === content && (!this._botUserId || r.user?.login === this._botUserId),
      )
      if (mine) {
        await oc.reactions.deleteForIssueComment({
          owner: p.owner,
          repo: p.repo,
          comment_id: commentId,
          reaction_id: mine.id,
        })
      }
    } catch {
      /* best-effort */
    }
  }

  /** GitHub has no comment pin — no-op (capability `pin: false`). */
  async pin(_ref: MessageRef): Promise<void> {
    return
  }

  /**
   * GitHub has no DM channel. Returns undefined (capability `dm: false`); the
   * host degrades DM-shaped surfacing (e.g. `dm-on-supersede`) to an @mention
   * comment in-scope.
   */
  async dm(
    _userId: string,
    _text: string,
    _opts?: SendOpts,
  ): Promise<MessageRef | undefined> {
    return undefined
  }

  /** No typing indicator on GitHub — no-op. */
  typing(_scope: ScopeId): void {
    return
  }

  /** File ingest is disabled in v1 (`files.inbound: false`); always undefined. */
  async downloadAttachment(_url: string, _ref?: string): Promise<Uint8Array | undefined> {
    return undefined
  }

  // ─── structure (capability-gated) ──────────────────────────────────────────

  /**
   * The issue/PR conversation IS the scope, so there is no sub-thread to open.
   * Returns undefined; the host runs at issue scope.
   */
  async startThread(_ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    return undefined
  }

  /** Resolve an issue/PR scope to its repo room. No I/O — pure string parse. */
  async parentOf(scope: ScopeId): Promise<ScopeId | undefined> {
    return roomOf(scope)
  }

  /** Sync variant — same pure parse (no cache needed; the room is in the id). */
  parentOfSync(scope: ScopeId): ScopeId | undefined {
    return roomOf(scope)
  }

  /**
   * Was `messageId` (a comment id) authored by us? Best-effort: fetch the comment
   * and compare its author login to ours; false on any failure.
   */
  async authoredByBot(scope: ScopeId, messageId: string): Promise<boolean> {
    const oc = this.octokit
    const p = parseScopeId(scope)
    const commentId = Number(messageId)
    if (!oc || !p || !Number.isInteger(commentId) || !this._botUserId) return false
    try {
      const res = await oc.issues.getComment({
        owner: p.owner,
        repo: p.repo,
        comment_id: commentId,
      })
      return res.data.user?.login === this._botUserId
    } catch {
      return false
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /**
   * Compose a comment body. Buttons aren't supported, so choices degrade to a
   * numbered text menu appended to the body (`choiceMenuText`) — the user replies
   * with a number/word and the HOST parses it. Outbound files degrade to a text
   * notice (`files.outbound: false`). A `mentionUser` is prefixed as `@login`.
   */
  private buildBody(text: string, opts?: SendOpts): string {
    // GFM renders **bold**/headings/links natively; translate only the genuine
    // gaps (`-#` subtext, `<@id>` angle mentions). The mention prefix is GitHub's.
    const rendered = toGitHubMarkdown(text)
    let body = opts?.mentionUser ? `@${opts.mentionUser} ${rendered}` : rendered
    if (opts?.choices && opts.choices.length > 0) {
      const menu = choiceMenuText(opts.choices)
      if (menu) body = `${body}\n\n${menu}`
    }
    const notice = opts?.files ? outboundFileNotice(opts.files, this.capabilities()) : null
    if (notice) body = `${body}\n\n${notice}`
    return body.length > MAX_LEN ? body.slice(0, MAX_LEN - 1) + '…' : body
  }
}

/**
 * Extract the issue/PR number from a notification subject URL, e.g.
 * `https://api.github.com/repos/o/r/issues/42` → 42 (works for `/pulls/N` too).
 * Returns undefined when the trailing segment isn't a number.
 */
export function issueNumberFromSubjectUrl(url: string | undefined): number | undefined {
  if (!url) return undefined
  const last = url.split('/').filter(Boolean).pop()
  if (!last) return undefined
  const n = Number(last)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) against the raw
 *  body using the shared webhook secret. Constant-time compare; false on any
 *  malformed input. Pure (unit-testable). */
export function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

type ParsedIssueComment = {
  action: string
  room: ScopeId
  scope: ScopeId
  commentId: number
  authorLogin: string
  authorAssociation?: string
  body: string
}

/** Parse an `issue_comment` webhook body into the fields we surface, or undefined if
 *  the shape is unexpected. Pure (unit-testable). Works for issue and PR-conversation
 *  comments alike (GitHub models a PR as an issue). */
export function parseIssueCommentEvent(body: string): ParsedIssueComment | undefined {
  let p: {
    action?: string
    comment?: { id?: number; body?: string; user?: { login?: string }; author_association?: string }
    issue?: { number?: number }
    repository?: { name?: string; owner?: { login?: string } }
  }
  try {
    p = JSON.parse(body)
  } catch {
    return undefined
  }
  const owner = p.repository?.owner?.login
  const repo = p.repository?.name
  const num = p.issue?.number
  const commentId = p.comment?.id
  if (!owner || !repo || typeof num !== 'number' || typeof commentId !== 'number') return undefined
  return {
    action: p.action ?? '',
    room: buildRoomId(owner, repo),
    scope: buildScopeId(owner, repo, num),
    commentId,
    authorLogin: p.comment?.user?.login ?? '',
    authorAssociation: p.comment?.author_association,
    body: p.comment?.body ?? '',
  }
}
