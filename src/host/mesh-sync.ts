/**
 * MeshSync — the no-Postgres cross-machine transport. The messaging channel every
 * bot already shares becomes the interaction bus, replacing Postgres LISTEN/NOTIFY.
 *
 * Each relay keeps its OWN local SQLite ledger. MeshSync:
 *   • publish — subscribes to local inserts and, for the COORDINATION verbs only
 *     (the strict `MESH_VERB_ALLOWLIST`), posts a compact encoded line to the room.
 *     Only LOCALLY-authored events are published (actor === this bot), so an ingested
 *     remote event never echoes back.
 *   • ingest — decodes a peer's coordination line and `store.append`s it VERBATIM
 *     (createdAt preserved — folds order by it; `append` not `admit`, which would
 *     re-stamp). Content-addressed ⇒ idempotent. The local synchronizer + folds then
 *     light up exactly as a NOTIFY delivery would have driven them.
 *
 * The trust boundary lives in `decodeMeshEvent` (lib.ts): only pure, agent-role,
 * allowlisted verbs cross, and the posting identity must own the `actor`. So an
 * ingested event can never alter permissions, escalate role, or impersonate a peer.
 *
 * Active only on the SQLite backend with mesh explicitly enabled; on Postgres the
 * atomic claim + NOTIFY are strictly better and MeshSync is never constructed.
 */

import type { Store } from '../ledger/store.ts'
import type { Interaction } from '../ledger/interaction.ts'
import type { MessageRef } from '../messaging-adapter.ts'
import {
  encodeMeshEvent,
  decodeMeshEvent,
  isMeshLine,
  MESH_VERB_ALLOWLIST,
  type AgentIdentity,
} from '../lib.ts'

export type MeshSyncDeps = {
  store: Store
  /** This host's single bot key — only its own events are published. */
  ownKey: string
  /** The live agent directory (for ingest provenance). */
  directory: () => AgentIdentity[]
  /** Resolve a scope (thread/channel) to its room; undefined ⇒ not a served room. */
  resolveRoom: (scope: string) => string | undefined
  /** Every room this bot serves (where identity broadcasts and unresolved scopes go). */
  allRooms: () => string[]
  /** Post a coordination line to a scope. */
  send: (scope: string, text: string) => Promise<MessageRef | undefined>
  /** Tag a posted message id as bot-authored (so it's never treated as inbound chat). */
  noteBotMsg: (id: string) => void
  log: (msg: string) => void
}

export class MeshSync {
  private unsub?: () => void

  constructor(private readonly deps: MeshSyncDeps) {}

  /** Begin publishing locally-authored coordination events. Call AFTER connect (so
   *  `send` works) — the bot's own `agent.identity` admit then broadcasts over the mesh. */
  start(): void {
    if (this.unsub) return
    this.unsub = this.deps.store.subscribe(i => {
      if (i.actor !== this.deps.ownKey) return // publish only my own events (no echo)
      if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
      if (!MESH_VERB_ALLOWLIST.includes(i.verb)) return
      void this.publish(i)
    })
  }

  stop(): void {
    this.unsub?.()
    this.unsub = undefined
  }

  /** Ingest a peer's coordination line into the local ledger (or ignore a non-mesh
   *  or invalid line). Returns true iff a valid event was appended/seen. */
  async ingest(text: string, senderUserId: string): Promise<boolean> {
    if (!isMeshLine(text)) return false
    const i = decodeMeshEvent(text, senderUserId, this.deps.directory())
    if (!i) {
      this.deps.log(`mesh: dropped an unverifiable coordination line from ${senderUserId}`)
      return false
    }
    try {
      await this.deps.store.append(i) // verbatim createdAt; content-addressed ⇒ idempotent
    } catch (err) {
      this.deps.log(`mesh: ingest append failed: ${err}`)
      return false
    }
    return true
  }

  /** Where to broadcast an event so every peer sees it. The transport scope and the
   *  event's logical `channel` are independent — ingest preserves the original channel,
   *  so posting to the parent room (not a thread) reaches all peers reliably. */
  private targetScopes(i: Interaction): string[] {
    if (i.channel === 'agent-directory') return this.deps.allRooms()
    const room = this.deps.resolveRoom(i.channel)
    return room ? [room] : this.deps.allRooms()
  }

  private async publish(i: Interaction): Promise<void> {
    const line = encodeMeshEvent(i)
    for (const scope of this.targetScopes(i)) {
      try {
        const ref = await this.deps.send(scope, line)
        if (ref) this.deps.noteBotMsg(ref.id)
      } catch (err) {
        this.deps.log(`mesh: publish to ${scope} failed: ${err}`)
      }
    }
  }
}
