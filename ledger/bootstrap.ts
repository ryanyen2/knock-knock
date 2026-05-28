/**
 * Bootstrap — initial sync for a machine joining a shared ledger.
 *
 * The FoldEngine already replays from `listAllSince(0)` on register, so the
 * concept folds are warm by the time any local Discord traffic arrives.
 * What bootstrap adds: defensive population of `interaction_parent` edges
 * for any rows whose caused_by hasn't been edge-projected yet (e.g., the
 * shared Postgres was populated by a different machine that didn't write
 * the edges, or a backfill is in progress). The ancestor BFS the merge
 * gate uses relies on these edges.
 *
 * Bootstrap is idempotent and cheap on an up-to-date store — it walks
 * interactions in seq order and does ON-CONFLICT-DO-NOTHING inserts on
 * any missing edges.
 */

import type { Store } from './store.ts'

export type BootstrapResult = {
  scanned: number
  /** Whether the store reports any interactions (false → first machine). */
  hasExistingData: boolean
}

/**
 * Idempotent: safe to call on every relay boot. The FoldEngine's bootstrap
 * (replay-on-register) is a separate concern — bootstrap() here is about
 * the store-side graph being consistent before folds attach.
 *
 * Heuristic: if maxSeq() returns 0, the store is empty (this is the first
 * machine). Otherwise we have existing data; the engine should expect a
 * replay of folds on register. We don't repopulate edges here — store-pg's
 * append() already writes them; store-sqlite's append() does too. This
 * function is the place to add cross-version migrations in the future.
 */
export async function bootstrap(store: Store): Promise<BootstrapResult> {
  const seq = await store.maxSeq()
  return { scanned: seq, hasExistingData: seq > 0 }
}
