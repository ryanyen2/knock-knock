/**
 * Ledger — the writer surface used by everything outside the ledger package.
 *
 * In Phase 0 this is a side-effect-free observer: every Interaction is
 * appended with `lifecycle: 'applied'` (the relay still executes the action
 * imperatively). Phase 2 introduces an admission gate that goes through the
 * role-ordered merge before deciding the lifecycle.
 *
 * `record()` is the only mutation entry point. Callers supply the causal
 * chain (`caused_by`) — the ledger does not infer it, because honest causal
 * deps are the foundation rubric #1 (Replayability) and #3 (Interpretability)
 * rest on.
 */

import { hashInteraction } from './canonical.ts'
import type { Interaction, ProposedInteraction } from './interaction.ts'
import type { Store } from './store.ts'

export class Ledger {
  constructor(private readonly store: Store) {}

  /**
   * Append a Phase 0 capture interaction. Returns the fully-formed record
   * with hash, lifecycle, and timestamp filled in. If the same content was
   * already recorded (same hash), returns the existing row — at-least-once
   * delivery without duplication.
   */
  async record(p: ProposedInteraction): Promise<Interaction> {
    const hash = hashInteraction(p)
    const i: Interaction = {
      ...p,
      hash,
      lifecycle: 'applied',
      createdAt: new Date().toISOString(),
    }
    const { inserted } = await this.store.append(i)
    if (inserted) return i
    // Same content already recorded — return whatever is canonical in the store.
    const existing = await this.store.getByHash(hash)
    return existing ?? i
  }

  /** Used by handlers that need to chain a child onto the channel's latest. */
  async latestInChannel(channelId: string): Promise<Interaction | undefined> {
    return this.store.latestInChannel(channelId)
  }

  /** Direct store access for folds and tests. */
  get backing(): Store {
    return this.store
  }
}
