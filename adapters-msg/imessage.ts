/**
 * iMessageMessagingAdapter — WALKING SKELETON, macOS-only, pending live
 * verification. Requires Full Disk Access for the relay process to read
 * ~/Library/Messages/chat.db.
 *
 * iMessage is the hardest platform and the key stress-test of the text-command
 * fallback layer: it has NO reactions, NO threads, NO buttons, NO edit. The
 * ONLY interactive path is the numbered text menu (`choiceMenuText`) + the
 * inbound free-text parser (`parseChoiceReply`) — when the host posts a prompt
 * with `choices`, we append a "Reply 1=… · 2=…" menu and remember the pending
 * choices per scope; the user's typed reply is parsed back into an
 * `IncomingAction` before it would otherwise surface as a plain message.
 *
 * Mechanism:
 *  - INBOUND  : poll the local Messages SQLite db (`~/Library/Messages/chat.db`)
 *               on a ~1500ms interval, reading rows past a high-water ROWID so
 *               history is never replayed. Open read-only via `bun:sqlite`.
 *  - OUTBOUND : drive the Messages.app via `osascript` (AppleScript) through
 *               `Bun.spawn`. AppleScript can `send` to a chat by guid or to a
 *               buddy/handle, but cannot tapback, edit, pin, or thread.
 *
 * Stubbed / honest skeleton limits (each is also commented at its site):
 *  - attributedBody decoding: when `message.text` is NULL the body lives in a
 *    binary NSAttributedString blob; we use a crude readable-substring heuristic
 *    and skip the row if we can't extract anything. NOT a real archive decoder.
 *  - synthetic message ids: AppleScript `send` returns nothing, so outbound
 *    `MessageRef.id` is a locally-generated `imsg:<counter>` — not a real
 *    chat.db ROWID. react/edit/pin against it are no-ops anyway.
 *  - NO reactions / edit / pin / threads / buttons: capability-declared false;
 *    the methods are no-ops. Tapbacks are NOT reachable via AppleScript — a
 *    richer future adapter would talk to BlueBubbles (a local HTTP bridge that
 *    exposes tapbacks, typing, and message ids).
 *  - dm-by-handle: `dm()` sends to a buddy/handle best-effort; group-vs-direct
 *    routing and handle resolution are not validated here.
 *  - mentionsBot is always true: every allowlisted inbound in iMessage is, by
 *    construction, directed at us (1:1 or a chat the owner allowlisted). The
 *    host owns the actual allowlist gate; we just surface everything.
 */

import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import { choiceMenuText, parseChoiceReply } from '../messaging-fallback.ts'

/** Default poll interval for new chat.db rows. */
const POLL_MS = 1500

/** iMessage has no hard outbound cap; we declare a generous ceiling and never
 *  truncate in practice. */
const MAX_LEN = 100_000

/** One row as read from chat.db. */
type DbRow = {
  ROWID: number
  text: string | null
  attributedBody: Uint8Array | null
  is_from_me: number
  handle: string | null
  chat_guid: string | null
}

export class iMessageMessagingAdapter implements MessagingAdapter {
  readonly platform = 'imessage'

  /** Pending interactive menus, keyed by scope (chat guid). The next inbound
   *  text in that scope is first run through `parseChoiceReply` against this. */
  private readonly pendingChoices = new Map<string, Choice[]>()

  private db: Database | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  /** High-water ROWID — only rows strictly greater are surfaced, so connecting
   *  never replays history. */
  private watermark = 0
  /** Monotonic counter behind the synthetic outbound message ids. */
  private sendCounter = 0

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  private onReactionHandler?: (r: IncomingReaction) => void

  /** Path to the local Messages db; overridable for testing, else the default. */
  private readonly dbPath: string

  constructor(opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath ?? join(homedir(), 'Library', 'Messages', 'chat.db')
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  /** iMessage is macOS-only (it drives Messages.app via AppleScript and reads
   *  the local chat.db). `token` is ignored — there are no credentials; access
   *  is purely local and gated by macOS Full Disk Access. */
  async connect(_token: string): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error(
        'iMessageMessagingAdapter is macOS-only: it reads ~/Library/Messages/chat.db ' +
          'and drives Messages.app via osascript, neither of which exists off darwin.',
      )
    }
    // Read-only open: we never write to chat.db (outbound goes through
    // AppleScript). Requires the relay process to have Full Disk Access.
    this.db = new Database(this.dbPath, { readonly: true })
    // Watermark to the current tail so we don't replay existing history.
    this.watermark = this.currentMaxRowId()
    this.pollTimer = setInterval(() => this.poll(), POLL_MS)
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.db?.close()
    this.db = undefined
  }

  /** There is no platform-assigned bot user id for a local Messages account; the
   *  outbound side is "me" and inbound self-messages are filtered by
   *  `is_from_me`, not by id. */
  get botUserId(): string | undefined {
    return undefined
  }

  get botLabel(): string | undefined {
    return 'iMessage (this Mac)'
  }

  capabilities(): Capabilities {
    return {
      reactions: 'none', // no tapbacks via AppleScript → status lives in text
      threads: false, // no native sub-conversations
      buttons: false, // no inline components → numbered text menu fallback
      edit: false, // sent messages can't be edited
      pin: false,
      dm: true, // 1:1 send to a handle/buddy
      mentions: 'text', // "addressed to me" is implicit; never a native mention
      maxMessageLength: MAX_LEN,
      experimental: true,
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
    // iMessage surfaces no reaction events to us (tapbacks aren't readable
    // through this skeleton's path); kept for interface symmetry — never fires.
    this.onReactionHandler = handler
  }

  /** We have no posted-message id table to consult (outbound ids are synthetic),
   *  so a "reply to one of our messages" check can't be resolved. Best-effort
   *  false, per the contract — iMessage runs mention-optional anyway. */
  async authoredByBot(_scope: ScopeId, _messageId: string): Promise<boolean> {
    return false
  }

  // ─── outbound ─────────────────────────────────────────────────────────────────

  /** Post to a chat by guid via AppleScript. When `opts.choices` is present we
   *  append a numbered text menu (no buttons on this platform) and remember the
   *  choices so the next inbound reply in this scope is parsed back into an
   *  action. Returns a SYNTHETIC ref — AppleScript `send` yields no id. */
  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    let body = text
    if (opts?.mentionUser) {
      // No native mentions; prefix the handle as plain text where asked.
      body = `${opts.mentionUser}: ${body}`
    }
    if (opts?.choices && opts.choices.length > 0) {
      body = `${body}\n${choiceMenuText(opts.choices)}`
      this.pendingChoices.set(scope, opts.choices)
    }
    const script =
      `tell application "Messages"\n` +
      `  set theChat to a reference to chat id "${appleEscape(scope)}"\n` +
      `  send ${appleStringExpr(body)} to theChat\n` +
      `end tell`
    const ok = await this.runOsascript(script)
    if (!ok) return undefined
    // Synthetic id: AppleScript doesn't return the new message's ROWID, so we
    // mint a local one. It is NOT resolvable in chat.db and is only ever used as
    // an opaque handle (react/edit/pin are no-ops on this platform).
    return { id: `imsg:${++this.sendCounter}`, scope }
  }

  /** Sent iMessages cannot be edited. Always false so callers (e.g. the
   *  Workbench pill) re-post instead. */
  async edit(_ref: MessageRef, _text: string, _opts?: SendOpts): Promise<boolean> {
    return false
  }

  /** No tapbacks via AppleScript — no-op. `mapGlyphToReaction` returns null for
   *  this platform's 'none' reactions, so the host won't ask for a meaningful
   *  glyph anyway; status is conveyed in message text. (BlueBubbles is the
   *  alternative bridge for real tapbacks in a future richer adapter.) */
  async react(_ref: MessageRef, _glyph: Glyph): Promise<void> {
    /* no-op: reactions:'none' */
  }

  async unreact(_ref: MessageRef, _glyph: Glyph): Promise<void> {
    /* no-op: reactions:'none' */
  }

  async pin(_ref: MessageRef): Promise<void> {
    /* no-op: iMessage has no pin */
  }

  /** Best-effort 1:1 to a handle (phone/email). AppleScript addresses a buddy on
   *  the iMessage service; group-vs-direct routing and handle normalization are
   *  not validated in this skeleton. Returns a synthetic ref scoped to the
   *  handle (the DM "scope" is the handle id). */
  async dm(userId: string, text: string, _opts?: SendOpts): Promise<MessageRef | undefined> {
    const script =
      `tell application "Messages"\n` +
      `  send ${appleStringExpr(text)} to buddy "${appleEscape(userId)}" of (first service whose service type is iMessage)\n` +
      `end tell`
    const ok = await this.runOsascript(script)
    if (!ok) return undefined
    return { id: `imsg:${++this.sendCounter}`, scope: userId }
  }

  /** No typing indicator reachable via AppleScript — no-op. */
  typing(_scope: ScopeId): void {
    /* no-op */
  }

  // ─── structure ────────────────────────────────────────────────────────────────

  /** No native threads — undefined so the host runs the task at the chat scope. */
  async startThread(_ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    return undefined
  }

  /** A chat has no parent room on iMessage — undefined (the caller treats the
   *  scope as its own room). */
  async parentOf(_scope: ScopeId): Promise<ScopeId | undefined> {
    return undefined
  }

  parentOfSync(_scope: ScopeId): ScopeId | undefined {
    return undefined
  }

  // ─── inbound polling (iMessage-specific) ───────────────────────────────────────

  /** SELECT MAX(ROWID) for the watermark; 0 when the table is empty/unreadable. */
  private currentMaxRowId(): number {
    if (!this.db) return 0
    try {
      const r = this.db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number | null } | undefined
      return r?.m ?? 0
    } catch {
      return 0
    }
  }

  /** One poll tick: read rows past the watermark, surface inbound (or parse a
   *  pending-menu reply into an action), and advance the watermark. */
  private poll(): void {
    if (!this.db) return
    let rows: DbRow[]
    try {
      rows = this.db
        .prepare(
          'SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, ' +
            'h.id AS handle, c.guid AS chat_guid ' +
            'FROM message m ' +
            'LEFT JOIN handle h ON m.handle_id = h.ROWID ' +
            'LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID ' +
            'LEFT JOIN chat c ON c.ROWID = cmj.chat_id ' +
            'WHERE m.ROWID > ? ORDER BY m.ROWID ASC',
        )
        .all(this.watermark) as DbRow[]
    } catch {
      // Transient read error (db busy, etc.) — skip this tick, retry next.
      return
    }

    for (const row of rows) {
      // Always advance the watermark, even for skipped rows, so we never re-read.
      if (row.ROWID > this.watermark) this.watermark = row.ROWID

      if (row.is_from_me === 1) continue // our own outbound

      const scope = row.chat_guid
      if (!scope) continue // can't route a message with no chat guid

      const text = row.text ?? extractAttributedBody(row.attributedBody)
      // Skeleton limit: if text is null and the attributedBody heuristic finds
      // nothing readable, we skip the row rather than surface an empty message.
      if (text == null || text.length === 0) continue

      const handle = row.handle ?? 'unknown'
      const ref: MessageRef = { id: String(row.ROWID), scope }

      // Text-command fallback: if a numbered menu is pending in this scope and
      // the reply resolves to a choice, emit an action instead of a message.
      const pending = this.pendingChoices.get(scope) ?? []
      const choiceId = parseChoiceReply(text, pending)
      if (choiceId != null) {
        this.pendingChoices.delete(scope)
        this.emitAction(choiceId, handle, ref, scope)
        continue
      }

      this.emitMessage(text, handle, ref, scope)
    }
  }

  private emitMessage(text: string, handle: string, ref: MessageRef, scope: ScopeId): void {
    const h = this.onMessageHandler
    if (!h) return
    const m: IncomingMessage = {
      ref,
      scope,
      authorId: handle,
      authorName: handle,
      text,
      // Every allowlisted iMessage inbound is, by construction, directed at us
      // (no native mentions exist; the host's allowlist is the real gate).
      mentionsBot: true,
      isThread: false,
      scopeLabel: scope,
    }
    try {
      h(m)
    } catch {
      /* handler errors are isolated by the host's own catch */
    }
  }

  /** Build an IncomingAction from a parsed text-menu reply. There is no native
   *  prompt message to rewrite, so `respond`/`update` both just `send` back into
   *  the scope; `message` is empty (no original prompt text to carry). */
  private emitAction(actionId: string, userId: string, ref: MessageRef, scope: ScopeId): void {
    const h = this.onActionHandler
    if (!h) return
    const a: IncomingAction = {
      actionId,
      userId,
      ref,
      scope,
      message: '',
      respond: async (text) => {
        await this.send(scope, text)
      },
      update: async (text, opts) => {
        await this.send(scope, text, opts)
      },
    }
    try {
      h(a)
    } catch {
      /* isolated by the host */
    }
  }

  // ─── osascript helper ──────────────────────────────────────────────────────────

  /** Run an AppleScript via `osascript -e <script>`. Returns true on exit 0.
   *  Errors (Messages.app not running, permission denied) degrade to false so a
   *  failed send surfaces as `undefined` to the caller, never a throw. */
  private async runOsascript(script: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(['osascript', '-e', script], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      const code = await proc.exited
      return code === 0
    } catch {
      return false
    }
  }
}

// ─── pure helpers (no I/O, no state) ──────────────────────────────────────────

/** Escape a string for embedding inside an AppleScript double-quoted literal:
 *  backslashes first, then double-quotes. Use ONLY for values known to be
 *  single-line (a chat guid / handle); for message bodies use `appleStringExpr`,
 *  because AppleScript literals can NOT contain raw newlines. */
function appleEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Build an AppleScript string EXPRESSION from arbitrary text. A double-quoted
 *  AppleScript literal can't contain a raw newline, so we split on `\n`, escape
 *  each segment, and join them with `& linefeed &`. Single-line text yields a
 *  plain `"…"`; multi-line text (e.g. a body + `choiceMenuText` menu) yields
 *  `"a" & linefeed & "b"`. Without this, every menu/multi-line send fails. */
function appleStringExpr(s: string): string {
  return s
    .split('\n')
    .map(seg => `"${appleEscape(seg)}"`)
    .join(' & linefeed & ')
}

/**
 * Best-effort readable-text extraction from an NSAttributedString blob.
 *
 * SKELETON LIMITATION: this is NOT a real NSKeyedArchiver/typedstream decoder.
 * When `message.text` is NULL, the human-visible text is buried in a binary
 * `attributedBody` blob. As a crude heuristic we decode the bytes as latin1,
 * find the longest run of printable characters, and return it trimmed. This
 * works for many plain-text messages but will miss/garble rich or non-ASCII
 * content. A real implementation would decode the typedstream archive (or use a
 * bridge like BlueBubbles that hands back plain text). Returns null when nothing
 * usable is found, so the caller skips the row.
 */
function extractAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob || blob.length === 0) return null
  // Decode as latin1 so every byte maps to a char (no multi-byte loss for the
  // ASCII text we're scanning for).
  let raw = ''
  for (let i = 0; i < blob.length; i++) raw += String.fromCharCode(blob[i]!)
  // Find runs of printable ASCII (space..~) and pick the longest plausible one.
  // We skip the leading typedstream/class-name preamble by ignoring very short
  // runs and known marker tokens.
  const runs = raw.match(/[\x20-\x7e]{4,}/g) ?? []
  const SKIP = new Set([
    'NSString',
    'NSAttributedString',
    'NSDictionary',
    'NSObject',
    'NSNumber',
    'NSValue',
    'streamtyped',
    'NSMutableString',
    'NSMutableAttributedString',
    '__kIMMessagePartAttributeName',
    'NSMutableDictionary',
  ])
  let best = ''
  for (const run of runs) {
    const t = run.trim()
    if (SKIP.has(t)) continue
    // Drop runs that are mostly archive punctuation/class markers.
    if (/^[+iI@$#*]+$/.test(t)) continue
    if (t.length > best.length) best = t
  }
  return best.length > 0 ? best : null
}
