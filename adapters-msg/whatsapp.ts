/**
 * WhatsAppMessagingAdapter — WALKING SKELETON, pending live verification.
 *
 * Required credentials / env vars:
 *   - WHATSAPP_PHONE_NUMBER_ID   — the Meta-assigned phone number id for the sending number
 *   - WHATSAPP_VERIFY_TOKEN      — a secret string you choose and register in the Meta app dashboard
 *   - WHATSAPP_WEBHOOK_PORT      — port Bun.serve listens on (default: 8787); must be publicly
 *                                   reachable (reverse proxy / ngrok / Cloud Run). Register the
 *                                   public URL in Meta App Dashboard → WhatsApp → Configuration →
 *                                   Webhook URL as `https://<host>/webhook`.
 *
 * The system-user access token is passed to `connect(token)` — store it in .env as any name you
 * choose and reference that name in the agent config (same pattern as DISCORD_BOT_TOKEN).
 *
 * Webhook requirement:
 *   Meta pushes events to your server; there is NO polling. You must expose `WHATSAPP_WEBHOOK_PORT`
 *   publicly and register the URL in the Meta App Dashboard before any messages arrive.
 *
 * Stubbed / not supported:
 *   - edit()        — WhatsApp Cloud API has no message-edit endpoint; always returns false.
 *   - pin()         — no-op; WhatsApp has no pinning API.
 *   - typing()      — no typing-indicator API in the Cloud API; fire-and-forget no-op.
 *   - startThread() — WhatsApp has no thread/topic concept; always returns undefined.
 *   - parentOf()    — no thread hierarchy; always returns undefined.
 *   - buttons cap   — WhatsApp interactive buttons are capped at 3. When opts.choices has >3
 *                     items (or buttons are unavailable) the adapter falls back to a numbered
 *                     text menu via choiceMenuText() + parseChoiceReply().
 *   - botUserId     — set to the phone number id (there is no "bot user" concept in the Cloud API).
 *   - authoredByBot — not reliably determinable without a message store; always returns false.
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
import { mapGlyphToReaction, choiceMenuText, parseChoiceReply } from '../messaging-fallback.ts'

/** Base URL for the Meta Graph API (Cloud API). */
const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

/** WhatsApp interactive button title max length (Meta enforces 20 chars). */
const BUTTON_TITLE_MAX = 20

/** WhatsApp max inline buttons per message. */
const WA_BUTTON_CAP = 3

/** Maximum message text length per Cloud API docs. */
const MAX_LEN = 4096

// ─── Cloud API webhook payload types (minimal, structural) ───────────────────

interface WaContact {
  wa_id: string
  profile: { name: string }
}

interface WaTextMessage {
  id: string
  from: string
  type: 'text'
  text: { body: string }
  context?: { id: string }
}

interface WaInteractiveButtonReply {
  id: string
  from: string
  type: 'interactive'
  interactive: {
    type: 'button_reply'
    button_reply: { id: string; title: string }
  }
}

interface WaInteractiveListReply {
  id: string
  from: string
  type: 'interactive'
  interactive: {
    type: 'list_reply'
    list_reply: { id: string; title: string }
  }
}

type WaMessage = WaTextMessage | WaInteractiveButtonReply | WaInteractiveListReply | { id: string; from: string; type: string }

interface WaValue {
  messaging_product: string
  contacts?: WaContact[]
  messages?: WaMessage[]
}

interface WaChange {
  value: WaValue
}

interface WaEntry {
  changes: WaChange[]
}

interface WaWebhookPayload {
  object: string
  entry: WaEntry[]
}

interface WaSendResponse {
  messages?: { id: string }[]
}

// ─── Capabilities declaration ─────────────────────────────────────────────────

const WA_CAPABILITIES: Capabilities = {
  // WhatsApp supports arbitrary emoji reactions (Cloud API v16+)
  reactions: 'any',
  // No thread/topic concept — task scope collapses to the 1:1 chat scope
  threads: false,
  // Buttons are supported but capped at 3; the adapter uses text-menu fallback for >3
  buttons: true,
  // No edit API — the host must re-post if it needs to update a message
  edit: false,
  // No pin API
  pin: false,
  // DMs are the primary mode; every scope IS a 1:1 chat (wa_id)
  dm: true,
  // Every inbound in a 1:1 chat is implicitly directed; no @-mention mechanic
  mentions: 'text',
  maxMessageLength: MAX_LEN,
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class WhatsAppMessagingAdapter implements MessagingAdapter {
  readonly platform = 'whatsapp'

  /** Set to the phone number id — closest analogue to a "bot user id". */
  private _botUserId: string | undefined
  private _token: string | undefined
  private _server: { stop(closeActiveConnections?: boolean): void } | undefined

  private onMessageHandler?: (m: IncomingMessage) => void
  private onActionHandler?: (a: IncomingAction) => void
  /** Reactions are not pushed inbound by the Cloud API webhook by default;
   *  the handler is registered for interface completeness but will rarely fire. */
  private onReactionHandler?: (r: IncomingReaction) => void

  /** Pending numbered-text-menu choices per scope (wa_id), so parseChoiceReply
   *  can resolve a free-text reply back into a Choice.id. */
  private readonly pendingChoices = new Map<string, Choice[]>()

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    this._token = token

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? ''
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? ''
    const port = Number(process.env.WHATSAPP_WEBHOOK_PORT ?? '8787')

    // Without the phone-number id every outbound POST hits `//messages` and fails.
    // Surface the misconfiguration loudly rather than silently no-op'ing sends.
    if (!phoneNumberId) {
      console.warn('knock-knock(whatsapp): WHATSAPP_PHONE_NUMBER_ID not set — outbound messages will fail.')
    }

    // botUserId is set to the phone number id — there is no separate "bot user"
    // concept in the WhatsApp Cloud API; the phone number IS the agent identity.
    this._botUserId = phoneNumberId

    // Capture references for use inside the Bun.serve handler (closures).
    const adapter = this

    this._server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url)

        // ── Webhook verification (GET) ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/webhook') {
          const mode = url.searchParams.get('hub.mode')
          const token = url.searchParams.get('hub.verify_token')
          const challenge = url.searchParams.get('hub.challenge')

          if (mode === 'subscribe' && token === verifyToken && challenge) {
            return new Response(challenge, { status: 200 })
          }
          return new Response('Forbidden', { status: 403 })
        }

        // ── Inbound event (POST) ────────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/webhook') {
          // Respond 200 immediately so Meta doesn't retry.
          const bodyText = await req.text()
          // Process asynchronously after responding.
          Promise.resolve().then(() => {
            try {
              adapter.handleWebhookPayload(JSON.parse(bodyText) as WaWebhookPayload)
            } catch {
              // Malformed payload — swallow; never crash the server.
            }
          })
          return new Response('OK', { status: 200 })
        }

        return new Response('Not Found', { status: 404 })
      },
    })
  }

  async disconnect(): Promise<void> {
    this._server?.stop(true)
    this._server = undefined
  }

  get botUserId(): string | undefined {
    return this._botUserId
  }

  /** Uses the phone number id as the label — there is no display-name API. */
  get botLabel(): string | undefined {
    return this._botUserId
  }

  capabilities(): Capabilities {
    return WA_CAPABILITIES
  }

  // ─── inbound ────────────────────────────────────────────────────────────────

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.onMessageHandler = handler
  }

  onAction(handler: (a: IncomingAction) => void): void {
    this.onActionHandler = handler
  }

  onReaction(handler: (r: IncomingReaction) => void): void {
    this.onReactionHandler = handler
  }

  /** Not reliably determinable without a persistent message store.
   *  Always returns false — the host's reply-as-mention heuristic will not fire. */
  async authoredByBot(_scope: ScopeId, _messageId: string): Promise<boolean> {
    return false
  }

  // ─── outbound ───────────────────────────────────────────────────────────────

  /**
   * Send a text message to a scope (wa_id).
   *
   * Button rendering rules:
   *  - opts.choices present AND choices.length <= 3 → interactive button message.
   *    Also stores pending for typed-reply resolution (belt-and-suspenders).
   *  - opts.choices present AND choices.length > 3  → plain text with a numbered
   *    menu appended via choiceMenuText(); stores pending so parseChoiceReply()
   *    can resolve the next text reply from that scope.
   *  - no choices → plain text message.
   */
  async send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    const trimmed = text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text

    let body: Record<string, unknown>

    if (opts?.choices && opts.choices.length > 0) {
      const choices = opts.choices

      if (choices.length <= WA_BUTTON_CAP) {
        // Native interactive button message (≤3 choices).
        body = {
          messaging_product: 'whatsapp',
          to: scope,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: trimmed },
            action: {
              buttons: choices.map(c => ({
                type: 'reply',
                reply: {
                  id: c.id,
                  // WhatsApp enforces a 20-char title limit.
                  title: c.label.slice(0, BUTTON_TITLE_MAX),
                },
              })),
            },
          },
        }
        // Also store pending so a typed reply (instead of a button tap) resolves.
        this.pendingChoices.set(scope, choices)
      } else {
        // Text-menu fallback for >3 choices: append numbered menu to the message.
        const menuText = trimmed + '\n' + choiceMenuText(choices)
        const menuTrimmed = menuText.length > MAX_LEN ? menuText.slice(0, MAX_LEN - 1) + '…' : menuText
        body = {
          messaging_product: 'whatsapp',
          to: scope,
          type: 'text',
          text: { body: menuTrimmed },
        }
        // Store pending so the next text reply from this scope resolves the choice.
        this.pendingChoices.set(scope, choices)
      }
    } else {
      body = {
        messaging_product: 'whatsapp',
        to: scope,
        type: 'text',
        text: { body: trimmed },
      }
    }

    const data = await this.graphPost<WaSendResponse>(`/${this._botUserId}/messages`, body)
    const msgId = data?.messages?.[0]?.id
    if (!msgId) return undefined
    return { id: msgId, scope }
  }

  /**
   * WhatsApp Cloud API does not support editing messages.
   * Always returns false so the host can re-post instead.
   */
  async edit(_ref: MessageRef, _text: string, _opts?: SendOpts): Promise<boolean> {
    // WhatsApp has no message-edit endpoint — degradation: caller must re-post.
    return false
  }

  /**
   * Send an emoji reaction to a message.
   * Uses mapGlyphToReaction since WhatsApp supports arbitrary emoji reactions.
   * An empty emoji string removes any existing reaction from that message.
   */
  async react(ref: MessageRef, glyph: Glyph): Promise<void> {
    const emoji = mapGlyphToReaction(glyph, WA_CAPABILITIES) ?? ''
    await this.graphPost(`/${this._botUserId}/messages`, {
      messaging_product: 'whatsapp',
      to: ref.scope,
      type: 'reaction',
      reaction: {
        message_id: ref.id,
        emoji,
      },
    }).catch(() => {})
  }

  /** Remove a reaction by sending an empty emoji for that message. */
  async unreact(ref: MessageRef, _glyph: Glyph): Promise<void> {
    // Sending reaction with empty emoji removes the existing reaction.
    await this.graphPost(`/${this._botUserId}/messages`, {
      messaging_product: 'whatsapp',
      to: ref.scope,
      type: 'reaction',
      reaction: {
        message_id: ref.id,
        emoji: '',
      },
    }).catch(() => {})
  }

  /** WhatsApp has no pin API — no-op. */
  async pin(_ref: MessageRef): Promise<void> {
    // no-op: WhatsApp Cloud API does not support pinning messages.
  }

  /**
   * Send a direct message to a WhatsApp user by wa_id.
   * On WhatsApp every 1:1 chat is already a DM by nature; this calls send()
   * with the userId as the scope.
   */
  async dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined> {
    return this.send(userId, text, opts)
  }

  /** WhatsApp Cloud API has no typing-indicator endpoint — no-op. */
  typing(_scope: ScopeId): void {
    // no-op: WhatsApp Cloud API does not provide a typing indicator.
  }

  // ─── structure ───────────────────────────────────────────────────────────────

  /**
   * WhatsApp has no thread/topic concept.
   * Always returns undefined; the host runs the task at the room (chat) scope.
   */
  async startThread(_ref: MessageRef, _name: string): Promise<ScopeId | undefined> {
    return undefined
  }

  /**
   * WhatsApp has no thread hierarchy — every scope IS its own room.
   * Always returns undefined.
   */
  async parentOf(_scope: ScopeId): Promise<ScopeId | undefined> {
    return undefined
  }

  /** No cache to probe — always returns undefined. */
  parentOfSync(_scope: ScopeId): ScopeId | undefined {
    return undefined
  }

  // ─── webhook payload handling ────────────────────────────────────────────────

  private handleWebhookPayload(payload: WaWebhookPayload): void {
    if (payload.object !== 'whatsapp_business_account') return

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value?.messages?.length) continue

        const contacts = value.contacts ?? []

        for (const rawMsg of value.messages) {
          const senderId = rawMsg.from

          // Resolve display name from the contacts array; fall back to wa_id.
          const contact = contacts.find(c => c.wa_id === senderId)
          const authorName = contact?.profile?.name ?? senderId

          if (rawMsg.type === 'text') {
            const msg = rawMsg as WaTextMessage
            const text = msg.text.body
            const scope = senderId
            const ref: MessageRef = { id: msg.id, scope }

            // ── Text-fallback resolution ──────────────────────────────────
            // If there are pending choices for this scope, check whether this
            // free-text reply resolves one of them (the user typed "1", "deny",
            // "take a", etc. instead of tapping a button).
            const pending = this.pendingChoices.get(scope)
            if (pending) {
              const choiceId = parseChoiceReply(text, pending)
              if (choiceId) {
                this.pendingChoices.delete(scope)
                const h = this.onActionHandler
                if (h) {
                  h(this.makeTextAction(choiceId, senderId, ref, text))
                }
                continue
              }
            }

            // ── Normal text message ───────────────────────────────────────
            const h = this.onMessageHandler
            if (!h) continue
            h({
              ref,
              scope,
              authorId: senderId,
              authorName,
              text,
              // Every inbound in a 1:1 WhatsApp chat is implicitly directed at
              // the bot — there is no concept of an unsolicited ambient message.
              mentionsBot: true,
              replyToMessageId: msg.context?.id,
              isThread: false,
              scopeLabel: authorName,
            })
          } else if (rawMsg.type === 'interactive') {
            // ── Button tap / list selection ───────────────────────────────
            const iMsg = rawMsg as WaInteractiveButtonReply | WaInteractiveListReply
            const scope = senderId
            let choiceId: string | undefined

            if (iMsg.interactive.type === 'button_reply') {
              choiceId = (iMsg as WaInteractiveButtonReply).interactive.button_reply.id
            } else if (iMsg.interactive.type === 'list_reply') {
              choiceId = (iMsg as WaInteractiveListReply).interactive.list_reply.id
            }

            if (!choiceId) continue

            // Clear pending choices for this scope since one was resolved.
            this.pendingChoices.delete(scope)

            const ref: MessageRef = { id: iMsg.id, scope }
            const h = this.onActionHandler
            if (!h) continue
            h(this.makeTextAction(choiceId, senderId, ref, ''))
          }
          // All other message types (image, audio, video, document, location, …)
          // are silently skipped for now — the skeleton handles text and interactive.
        }
      }
    }
  }

  /**
   * Build an IncomingAction for a resolved choice (button tap or text-fallback).
   *
   * respond(text) → sends a new message to scope (no ephemeral on WhatsApp).
   * update(text)  → WhatsApp has no edit API; sends a fresh message as degradation
   *                 (the prompt message is NOT removed — the user will see both).
   */
  private makeTextAction(
    choiceId: string,
    userId: string,
    ref: MessageRef,
    message: string,
  ): IncomingAction {
    const adapter = this
    return {
      actionId: choiceId,
      userId,
      ref,
      scope: ref.scope,
      message,
      respond: async (text, _opts) => {
        // opts.ephemeral is ignored — WhatsApp has no ephemeral messages.
        await adapter.send(ref.scope, text)
      },
      update: async (text, opts) => {
        // WhatsApp cannot edit messages — degrade to sending a new message.
        // The original prompt message remains visible; the follow-up verdict
        // arrives as a fresh message directly below it.
        await adapter.send(ref.scope, text, opts)
      },
    }
  }

  // ─── Graph API helper ────────────────────────────────────────────────────────

  /** POST JSON to the Meta Graph API; returns the parsed response or undefined. */
  private async graphPost<T>(path: string, body: unknown): Promise<T | undefined> {
    const token = this._token
    if (!token) return undefined

    try {
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        // Best-effort: swallow API errors so a single failed send never crashes
        // the relay. The caller handles undefined / false returns.
        return undefined
      }
      return (await res.json()) as T
    } catch {
      return undefined
    }
  }
}
