/**
 * ContextControl — the owner `!context` command surface for a thread's shared
 * context. View / add / remove the notes a thread's turns see, reusing the same
 * knowledge artifact session-sharing imports into
 * (`know:channel/<scopeId>/shared-context`) and the same once-per-turn delivery
 * path. Modeled on ChannelConfigControl: thin owner-gated adapter over ledger
 * admits; never writes a file.
 *
 * - `!context`            → list active notes (stable-numbered, oldest-first)
 * - `!context add <text>` → owner-role knowledge.append (wrapped, source owner-note)
 * - `!context remove <n>` → owner-role knowledge.invalidate of the n-th note
 *
 * The owner gate is the agent-host short-circuit that only routes a `!context`
 * here when senderKind==='owner', BEFORE any channel.message admit — so a
 * peer/human (or a prompt injection) can never curate context.
 */

import type { HostContext } from './context.ts'
import { admit } from '../ledger/admit.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import {
  KNOWLEDGE_FOLD,
  activeNotes,
  type KnowledgeFoldState,
  type StoredNote,
} from '../ledger/artifacts/knowledge.ts'
import { parseContextCommand, wrapSharedContext } from '../lib.ts'
import {
  renderContextList,
  renderContextHelp,
  renderContextAdded,
  renderContextRemoved,
  type ContextEntry,
} from '../ledger/render/surface.ts'

/** The shared-context artifact for a scope (same id session import writes). */
function contextArtifact(scopeId: ChannelId): string {
  return `know:channel/${scopeId}/shared-context`
}

export class ContextControl {
  constructor(private readonly ctx: HostContext) {}

  /** Active (non-stale) shared-context notes for a scope, oldest-first — the
   *  exact list `!context` numbers and `pendingContext` injects. */
  private notesFor(scopeId: ChannelId): StoredNote[] {
    try {
      const state = this.ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
      return activeNotes(state, contextArtifact(scopeId))
    } catch {
      return []
    }
  }

  /** Owner `!context …`. The caller (agent-host) has gated to senderKind==='owner'. */
  async handleCommand(scopeId: ChannelId, text: string): Promise<void> {
    const parsed = parseContextCommand(text)
    if (!parsed || parsed.action === 'help') {
      await this.ctx.discordSend(scopeId, renderContextHelp())
      return
    }
    if (parsed.action === 'error') {
      await this.ctx.discordSend(scopeId, parsed.message)
      return
    }

    if (parsed.action === 'list') {
      await this.ctx.discordSend(scopeId, renderContextList(this.notesFor(scopeId).map(toEntry)))
      return
    }

    const ownerId = this.ctx.getAccess().agents[this.ctx.key]?.ownerUserId
    if (!ownerId) {
      await this.ctx.discordSend(scopeId, 'No owner configured for this agent.')
      return
    }

    if (parsed.action === 'add') {
      // Wrap like an imported brief so it reads as reference-to-respect, not new
      // orders (the same prompt-injection framing). Owner-role append → the merge
      // gate is a no-op (anchor none) and on Postgres it syncs to peers.
      const body = wrapSharedContext({ source: 'owner-note', savedBy: ownerId }, parsed.text)
      await admit(this.ctx.store, {
        actor: ownerId,
        role: 'owner',
        channel: scopeId,
        target: { artifactId: contextArtifact(scopeId), anchor: { kind: 'none' } },
        verb: 'knowledge.append',
        patch: { kind: 'knowledge', append: { id: `note-${Date.now()}`, body, tags: ['owner-note'] } },
        effect: 'pure',
        caused_by: [],
      })
      await this.ctx.discordSend(scopeId, renderContextAdded())
      this.ctx.refreshConfigCard(scopeId)
      return
    }

    // remove <n>: map the 1-based index to the stable-sorted note hash, then
    // invalidate it (tombstone — activeNotes/pendingContext stop returning it).
    const notes = this.notesFor(scopeId)
    const target = notes[parsed.index - 1]
    if (!target) {
      await this.ctx.discordSend(scopeId, `No context note #${parsed.index}. Run \`!context\` to list them.`)
      return
    }
    await admit(this.ctx.store, {
      actor: ownerId,
      role: 'owner',
      channel: scopeId,
      target: { artifactId: contextArtifact(scopeId), anchor: { kind: 'none' } },
      verb: 'knowledge.invalidate',
      patch: { kind: 'knowledge', invalidate: { hash: target.hash } },
      effect: 'pure',
      caused_by: [target.hash],
    })
    // Echo the removed note's source + summary: numbering is by a stable sort, so
    // a concurrent add/import/peer-sync between the owner's `!context` list and
    // this remove could shift indices — showing what actually got removed lets the
    // owner catch a mis-hit immediately.
    await this.ctx.discordSend(scopeId, renderContextRemoved(parsed.index, toEntry(target)))
    this.ctx.refreshConfigCard(scopeId)
  }
}

/** A stored note → a renderable context entry: parse the provenance source out of
 *  the wrapped envelope and strip the envelope to a readable snippet. */
function toEntry(n: StoredNote): ContextEntry {
  const body = n.note.body
  const source = /source="([^"]+)"/.exec(body)?.[1] ?? n.note.tags?.[0] ?? 'note'
  const summary = body
    .split('\n')
    .filter(l => {
      const t = l.trim()
      if (!t) return false
      if (/^<\/?[a-z-]/i.test(t)) return false // xml-ish envelope tags
      // the standard framing sentences the wrappers prepend
      if (/^(Reference context|The objective|Your role)\b/i.test(t)) return false
      return true
    })
    .join(' ')
    .trim()
  return { source, summary: summary || '(context)', when: n.createdAt, by: n.actor }
}
