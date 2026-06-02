/**
 * The Interaction record — the only thing knock-knock persists.
 *
 * An Interaction is a content-addressed, append-only entry in the causal DAG.
 * Everything else — artifact versions, what an agent knows, a channel's view,
 * a concept's runtime state — is a fold (projection) over a slice of the
 * ledger. If anything in the running system needs state outside the log, the
 * design has failed rubric #1 (Replayability).
 *
 * Mutable bookkeeping (`lifecycle`, `supersedes`, `deniedReason`, `signature`,
 * `createdAt`) is deliberately NOT part of the content hash — the hash names
 * what the actor proposed, not what later happened to it. Lifecycle changes
 * journal themselves as their own Interactions, so the mutable columns are
 * recoverable by full re-fold.
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
  | { kind: 'crdt'; rgaPos: string }                // Yjs position id (Phase 2)
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
  // Artifact patches (Phase 2 onwards)
  | 'workspace.edit'
  | 'knowledge.append'
  | 'knowledge.invalidate'
  // External-proxy serialization (Phase 2)
  | 'external.claim'
  | 'external.release'
  | 'external.compensate'
  // Merge bookkeeping
  | 'merge.resolve'
  // Policy admissions journaled into the log so folds see them live
  | 'policy.classified'
  // Frontier control surfaced as reactions (§4.5): rewind the active frontier,
  // re-run a turn, or pin a named checkpoint. All are just interactions.
  | 'frontier.rewind'
  | 'turn.retry'
  | 'frontier.checkpoint'
  // Watches — the deferred-continuation primitive (docs/knock-knock-watches.md).
  // A turn that defers and is resumed by the world: arm a long-running command,
  // fire when its output gate matches, disarm when done/expired/canceled.
  // `watch.requested` is the held-ask anchor: an arm whose command classified
  // `ask`, awaiting the owner's verdict before `watch.armed` is admitted. The
  // watch fold ignores it (it keys only on armed/disarmed).
  | 'watch.requested'
  | 'watch.armed'
  | 'watch.fired'
  | 'watch.disarmed'

export type KnowledgeNote = { id: string; body: string; tags?: string[] }

export type Patch =
  /** Versionable: base64 Yjs update (Phase 2). */
  | { kind: 'versionable'; ops: string; baseSnapshot?: string }
  /** Knowledge: append or invalidate. */
  | {
      kind: 'knowledge'
      append?: KnowledgeNote
      invalidate?: { hash: Hash }
    }
  /** External-proxy: declared intent, optional later result, optional reverse pair.
   *  `channel` is the source surface: an internal proxy (`shell`/`http`/`tool`) or
   *  a messaging platform name (`discord`, `slack`, …, from
   *  `MessagingAdapter.platform`). `(string & {})` keeps the named values as
   *  autocomplete hints while admitting any platform key. */
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
  /** Pure marker (a causal pin like `turn.prompted` with no state change). */
  | { kind: 'none' }

/**
 * The mutable + immutable fields combined. Code paths producing one must
 * compute `hash` via `hashInteraction` and never set it by hand.
 */
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

/**
 * The set of fields that participate in the content hash. The shape `record()`
 * accepts — the caller supplies the causal chain and the patch; the ledger
 * fills in `hash`, `lifecycle`, `createdAt`, and (when signing) `signature`.
 */
export type ProposedInteraction = Pick<
  Interaction,
  'actor' | 'role' | 'channel' | 'target' | 'verb' | 'patch' | 'effect' | 'caused_by'
>

/** Role ranking used by the merge gate (Phase 2). Owner > human > agent. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, human: 2, agent: 1 }

/** The external-proxy artifact id for a Discord scope (a thread or channel).
 *  channel.message / turn.* / the post-on-reply claim all target this — one
 *  place so the `extp:discord/<scope>` scheme isn't spelled out across files. */
export function discordArtifact(scopeId: ChannelId): ArtifactId {
  return `extp:discord/${scopeId}`
}
