/**
 * The Store interface — the only thing the rest of the ledger talks to.
 * SQLite and Postgres implementations satisfy the same contract.
 */

import type { Interaction, Hash, ChannelId, ArtifactId, Verb, Lifecycle } from './interaction.ts'

export interface Store {
  /** Which backend this is, for the rare cross-machine-only branch. */
  readonly kind: 'sqlite' | 'postgres'

  /** Append a fully-formed Interaction. Idempotent on hash collision. */
  append(i: Interaction): Promise<{ inserted: boolean }>

  getByHash(hash: Hash): Promise<Interaction | undefined>

  /** Most-recent admitted/applied Interaction in a channel (for caused_by parents). */
  latestInChannel(channelId: ChannelId): Promise<Interaction | undefined>

  listByChannel(channelId: ChannelId, sinceSeq?: number): Promise<Interaction[]>
  listByArtifact(artifactId: ArtifactId, sinceSeq?: number): Promise<Interaction[]>
  listByVerb(verb: Verb, sinceSeq?: number): Promise<Interaction[]>
  /** All interactions since a sequence number, oldest first. Used by folds. */
  listAllSince(sinceSeq: number, limit?: number): Promise<Interaction[]>

  /** Lifecycle mutation (merge gate). */
  updateLifecycle(
    hash: Hash,
    lifecycle: Lifecycle,
    extra?: { supersedes?: Hash[]; deniedReason?: string },
  ): Promise<void>

  /** Ancestry check for the role-ordered merge concurrency test. */
  isAncestor(maybeAncestor: Hash, of: Hash, maxDepth?: number): Promise<boolean>

  /** Per-channel frontier (direct heads with no admitted children). */
  channelFrontier(channelId: ChannelId): Promise<Hash[]>

  /** In-process fanout for fold subscribers and the synchronizer. */
  subscribe(cb: (i: Interaction) => void): () => void

  /** In-process fanout on lifecycle change; `updateLifecycle` awaits these.
   *  Local-only — the Postgres NOTIFY trigger fires on INSERT, not UPDATE. */
  subscribeLifecycle(
    cb: (hash: Hash, lifecycle: Lifecycle) => void | Promise<void>,
  ): () => void

  /** Last assigned seq — for paging cursors. */
  maxSeq(): Promise<number>

  // ─── External-proxy Claim primitive ────────────────────────────
  // Serializes side effects against an external system; the claim is the floor.

  /** Acquire `artifactId` for `holderHash` for `ttlMs`. Renewed if same holder,
   *  replaced if expired, refused (current holder returned) if held live. */
  acquireClaim(
    artifactId: ArtifactId,
    holderHash: Hash,
    ttlMs: number,
  ): Promise<{ acquired: boolean; currentHolder?: Hash }>

  /** Release the claim if `holderHash` is the current holder. */
  releaseClaim(artifactId: ArtifactId, holderHash: Hash): Promise<{ released: boolean }>

  /** Current claim if one exists and hasn't expired. */
  getClaim(artifactId: ArtifactId): Promise<{ holder: Hash; expiresAt: Date } | undefined>

  close(): void
}

/** Convenience: the row shape a Store implementation marshals. */
export type StoredSeq = { seq: number; interaction: Interaction }
