/**
 * Approvals — messaging UX for ask-tier tool permission requests.
 *
 * Phase 3 collapses this service to its UX role: it posts prompts via the
 * MessagingAdapter (Allow/Deny choices), routes the actor's choice + ✅/❌
 * reactions to ledger admissions. The Promise-resolving `pending: Map` from
 * Phase 0 is gone — the adapter's permission handler now waits via
 * `await-verdict.ts`, which subscribes to the store and resolves on any
 * admitted tool.approved/tool.denied caused_by the tool.requested hash.
 *
 * Only state held here is an in-memory map keyed by message id / hash prefix
 * so a ✅/❌ reaction or button can find the interaction the prompt was for.
 * The map IS recoverable from the ledger (an `approval.posted` verb in Phase
 * 3.1 would journal it), but for Phase 3 we keep it in-process.
 *
 * The choice id embeds a 10-char prefix of the tool.requested hash — platforms
 * cap interactive-component ids (Discord 100 chars) and `appr:allow:<10-hex>`
 * fits with room to spare. Cross-host approval flow (Phase 4) resolves the full
 * hash via fold lookup over the approval concept.
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
  /** The originating channel — used to look up the approver and to set the
   *  channel on admitted tool.approved/denied so the audit is per-channel. */
  originChannelId: ChannelId
  /** Where the prompt landed (DM channel id or origin channel id). */
  promptChannelId: string
  discordMessageId: string
  /** The prompt body as posted, so a ✅/❌ reaction can re-render it with the
   *  verdict line appended (the old reaction path refetched the message to do
   *  the same; we keep the text in-process instead of fetching it back). */
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
  ) {}

  /**
   * Post a Discord prompt for the given tool.requested. Returns void —
   * the caller doesn't wait on this. The await for the verdict happens via
   * `awaitVerdict` (ledger subscription) elsewhere.
   */
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

    // DM the approver first; fall back to the origin channel (with the approver
    // pinged) if a DM is impossible — preserving the old _resolveTarget semantics.
    let destination: 'dm' | 'channel' | undefined
    let reason: string | undefined
    let ref = approverId ? await this.messaging.dm(approverId, body, { choices }) : undefined
    if (ref) {
      destination = 'dm'
    } else {
      if (approverId) reason = 'DM unavailable'
      ref = await this.messaging.send(opts.channelId, body, { choices, mentionUser: approverId })
      if (ref) destination = 'channel'
    }

    if (!ref || !destination) {
      // Can't reach a channel — emit a `tool.denied` so the awaiter resolves.
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
    this.onDelivery?.({ destination, reason })
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
      await action.respond('Not authorized.', { ephemeral: true })
      return
    }

    // Update the prompt message to reflect the decision.
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
    if (!approverId || userId !== approverId) return

    const label = emoji === '✅' ? '✅ Allowed' : '❌ Denied'
    // Edit the prompt to append the verdict and drop its controls — the same
    // `${body}\n\n${label}` the old reaction path produced by refetching the
    // message (best-effort; the ledger verdict below is the truth).
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
