/**
 * Bootstrap — initial sync for a machine joining a shared ledger. Idempotent.
 */

import type { Store } from './store.ts'

export type BootstrapResult = {
  scanned: number
  /** Whether the store reports any interactions (false → first machine). */
  hasExistingData: boolean
}

/** Idempotent: safe to call on every relay boot. maxSeq() === 0 → empty store (first machine). */
export async function bootstrap(store: Store): Promise<BootstrapResult> {
  const seq = await store.maxSeq()
  return { scanned: seq, hasExistingData: seq > 0 }
}
