/**
 * The Store interface — the only thing the rest of the ledger talks to.
 *
 * Phase 0 ships one implementation (bun:sqlite, single-machine). Phase 4 adds
 * a Postgres implementation that satisfies the same contract. Folds, the
 * merge gate, the synchronizer — none of them should ever know which backing
 * store they're using.
 */

import type { Interaction, Hash, ChannelId, ArtifactId, Verb, Lifecycle } from './interaction.ts'

export interface Store {
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

  /** Lifecycle mutation (Phase 2 merge gate). */
  updateLifecycle(
    hash: Hash,
    lifecycle: Lifecycle,
    extra?: { supersedes?: Hash[]; deniedReason?: string },
  ): Promise<void>

  /** Bidirectional BFS for the role-ordered merge concurrency check (Phase 2). */
  isAncestor(maybeAncestor: Hash, of: Hash, maxDepth?: number): Promise<boolean>

  /** Per-channel frontier (direct heads with no admitted children). */
  channelFrontier(channelId: ChannelId): Promise<Hash[]>

  /** In-process fanout for fold subscribers and the synchronizer. */
  subscribe(cb: (i: Interaction) => void): () => void

  /** Last assigned seq — for paging cursors. */
  maxSeq(): Promise<number>

  close(): void
}

/** Convenience: the row shape a Store implementation marshals. */
export type StoredSeq = { seq: number; interaction: Interaction }
