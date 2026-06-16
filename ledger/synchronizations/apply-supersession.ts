/**
 * apply-supersession — local-first cross-machine lifecycle replication.
 *
 * The merge gate supersedes a loser by an UPDATE (`updateLifecycle(loser,
 * 'superseded')`). But the Postgres NOTIFY trigger fires on INSERT, not UPDATE,
 * so a peer relay never learned of the supersession — its folds kept showing the
 * superseded turn/approval/knowledge as live (the pre-existing cross-machine gap
 * noted in store-pg.ts).
 *
 * AOCM closed the same gap for file edits by deriving convergence from immutable
 * INSERTs. We do the same here without a hosted-DB feature (no NOTIFY-on-UPDATE,
 * no logical replication): the WINNER interaction already carries
 * `supersedes: [loserHash, …]` as part of its row, and that INSERT *does* cross
 * NOTIFY. So a peer receiving the winner re-derives the lifecycle change locally
 * from that immutable op — convergence rides operations the store already
 * propagates.
 *
 * On the originating relay this sync does not fire on its own winner (the
 * Postgres echo of a local write is skipped, and admit.ts already applied the
 * UPDATE directly). On a peer it fires on the genuine remote winner. The update
 * is idempotent — guarded on the loser's current lifecycle — so the SQLite
 * single-relay case (where the local INSERT is delivered) is a harmless no-op.
 */

import type { Synchronization } from '../sync.ts'

export function applySupersession(): Synchronization {
  return {
    name: 'apply-supersession',
    matches: i =>
      (i.lifecycle === 'applied' || i.lifecycle === 'admitted') &&
      Array.isArray(i.supersedes) &&
      i.supersedes.length > 0,
    fire: async (winner, ctx) => {
      for (const loser of winner.supersedes ?? []) {
        const peer = await ctx.store.getByHash(loser)
        // Idempotent: the originating relay already applied this directly, and a
        // loser that's already superseded/denied needs no change. Skipping keeps
        // the SQLite local-delivery case a no-op and avoids redundant refolds.
        if (!peer || peer.lifecycle === 'superseded' || peer.lifecycle === 'denied') continue
        // Match admit.ts's originating call exactly (no extra) so the loser's
        // bookkeeping is identical on every relay.
        await ctx.store.updateLifecycle(loser, 'superseded')
      }
    },
  }
}
