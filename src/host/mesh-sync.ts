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
  meshLineVerb,
  isMeshLine,
  MESH_VERB_ALLOWLIST,
  type AgentIdentity,
} from '../lib.ts'

/** How often a relay re-broadcasts its own identity to rooms with a remote peer, so a
 *  later-joining peer's directory converges even if it missed the connect beacon. Only
 *  fires once a remote peer is known, so a lone co-resident relay never heartbeats. */
export const MESH_IDENTITY_HEARTBEAT_MS = 4 * 60_000

/** How many recent channel messages reconcile-on-reconnect reads back. A const, not config
 *  (CLAUDE.md §3): the chat platform is the durable log, and a relay offline long enough to
 *  exceed ~200 coordination lines is past what a bounded replay should silently claim to
 *  cover — the warn-on-saturation log fires there, and Phase 2 backfill is the real proof. */
export const MESH_REPLAY_WINDOW = 200

/** Page back recent messages in a scope, OLDEST-first (createdAt rides in-band in each mesh
 *  line, so no separate timestamp). Deliberately NOT a `MessagingAdapter` method — the host
 *  duck-types it off the adapter and passes it here only when present, keeping that interface
 *  thin. Absent ⇒ replay is a no-op and the mesh behaves exactly as before (fire-and-forget). */
export type FetchRecent = (scope: string, limit: number) => Promise<{ authorId: string; text: string }[]>

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
  /** The dedicated transport room id to post ALL mesh lines to, or undefined ⇒ post to
   *  the human rooms as before. When set, beacons + coordination go here instead, so the
   *  human channels never see ⟦kk-mesh⟧ base64. */
  transportScope?: () => string | undefined
  /** Read recent channel history for reconnect replay. Optional — absent ⇒ no replay
   *  (today's fire-and-forget behavior; the change is purely additive). */
  fetchRecent?: FetchRecent
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

  // ─── Phase 0 instrumentation (miss classification) ───────────────────────────
  /** Publishes that failed while we were connected — a live drop the chat platform
   *  rejected/rate-limited, NOT an offline gap. If this dominates, replay won't help. */
  private onlineDrops = 0
  /** Ingested events whose `caused_by` referenced a hash we don't hold — the metric that
   *  tells you whether gaps survive Phase 1b, and Phase 2's backfill trigger signal. */
  private gapsDetected = 0

  constructor(private readonly deps: MeshSyncDeps) {}

  /** Begin publishing locally-authored coordination events. Call AFTER connect (so
   *  `send` works) — the bot's own `agent.identity` admit then broadcasts over the mesh. */
  start(): void {
    if (this.unsub) return
    this.dbg(
      `started (ownKey=${this.deps.ownKey}, rooms=[${this.deps.allRooms().join(', ')}], ` +
        `transport=${this.deps.transportScope?.() ?? '(none)'})`,
    )
    this.unsub = this.deps.store.subscribe(i => {
      if (i.actor !== this.deps.ownKey) return // publish only my own events (no echo)
      if (i.lifecycle !== 'applied' && i.lifecycle !== 'admitted') return
      // Identity is announced explicitly on connect (announceIdentity), NOT here: the
      // identity admit is content-addressed, so on reconnect it's idempotent and produces
      // no store insert — this subscriber would never fire for it, and the beacon would
      // never go out. Coordination events (coord.note/task.*) are new each time, so they
      // ride the subscriber fine.
      if (i.verb === 'agent.identity') return
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
   *  or invalid line). Returns true iff a valid event was NEWLY appended (false if it
   *  was dropped, unverifiable, foreign-channel, or already held — content-addressed,
   *  so a re-delivery is a no-op). The newly-appended signal is what `reconcileOnConnect`
   *  sums into its "ingested M new" count. */
  async ingest(text: string, senderUserId: string): Promise<boolean> {
    if (!isMeshLine(text)) return false
    const i = decodeMeshEvent(text, senderUserId, this.deps.directory())
    if (!i) {
      this.deps.log(`mesh: dropped an unverifiable coordination line from ${senderUserId}`)
      return false
    }
    // Phase 1a — scope isolation. A relay's ledger must only ever hold channels it serves.
    // Without this, a dedicated transport channel that multiplexes several projects' events
    // makes every relay fold every other project's coordination state (cross-channel
    // pollution), and history replay amplifies it from a trickle to a full flood. Identity
    // beacons (channel `agent-directory`) are exempt: they carry no turn and MUST always be
    // ingested so the directory converges and provenance for coordination verbs can resolve.
    if (i.channel !== 'agent-directory' && !this.deps.resolveRoom(i.channel)) {
      this.dbg(`dropped foreign-channel ${i.verb} for ${i.channel}`)
      return false
    }
    // Phase 0 — causal-gap detection. A `caused_by` parent we don't hold is an event we
    // missed; counting it is the empirical signal for whether gaps survive Phase 1b, and the
    // trigger Phase 2's backfill responder acts on. (Counter now; responder is Phase 2.)
    await this.detectGap(i)
    let inserted: boolean
    try {
      const r = await this.deps.store.append(i) // verbatim createdAt; content-addressed ⇒ idempotent
      inserted = r.inserted
    } catch (err) {
      this.deps.log(`mesh: ingest append failed: ${err}`)
      return false
    }
    this.dbg(`✓ ingested ${i.verb} from ${senderUserId} (actor=${i.actor}, new=${inserted})`)
    return inserted
  }

  /** Count + log any `caused_by` parent this relay does not hold locally. Pure metric in
   *  Phase 0; Phase 2 reuses the same missing-hash set to emit a backfill Want. */
  private async detectGap(i: Interaction): Promise<string[]> {
    if (i.caused_by.length === 0) return []
    const missing: string[] = []
    for (const parent of i.caused_by) {
      if (!(await this.deps.store.getByHash(parent))) missing.push(parent)
    }
    if (missing.length > 0) {
      this.gapsDetected += missing.length
      this.dbg(
        `gap-detected: ${i.verb} (${i.channel}) references ${missing.length} unheld parent(s) ` +
          `[${missing.map(h => h.slice(0, 8)).join(', ')}] (gaps=${this.gapsDetected})`,
      )
    }
    return missing
  }

  /** Reconnect replay: the chat channel is a durable, ordered log the platform retains while
   *  a bot is offline, so the offline gap is recoverable by reading it back and re-ingesting
   *  each ⟦kk-mesh⟧ line through the (scope-guarded, provenance-checked) `ingest()`. Idempotent
   *  append + (createdAt, hash) fold ordering make dup/reorder non-issues.
   *
   *  Identity-first two-pass: a coord/task line is dropped unless its actor is already in the
   *  directory, so every `agent.identity` beacon in the window is ingested BEFORE the lines
   *  that depend on it. The verb peek (`meshLineVerb`) only decides ORDER — `ingest()` re-runs
   *  the full trust gate (decode + scope + provenance), so the replay path is no weaker than
   *  the live path.
   *
   *  Trust parity note: the live mesh path (agent-host handleInbound) gates an inbound mesh
   *  line ONLY by `decodeMeshEvent` provenance — it ingests before the `guildSenderAllowed`
   *  check, which never runs for a mesh line. Replay routes through the same `ingest()`, so it
   *  applies the identical gate. We deliberately do NOT add a stricter sender allowlist here:
   *  it would reject a freshly-discovered peer's beacon (its author isn't a known participant
   *  until that very beacon lands), silently dropping that peer's coordination on replay — the
   *  exact divergence this method exists to prevent. The self-inflation vector is a pre-existing
   *  property of the live path (replay only re-ingests what online peers already accepted); its
   *  real fix is signed beacons (Phase 3), not an asymmetric replay gate.
   *
   *  Caller (host) suppresses the task scheduler for the duration and runs ONE settle pass on
   *  the converged ledger afterward, so a half-built board can't spuriously claim/drive tasks
   *  mid-replay (the "replay storm"; see plan Critical detail 3). */
  async reconcileOnConnect(): Promise<void> {
    const fetchRecent = this.deps.fetchRecent
    if (!fetchRecent) return // capability absent ⇒ no replay; behavior identical to before

    const t = this.deps.transportScope?.()
    const scopes = t ? [t] : this.deps.allRooms()
    for (const scope of scopes) {
      let fetched: { authorId: string; text: string }[]
      try {
        fetched = await fetchRecent(scope, MESH_REPLAY_WINDOW)
      } catch (err) {
        this.deps.log(`mesh: replay fetch for ${scope} failed: ${err}`)
        continue
      }
      const lines = fetched.filter(f => isMeshLine(f.text))
      const identities = lines.filter(l => meshLineVerb(l.text) === 'agent.identity')
      const rest = lines.filter(l => meshLineVerb(l.text) !== 'agent.identity')
      let ingested = 0
      for (const l of identities) if (await this.ingest(l.text, l.authorId)) ingested++ // pass 1
      for (const l of rest) if (await this.ingest(l.text, l.authorId)) ingested++ // pass 2

      const saturated = fetched.length >= MESH_REPLAY_WINDOW
      this.dbg(
        `replayed ${lines.length} mesh line(s) of ${fetched.length} fetched on ${scope}, ` +
          `ingested ${ingested} new, window-saturated=${saturated}`,
      )
      // A bounded replay must never report success without flagging it may have under-covered.
      if (saturated) {
        this.deps.log(
          `mesh: replay window on ${scope} saturated at ${MESH_REPLAY_WINDOW} messages — the ` +
            `offline gap may exceed the window; divergence possible until a peer re-broadcasts.`,
        )
      }
    }
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
    const t = this.deps.transportScope?.()
    if (t) return [t] // all transport rides the one dedicated room; ingest restores i.channel
    if (i.channel === 'agent-directory') return this.deps.allRooms()
    const room = this.deps.resolveRoom(i.channel)
    return room ? [room] : this.deps.allRooms()
  }

  /** Broadcast this bot's identity beacon to every room it serves — the bootstrap that lets
   *  two relays discover each other. Called explicitly on connect (after publishIdentity)
   *  rather than via the store subscriber, because the identity admit is content-addressed
   *  and idempotent: on every reconnect it produces no store insert, so the subscriber would
   *  never fire and the beacon would never go out (cross-machine discovery silently dies after
   *  the first run). Unconditional — there's no remote peer to gate on until this lands. */
  async announceIdentity(i: Interaction): Promise<void> {
    if (i.verb !== 'agent.identity') return
    const line = encodeMeshEvent(i)
    this.ownIdentityLine = line
    const t = this.deps.transportScope?.()
    const scopes = t ? [t] : this.deps.allRooms()
    this.dbg(`→ identity beacon to [${scopes.join(', ')}] (announce)`)
    for (const scope of scopes) await this.sendLine(scope, line)
  }

  private async publish(i: Interaction): Promise<void> {
    // Identity beacons are announced explicitly (announceIdentity); only coordination events
    // reach here, and only worth sending to rooms that have a remote peer. In a single
    // co-resident relay that set is always empty, so nothing is posted to the channel.
    const line = encodeMeshEvent(i)
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
    const t = this.deps.transportScope?.()
    const rooms = t ? [t] : this.deps.allRooms()
    for (const room of rooms) {
      if (this.hasRemotePeerInRoom(room)) await this.sendLine(room, this.ownIdentityLine)
    }
  }

  private async sendLine(scope: string, line: string): Promise<void> {
    try {
      const ref = await this.deps.send(scope, line)
      if (ref) this.deps.noteBotMsg(ref.id)
    } catch (err) {
      // Phase 0: a failed send while we're connected is an `online-drop` — the chat platform
      // rejected/rate-limited the line, so the peer never sees it AND replay-on-reconnect
      // can't recover it (replay only closes offline gaps). If this counter dominates,
      // Phase 2's frontier digest — not replay — is the real fix.
      this.onlineDrops++
      this.deps.log(`mesh: publish to ${scope} failed [online-drop #${this.onlineDrops}]: ${err}`)
    }
  }
}
