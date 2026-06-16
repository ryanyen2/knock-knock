/**
 * SessionSharing — owner-only import/resume of a local coding-agent session
 * into a scope (docs/session-sharing.md). Owns the selection-card bookkeeping
 * and the per-scope delivered-context set.
 *
 * Import distills the chosen on-disk transcript and admits an owner-role
 * knowledge.append to know:channel/<scopeId>/shared-context; the next turn in
 * that scope injects it once. Resume continues a live runtime session — that's
 * tied to the host's Driver/Session lifecycle, so it's delegated back via
 * `onResume`.
 */

import type { HostContext } from './context.ts'
import type { IncomingAction, Choice } from '../messaging-adapter.ts'
import type { ChannelId, Hash } from '../ledger/interaction.ts'
import { importSession } from '../sessions/import.ts'
import { pickFreshContext } from '../lib.ts'
import {
  KNOWLEDGE_FOLD,
  activeNotes,
  type KnowledgeFoldState,
} from '../ledger/artifacts/knowledge.ts'
import {
  listAllSessions,
  sessionRuntimeForAgent,
  type SessionSummary,
} from '../sessions/index.ts'
import {
  NUMBERS,
  renderSessionCard,
  renderSessionImported,
  renderSharedContextPost,
} from '../ledger/render/surface.ts'

/** Continue a live runtime session in a scope — bind the Driver + persist it. */
export type ResumeHandler = (
  action: IncomingAction,
  scopeId: ChannelId,
  summary: SessionSummary,
) => Promise<void>

export class SessionSharing {
  /** Share/resume card messageId → the offered sessions + mode, for resolution. */
  private readonly cards = new Map<
    string,
    { sessions: SessionSummary[]; channelId: ChannelId; mode: 'import' | 'resume' }
  >()
  /** Per-scope set of shared-context note hashes already injected into the live
   *  session, so each imported brief is delivered to the agent exactly once
   *  (re-derivable; resets on restart, which only re-shows context). */
  private readonly delivered = new Map<ChannelId, Set<Hash>>()

  constructor(
    private readonly ctx: HostContext,
    private readonly onResume: ResumeHandler,
  ) {}

  /** Does this action target one of our open session cards? */
  handles(action: IncomingAction): boolean {
    return action.actionId.startsWith('sess:')
  }

  /** Owner asked to share/resume a session: discover this agent's local sessions
   *  (workspace-filtered). For resume, keep only sessions whose runtime this
   *  agent can actually continue. Then post the selection card. */
  async offer(scopeId: ChannelId, mode: 'import' | 'resume'): Promise<void> {
    const liveAgent = this.ctx.getAccess().agents[this.ctx.key]
    if (!liveAgent) return
    let sessions = await listAllSessions(liveAgent.workspace, { limit: NUMBERS.length * 2 })
    if (mode === 'resume') {
      const compatible = sessionRuntimeForAgent(liveAgent.runtime)
      sessions = sessions.filter(s => s.runtime === compatible)
    }
    await this.postCard(scopeId, sessions.slice(0, NUMBERS.length), liveAgent.ownerUserId, mode)
  }

  /**
   * Post the share/resume card. With sessions, attaches one numbered button per
   * entry (sess:pick:<idx> for import, sess:resume:<idx> for resume) plus a
   * Cancel; empty posts the empty-state. The offered set + mode are remembered
   * against the message id.
   */
  private async postCard(
    scopeId: ChannelId,
    offered: SessionSummary[],
    ownerId: string | undefined,
    mode: 'import' | 'resume',
  ): Promise<string | undefined> {
    const text = renderSessionCard({
      ownerId,
      mode,
      sessions: offered.map(s => ({
        runtime: s.runtime,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
      })),
    })
    if (offered.length === 0) {
      const ref = await this.ctx.messaging.send(scopeId, text)
      if (ref) this.ctx.noteBotMsg(ref.id)
      return ref?.id
    }
    // The numbered picks (up to 5 = NUMBERS.length) + a trailing Cancel become
    // the choice list; the adapter packs them into rows of 5, reproducing the
    // original "picks in one row, Cancel below" layout exactly.
    const action = mode === 'resume' ? 'resume' : 'pick'
    const choices: Choice[] = offered.map((_, idx) => ({
      id: `sess:${action}:${idx}`,
      label: `${idx + 1}`,
      glyph: NUMBERS[idx]!,
      style: 'neutral',
    }))
    choices.push({ id: 'sess:cancel', label: 'Cancel', style: 'neutral' })
    const ref = await this.ctx.messaging.send(scopeId, text, { choices })
    if (!ref) return undefined
    this.cards.set(ref.id, { sessions: offered, channelId: scopeId, mode })
    this.ctx.noteBotMsg(ref.id)
    return ref.id
  }

  /**
   * Resolve a share/resume button: owner-only. Cancel closes the card. An
   * 'import' pick reads + distills the session and admits an owner-role
   * knowledge.append to know:channel/<scopeId>/shared-context (anchor:none → no
   * conflict card); the next turn in that scope injects it and on Postgres it
   * syncs to peers. A 'resume' pick is delegated to the host's Driver binding.
   */
  async handlePick(action: IncomingAction): Promise<void> {
    const card = this.cards.get(action.ref.id)
    if (!card) {
      await action.respond('This session menu is no longer open.', { ephemeral: true })
      return
    }
    // Owner-only, by ownerUserId (not a delegated room approver): sharing/resuming
    // your own local session is identity-bound, matching the trigger gate.
    const ownerId = this.ctx.getAccess().agents[this.ctx.key]?.ownerUserId
    if (!ownerId || action.userId !== ownerId) {
      await action.respond('Only the owner can share or resume a session.', { ephemeral: true })
      return
    }

    if (action.actionId === 'sess:cancel') {
      this.cards.delete(action.ref.id)
      await action.update(`${action.message}\n\n-# ✖️ cancelled`)
      return
    }

    const m = /^sess:(pick|resume):(\d+)$/.exec(action.actionId)
    if (!m) return
    const summary = card.sessions[Number(m[2])]
    if (!summary) return

    if (card.mode === 'resume') {
      this.cards.delete(action.ref.id)
      await this.onResume(action, card.channelId, summary)
      return
    }

    // import: read + distill the on-disk transcript and admit it as shared
    // context. This is now a headless ledger verb (sessions/import.ts) — the
    // owner gate above is the identity boundary it trusts. File-based read is
    // robust; nothing in the live session is mutated.
    const result = await importSession(this.ctx.store, {
      runtime: summary.runtime,
      sessionId: summary.id,
      scopeId: card.channelId,
      ownerId,
      fallbackCwd: summary.cwd,
    }).catch(err => {
      this.ctx.ui.error(this.ctx.key, `session import: ${err}`)
      return { ok: false, reason: 'unreadable' } as const
    })
    if (!result.ok) {
      await action.respond('Could not read that session anymore.', { ephemeral: true })
      return
    }

    // Cross-relay bridge — only needed on SQLite, where a teammate's SEPARATE
    // ledger never receives the knowledge note. On Postgres the note syncs to
    // peers automatically, so posting it to Discord too would double-deliver;
    // skip it there. (Same-relay peers always get it silently via pendingContext.)
    if (this.ctx.store.kind === 'sqlite') {
      const roomId = this.ctx.roomForScope(card.channelId)
      const room = roomId ? this.ctx.getAccess().agents[this.ctx.key]?.rooms[roomId] : undefined
      const peerMentions = room ? Object.keys(room.participants).map(id => `<@${id}>`) : []
      await this.ctx.discordSend(
        card.channelId,
        renderSharedContextPost({ runtime: summary.runtime, title: summary.title, brief: result.brief, peerMentions }),
      ).catch(err => this.ctx.ui.error(this.ctx.key, `shared-context post: ${err}`))
    }

    this.cards.delete(action.ref.id)
    this.ctx.ui.note(
      this.ctx.key,
      `imported ${summary.runtime} session ${summary.id.slice(0, 8)} into ${card.channelId}`,
    )
    await action.update(renderSessionImported({ runtime: summary.runtime, title: summary.title }))
  }

  /**
   * Shared-context to inject on the next turn in a scope: active
   * know:channel/<scopeId>/shared-context notes not yet delivered to this host's
   * live session. Each note's body is already the wrapped <shared-context>
   * block. Does NOT mark anything delivered — the caller must call
   * `confirmDelivered(scopeId, freshHashes)` only after the turn actually
   * consumed the prefix, so a failed/stopped turn re-offers it next time.
   */
  pendingContext(scopeId: ChannelId): { prefix?: string; freshHashes: string[] } {
    let state: KnowledgeFoldState
    try {
      state = this.ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
    } catch {
      return { freshHashes: [] } // knowledge fold not registered
    }
    const notes = activeNotes(state, `know:channel/${scopeId}/shared-context`)
    const delivered = this.delivered.get(scopeId) ?? new Set<Hash>()
    return pickFreshContext(
      notes.map(n => ({ hash: n.hash, body: n.note.body })),
      delivered,
    )
  }

  /**
   * Mark imported-context notes as delivered to this scope's live session, so
   * each is injected exactly once. Called by the host AFTER a turn succeeds —
   * confirmed delivery, not optimistic: a turn that throws or is stopped leaves
   * the context undelivered so the next turn re-injects it.
   */
  confirmDelivered(scopeId: ChannelId, freshHashes: readonly string[]): void {
    if (freshHashes.length === 0) return
    const delivered = this.delivered.get(scopeId) ?? new Set<Hash>()
    for (const h of freshHashes) delivered.add(h)
    this.delivered.set(scopeId, delivered)
  }
}
