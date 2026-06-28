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
 * Co-resident is NOT mesh's job. Two bots in one relay share one ledger, so they
 * already coordinate through it — broadcasting base64 to the human channel would be
 * pure noise. So coordination events (coord.note / task.*) are published to a room
 * ONLY when that room has a genuine REMOTE peer (a directory bot this relay does not
 * host). Identity beacons are the one exception: they must go out unconditionally on
 * connect so two relays can discover each other (bootstrap), then a slow heartbeat
 * keeps the directory fresh — but only once a remote peer is actually known, so a
 * single co-resident relay falls silent after its initial beacon.
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

/** How often a relay re-broadcasts its own identity to rooms with a remote peer, so a
 *  later-joining peer's directory converges even if it missed the connect beacon. Only
 *  fires once a remote peer is known, so a lone co-resident relay never heartbeats. */
export const MESH_IDENTITY_HEARTBEAT_MS = 4 * 60_000

export type MeshSyncDeps = {
  store: Store
  /** This host's single bot key — only its own events are published. */
  ownKey: string
  /** The live agent directory (for ingest provenance + remote-peer detection). */
  directory: () => AgentIdentity[]
  /** Bot keys hosted by THIS relay (co-resident siblings, incl. self). A directory
   *  identity outside this set is a genuine remote peer worth broadcasting to. */
  coResidentKeys: () => ReadonlySet<string>
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
  private heartbeat?: ReturnType<typeof setInterval>
  /** The last identity line this bot published — re-sent by the heartbeat. */
  private ownIdentityLine?: string

  constructor(private readonly deps: MeshSyncDeps) {}

  /** Begin publishing locally-authored coordination events. Call AFTER connect (so
   *  `send` works) — the bot's own `agent.identity` admit then broadcasts over the mesh. */
  start(): void {
    if (this.unsub) return
    this.dbg(`started (ownKey=${this.deps.ownKey}, rooms=[${this.deps.allRooms().join(', ')}])`)
    this.unsub = this.deps.store.subscribe(i => {
      if (i.actor !== this.deps.ownKey) return // publish only my own events (no echo)
      if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
      if (!MESH_VERB_ALLOWLIST.includes(i.verb)) return
      void this.publish(i)
    })
    this.heartbeat = setInterval(() => void this.pulse(), MESH_IDENTITY_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  stop(): void {
    this.unsub?.()
    this.unsub = undefined
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
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
    this.dbg(`✓ ingested ${i.verb} from ${senderUserId} (actor=${i.actor})`)
    return true
  }

  /** Verbose mesh tracing, gated on KNOCK_KNOCK_DEBUG. Routed through the host UI (deps.log)
   *  so it lands alongside the rest of the relay's output where the operator can see it. */
  private dbg(msg: string): void {
    if (process.env.KNOCK_KNOCK_DEBUG === '1') this.deps.log(`mesh: ${msg}`)
  }

  /** Does `room` contain a directory bot this relay does NOT host (a remote peer)?
   *  When false, broadcasting coordination to that room is noise — co-resident bots
   *  already share the ledger. */
  private hasRemotePeerInRoom(room: string): boolean {
    const local = this.deps.coResidentKeys()
    return this.deps.directory().some(
      id => !!id.userId && id.rooms.includes(room) && !local.has(id.agentKey),
    )
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
    // Identity beacon: cache for the heartbeat and broadcast unconditionally (this is
    // how two relays first discover each other — there's no remote peer to gate on yet).
    if (i.verb === 'agent.identity') {
      this.ownIdentityLine = line
      const scopes = this.targetScopes(i)
      this.dbg(`→ identity beacon to [${scopes.join(', ')}]`)
      for (const scope of scopes) await this.sendLine(scope, line)
      return
    }
    // Coordination event: only worth sending to rooms that have a remote peer. In a
    // single co-resident relay this is always empty, so nothing is posted to the channel.
    for (const scope of this.targetScopes(i)) {
      if (this.hasRemotePeerInRoom(scope)) {
        this.dbg(`→ ${i.verb} to ${scope}`)
        await this.sendLine(scope, line)
      } else {
        this.dbg(`skip ${i.verb} to ${scope} (no remote peer known in this room yet)`)
      }
    }
  }

  /** Heartbeat: keep remote peers' directories fresh by re-broadcasting our identity to
   *  rooms that have a remote peer. Silent when no remote peer is known (lone relay). */
  private async pulse(): Promise<void> {
    if (!this.ownIdentityLine) return
    for (const room of this.deps.allRooms()) {
      if (this.hasRemotePeerInRoom(room)) await this.sendLine(room, this.ownIdentityLine)
    }
  }

  private async sendLine(scope: string, line: string): Promise<void> {
    try {
      const ref = await this.deps.send(scope, line)
      if (ref) this.deps.noteBotMsg(ref.id)
    } catch (err) {
      this.deps.log(`mesh: publish to ${scope} failed: ${err}`)
    }
  }
}
