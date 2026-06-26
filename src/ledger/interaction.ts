/**
 * The Interaction record — the only thing knock-knock persists: a
 * content-addressed, append-only entry in the causal DAG. Mutable bookkeeping
 * is NOT in the content hash; the hash names what the actor proposed.
 */

export type Hash = string             // sha-256 hex, 64 chars
export type ActorId = string          // Discord user id for humans/owners; agent key for agents
export type ChannelId = string        // Discord channel id, or `dm:<userId>` for owner DMs
export type ArtifactId = string       // `vers:<scope>/<key>` | `know:<scope>/<key>` | `extp:<scope>/<key>`

export type Role = 'owner' | 'human' | 'agent'
export type Effect = 'pure' | 'workspace' | 'external'
export type Lifecycle = 'proposed' | 'admitted' | 'applied' | 'superseded' | 'denied'

export type Anchor =
  | { kind: 'none' }
  | { kind: 'range'; from: number; to: number }     // versionable byte range
  | { kind: 'crdt'; rgaPos: string }                // Yjs position id
  | { kind: 'key'; path: string }                   // knowledge note id
  | { kind: 'proxy'; proxyId: string }              // external-proxy slot

export type Verb =
  // Transport — Discord ↔ ledger
  | 'channel.message'
  | 'turn.prompted'
  | 'turn.replied'
  // Tool lifecycle
  | 'tool.requested'
  | 'tool.classified'
  | 'tool.approved'
  | 'tool.denied'
  | 'tool.executed'
  // Artifact patches
  | 'workspace.edit'
  | 'knowledge.append'
  | 'knowledge.invalidate'
  // File exchange — inbound attachment materialized into the workspace; outbound file shared back
  | 'file.received'
  | 'file.shared'
  // External-proxy serialization
  | 'external.claim'
  | 'external.release'
  | 'external.compensate'
  // Merge bookkeeping
  | 'merge.resolve'
  // Policy admissions journaled so folds see them live
  | 'policy.classified'
  // Per-channel config overlay (owner edit; anchor `none` so the merge gate is a no-op)
  | 'config.set'
  // Multi-agent coordination board: presence + responder designation (anchor `none`)
  | 'coord.note'
  // Bot self-identity published to the shared directory on connect (anchor `none`):
  // agentKey → platform user id + label + rooms, so peers can discover/address each other.
  | 'agent.identity'
  // Decentralized task allocation (DAG): create / bid / claim / complete (anchor `none`)
  | 'task.created'
  | 'task.bid'
  | 'task.claimed'
  | 'task.completed'
  // Frontier control surfaced as reactions
  | 'frontier.rewind'
  | 'turn.retry'
  | 'frontier.checkpoint'
  // Watches — deferred-continuation primitive. `watch.requested` is the held-ask
  // anchor (arm classified `ask`); the watch fold keys only on armed/disarmed.
  | 'watch.requested'
  | 'watch.armed'
  | 'watch.fired'
  | 'watch.disarmed'

export type KnowledgeNote = { id: string; body: string; tags?: string[] }

/** A coordination-board note (Problem B). `presence` records what an agent is
 *  doing right now; `designation` records that an agent has taken a message. */
export type CoordNote = {
  type: 'presence' | 'designation'
  agentKey: string
  /** presence: the agent's current activity state. */
  status?: 'working' | 'done' | 'failed' | 'stopped'
  /** short human-readable label (task/turn summary, or the message being answered). */
  label?: string
  /** correlation id — the platform message id (designation) or a turn ref (presence). */
  ref?: string
}

/** A bot's self-published platform identity (the `agent.identity` patch). The relay
 *  stamps `agentKey`/`userId` from its OWN resolved identity, so a bot can only publish
 *  itself. Folded into a per-room peer directory so co-resident AND cross-machine bots
 *  discover and address each other without manual roster entries. */
export type AgentIdentity = {
  agentKey: string
  platform: string
  /** This bot's platform user id (e.g. Discord user id), resolved on connect. */
  userId: string
  /** Human-readable account label, for the roster line. */
  label?: string
  /** One-line capability blurb, for the roster line. */
  blurb?: string
  /** Channel ids this bot is a member of (so the directory is scoped per room). */
  rooms: string[]
}

/** Payload for the task.* verbs (decentralized allocation DAG). The verb is the
 *  discriminator; each verb reads the fields it needs. */
export type TaskPatchData = {
  id: string
  /** created: human-readable label. */
  label?: string
  /** created: ids this task waits on (the DAG edges). */
  dependsOn?: string[]
  /** created: push-target agent (orchestrator-worker); absent ⇒ open for pull/bid. */
  assignee?: string
  /** claimed: the agent that took the task. */
  owner?: string
  /** bid: the bidding agent + its self-rated utility. */
  bidder?: string
  utility?: number
}

/** Normalized, path-free edit intent on a versionable patch, read by AOCM's
 *  interference test. `edit` replaces the first `oldString`; `write` the whole file. */
export type VersionableIntent =
  | { kind: 'write'; content: string }
  | { kind: 'edit'; oldString: string; newString: string }

export type Patch =
  /** Versionable: base64 Yjs update + normalized edit intent for AOCM's interference test. */
  | { kind: 'versionable'; ops: string; baseSnapshot?: string; intent?: VersionableIntent }
  /** Knowledge: append or invalidate. */
  | {
      kind: 'knowledge'
      append?: KnowledgeNote
      invalidate?: { hash: Hash }
    }
  /** External-proxy: declared intent, optional result, optional reverse pair.
   *  `channel` is the source surface; `(string & {})` admits any platform key. */
  | {
      kind: 'external'
      intent: {
        channel: 'discord' | 'shell' | 'http' | 'tool' | (string & {})
        op: string
        args: unknown
      }
      result?: { ok: true; ref: string } | { ok: false; error: string }
      compensates?: Hash
    }
  /** Coordination board note (presence / responder designation). */
  | { kind: 'coord'; note: CoordNote }
  /** Bot self-identity published to the shared agent directory. */
  | { kind: 'identity'; data: AgentIdentity }
  /** Task-DAG op (create / bid / claim / complete); the verb is the discriminator. */
  | { kind: 'task'; data: TaskPatchData }
  /** Pure marker (a causal pin like `turn.prompted` with no state change). */
  | { kind: 'none' }

/** Mutable + immutable fields combined. Compute `hash` via `hashInteraction`, never by hand. */
export interface Interaction {
  hash: Hash
  actor: ActorId
  /** SNAPSHOT at admission time, not a live lookup. Replay-deterministic. */
  role: Role
  channel: ChannelId
  target: { artifactId: ArtifactId; anchor: Anchor }
  verb: Verb
  patch: Patch
  effect: Effect
  /** Direct DAG parents — sorted ascending, deduped. */
  caused_by: Hash[]

  // ─── Mutable bookkeeping (NOT in hash input) ──────────────────────────────
  lifecycle: Lifecycle
  supersedes?: Hash[]
  deniedReason?: string
  /** Ed25519 detached signature in base64. Added at append time. */
  signature?: string
  /** ISO timestamp, not in hash input. */
  createdAt: string
}

/** The fields that participate in the content hash — the shape `record()` accepts. */
export type ProposedInteraction = Pick<
  Interaction,
  'actor' | 'role' | 'channel' | 'target' | 'verb' | 'patch' | 'effect' | 'caused_by'
>

/** Role ranking used by the merge gate. Owner > human > agent. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, human: 2, agent: 1 }

/** The external-proxy artifact id for a Discord scope (thread or channel). */
export function discordArtifact(scopeId: ChannelId): ArtifactId {
  return `extp:discord/${scopeId}`
}
