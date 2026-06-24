/**
 * Ledger — the writer surface. `record()` is the only mutation entry point;
 * it appends with `lifecycle: 'applied'`. Callers supply `caused_by`.
 */

import { hashInteraction } from './canonical.ts'
import type { Interaction, ProposedInteraction } from './interaction.ts'
import type { Store } from './store.ts'

export class Ledger {
  constructor(private readonly store: Store) {}

  /** Append a capture interaction. Returns the existing row on a hash match
   *  (at-least-once delivery without duplication). */
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
