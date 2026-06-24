// SessionSharing — owner-only import/resume of a local coding-agent session
// into a scope. Import admits an owner-role knowledge.append; resume delegates
// to the host's Driver lifecycle via `onResume`.

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
  private readonly cards = new Map<
    string,
    { sessions: SessionSummary[]; channelId: ChannelId; mode: 'import' | 'resume' }
  >()
  /** Per-scope note hashes already injected, so each brief is delivered once. */
  private readonly delivered = new Map<ChannelId, Set<Hash>>()

  constructor(
    private readonly ctx: HostContext,
    private readonly onResume: ResumeHandler,
  ) {}

  /** Does this action target one of our open session cards? */
  handles(action: IncomingAction): boolean {
    return action.actionId.startsWith('sess:')
  }

  /** Discover this agent's local sessions (workspace-filtered) and post the
   *  selection card; resume offers only runtime-compatible sessions. */
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

  /** Post the share/resume card with one numbered button per entry plus Cancel
   *  (or the empty-state); remember the offered set + mode against the message. */
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

  /** Resolve a share/resume button (owner-only): cancel, import-pick (admits an
   *  owner-role knowledge.append), or resume-pick (delegated to the Driver). */
  async handlePick(action: IncomingAction): Promise<void> {
    const card = this.cards.get(action.ref.id)
    if (!card) {
      await action.respond('This session menu is no longer open.', { ephemeral: true })
      return
    }
    // Owner-only by ownerUserId (not a delegated approver): identity-bound.
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

    // import: headless ledger verb; owner-gated above, read-only on the session.
    const result = await importSession(this.ctx.store, {
      runtime: summary.runtime,
      sessionId: summary.id,
      scopeId: card.channelId,
      ownerId,
      workspace: this.ctx.getAccess().agents[this.ctx.key]?.workspace,
      fallbackCwd: summary.cwd,
    }).catch(err => {
      this.ctx.ui.error(this.ctx.key, `session import: ${err}`)
      return { ok: false, reason: 'unreadable' } as const
    })
    if (!result.ok) {
      const msg =
        result.reason === 'outside-workspace'
          ? 'That session belongs to a different workspace — not importing it.'
          : 'Could not read that session anymore.'
      await action.respond(msg, { ephemeral: true })
      return
    }

    // Cross-relay bridge — SQLite-only; on Postgres the note syncs (skip to avoid double-deliver).
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

  /** Shared-context to inject on the next turn: active notes not yet delivered.
   *  Does NOT mark delivered — caller calls confirmDelivered after the turn. */
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

  /** Mark notes delivered (each injected once); called only AFTER a turn succeeds. */
  confirmDelivered(scopeId: ChannelId, freshHashes: readonly string[]): void {
    if (freshHashes.length === 0) return
    const delivered = this.delivered.get(scopeId) ?? new Set<Hash>()
    for (const h of freshHashes) delivered.add(h)
    this.delivered.set(scopeId, delivered)
  }
}
