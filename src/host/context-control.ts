// ContextControl — owner `!context` surface (list/add/remove) over a thread's
// shared-context knowledge artifact. Owner-gated upstream; never writes a file.

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

/** The shared-context artifact for a scope. */
function contextArtifact(scopeId: ChannelId): string {
  return `know:channel/${scopeId}/shared-context`
}

export class ContextControl {
  constructor(private readonly ctx: HostContext) {}

  /** Active shared-context notes for a scope, oldest-first. */
  private notesFor(scopeId: ChannelId): StoredNote[] {
    try {
      const state = this.ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
      return activeNotes(state, contextArtifact(scopeId))
    } catch {
      return []
    }
  }

  /** Owner `!context …` — caller has gated to senderKind==='owner'. */
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
      // Wrap as reference-to-respect, not orders (prompt-injection framing).
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
      return
    }

    // remove <n>: map 1-based index to the stable-sorted note hash and invalidate it.
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
    // Echo what was removed so the owner can catch an index-shift mis-hit.
    await this.ctx.discordSend(scopeId, renderContextRemoved(parsed.index, toEntry(target)))
  }
}

/** A stored note → a renderable context entry (provenance + envelope-stripped snippet). */
function toEntry(n: StoredNote): ContextEntry {
  const body = n.note.body
  const source = /source="([^"]+)"/.exec(body)?.[1] ?? n.note.tags?.[0] ?? 'note'
  const summary = body
    .split('\n')
    .filter(l => {
      const t = l.trim()
      if (!t) return false
      if (/^<\/?[a-z-]/i.test(t)) return false // xml-ish envelope tags
      if (/^(Reference context|The objective|Your role)\b/i.test(t)) return false // framing sentences
      return true
    })
    .join(' ')
    .trim()
  return { source, summary: summary || '(context)', when: n.createdAt, by: n.actor }
}
