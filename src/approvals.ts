/**
 * Approvals — messaging UX for ask-tier tool permission requests: posts Allow/Deny prompts and routes the actor's choice + ✅/❌ reactions to ledger admissions.
 * State is an in-memory map (message id / hash prefix → prompt) so a reaction/button can find its interaction; the adapter's handler awaits the verdict via the ledger subscription.
 */

import type { MessagingAdapter, IncomingAction, Choice } from './messaging-adapter.ts'
import type { AgentConfig } from './lib.ts'
import { approverForAgent } from './lib.ts'
import type { ChannelId, Hash } from './ledger/interaction.ts'
import type { Store } from './ledger/store.ts'
import { admit } from './ledger/admit.ts'

const HASH_PREFIX_LEN = 10
const RECENT_HASHES_CAP = 256

type PromptDelivery = { destination: 'dm' | 'channel'; reason?: string }

type PostedPrompt = {
  /** Full tool.requested hash. */
  hash: Hash
  /** The originating channel — looks up the approver and keys the per-channel audit. */
  originChannelId: ChannelId
  /** Where the prompt landed (DM channel id or origin channel id). */
  promptChannelId: string
  discordMessageId: string
  /** The prompt body as posted, so a ✅/❌ reaction can re-render it with the verdict line appended. */
  body: string
}

export class Approvals {
  /** messageId → posted prompt (for reaction lookup). */
  private readonly byMessageId = new Map<string, PostedPrompt>()
  /** hashPrefix → posted prompt (for button customId lookup). */
  private readonly byHashPrefix = new Map<string, PostedPrompt>()
  /** Rolling cap so dead messages don't leak memory. */
  private readonly recencyOrder: string[] = []

  constructor(
    private readonly messaging: MessagingAdapter,
    /** Re-read on each resolution so owner changes take effect without restart. */
    private readonly getAgent: () => AgentConfig,
    /** The shared ledger store; verdicts admit through admit() here. */
    private readonly store: Store,
    /** Operator console hook so the destination of each prompt is visible. */
    private readonly onDelivery?: (info: PromptDelivery) => void,
    /** Register the posted Allow/Deny prompt so a TEXT reply can resolve it where
     *  buttons/reactions are unavailable. Keyed by the scope it landed in + msg id. */
    private readonly onPrompt?: (scope: string, messageId: string, choices: Choice[]) => void,
    /** Clear a registered prompt once it resolves. */
    private readonly onPromptDone?: (scope: string, messageId: string) => void,
  ) {}

  /** Post a Discord prompt for the given tool.requested. The verdict is awaited elsewhere via the ledger subscription. */
  async postDiscord(opts: {
    channelId: ChannelId
    toolRequestedHash: Hash
    toolName: string
    input: unknown
  }): Promise<void> {
    const prefix = opts.toolRequestedHash.slice(0, HASH_PREFIX_LEN)

    const agent = this.getAgent()
    const approverId = approverForAgent(agent, opts.channelId)
    const preview = JSON.stringify(opts.input, null, 2)
    const shortPreview = preview.length > 280 ? preview.slice(0, 280) + '…' : preview
    const body = `🔐 Permission request: **${opts.toolName}**\n\`\`\`\n${shortPreview}\n\`\`\``

    const choices: Choice[] = [
      { id: `appr:allow:${prefix}`, label: 'Allow', glyph: '✅', style: 'primary' },
      { id: `appr:deny:${prefix}`, label: 'Deny', glyph: '❌', style: 'danger' },
    ]

    // Post the prompt in the task's own channel so it lives where the work is (not a DM).
    // `mentionUser` pings the approver so they're notified the moment it's posted; `mentionOnly`
    // whitelists ONLY them, so any `<@id>` in the input preview can't re-trigger a peer bot.
    // Anyone can see it; only the approver's click resolves it (enforced in resolve()/resolveReaction()).
    const ref = await this.messaging.send(opts.channelId, body, {
      choices,
      ...(approverId ? { mentionUser: approverId, mentionOnly: approverId } : {}),
    })
    if (!ref) {
      // Can't reach the channel — emit a `tool.denied` so the awaiter resolves.
      await this._emitVerdict(opts, 'system:approvals', 'deny', 'Cannot reach a channel for approval prompt.')
      return
    }

    const posted: PostedPrompt = {
      hash: opts.toolRequestedHash,
      originChannelId: opts.channelId,
      promptChannelId: ref.scope,
      discordMessageId: ref.id,
      body,
    }
    this._remember(posted, prefix)
    // Register for the text-reply fallback under the scope the prompt landed in.
    this.onPrompt?.(ref.scope, ref.id, choices)
    this.onDelivery?.({ destination: 'channel' })
  }

  async resolve(action: IncomingAction): Promise<void> {
    const m = /^appr:(allow|deny):(\w+)$/.exec(action.actionId)
    if (!m) return
    const [, behavior, prefix] = m
    const posted = this.byHashPrefix.get(prefix!)
    if (!posted) {
      await action.respond('Request no longer pending.', { ephemeral: true })
      return
    }

    const agent = this.getAgent()
    const approverId = approverForAgent(agent, posted.originChannelId)
    if (!approverId || action.userId !== approverId) {
      // Only the bot's owner/approver can decide. Warn the clicker (ephemeral); the owner
      // was already pinged on the prompt itself, so no re-ping here.
      await action.respond('⚠️ Only this bot’s owner can approve or deny this request.', { ephemeral: true })
      return
    }

    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await action.update(`${action.message}\n\n${label}`)

    await this._emitVerdict(
      { channelId: posted.originChannelId, toolRequestedHash: posted.hash },
      approverId,
      behavior as 'allow' | 'deny',
      behavior === 'allow' ? undefined : 'Denied by owner.',
    )
    this._forget(posted)
  }

  async resolveReaction(messageId: string, emoji: string, userId: string): Promise<void> {
    if (emoji !== '✅' && emoji !== '❌') return
    const posted = this.byMessageId.get(messageId)
    if (!posted) return
    const agent = this.getAgent()
    const approverId = approverForAgent(agent, posted.originChannelId)
    // Non-owner reaction: ignore silently — a reaction has no ephemeral reply channel to
    // surface a warning (unlike a button click, which warns in resolve()).
    if (!approverId || userId !== approverId) return

    const label = emoji === '✅' ? '✅ Allowed' : '❌ Denied'
    // Best-effort prompt edit; the ledger verdict below is the truth.
    await this.messaging
      .edit({ id: messageId, scope: posted.promptChannelId }, `${posted.body}\n\n${label}`)
      .catch(() => {})

    const behavior: 'allow' | 'deny' = emoji === '✅' ? 'allow' : 'deny'
    await this._emitVerdict(
      { channelId: posted.originChannelId, toolRequestedHash: posted.hash },
      approverId,
      behavior,
      behavior === 'allow' ? undefined : 'Denied by owner.',
    )
    this._forget(posted)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _remember(posted: PostedPrompt, prefix: string): void {
    this.byMessageId.set(posted.discordMessageId, posted)
    this.byHashPrefix.set(prefix, posted)
    this.recencyOrder.push(posted.discordMessageId)
    while (this.recencyOrder.length > RECENT_HASHES_CAP) {
      const old = this.recencyOrder.shift()
      if (old) {
        const p = this.byMessageId.get(old)
        if (p) {
          this.byMessageId.delete(old)
          this.byHashPrefix.delete(p.hash.slice(0, HASH_PREFIX_LEN))
        }
      }
    }
  }

  private _forget(posted: PostedPrompt): void {
    this.byMessageId.delete(posted.discordMessageId)
    this.byHashPrefix.delete(posted.hash.slice(0, HASH_PREFIX_LEN))
    this.onPromptDone?.(posted.promptChannelId, posted.discordMessageId)
  }

  private async _emitVerdict(
    opts: { channelId: ChannelId; toolRequestedHash: Hash },
    actor: string,
    behavior: 'allow' | 'deny',
    deniedReason: string | undefined,
  ): Promise<void> {
    await admit(this.store, {
      actor,
      role: 'owner',
      channel: opts.channelId,
      target: {
        artifactId: `extp:tool/${opts.toolRequestedHash}`,
        anchor: { kind: 'proxy', proxyId: opts.toolRequestedHash },
      },
      verb: behavior === 'allow' ? 'tool.approved' : 'tool.denied',
      patch: {
        kind: 'external',
        intent: {
          channel: 'tool',
          op: 'verdict',
          args: deniedReason ? { behavior, reason: deniedReason } : { behavior },
        },
      },
      effect: 'external',
      caused_by: [opts.toolRequestedHash],
    })
  }
}
