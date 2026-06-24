/**
 * External-proxy artifact — the Claim primitive that serializes side effects.
 * external.* bypasses role-ordered merge; serialized by external_claim. Deny floor sits below: a held claim can't bypass deny.
 */

import type { ArtifactId, Hash } from '../interaction.ts'
import type { Store } from '../store.ts'

export const DEFAULT_CLAIM_TTL_MS = 30_000

/** Acquire-run-release helper. Releases on success AND on throw; if acquire fails, `fn` never runs. */
export async function withClaim<T>(
  store: Store,
  artifactId: ArtifactId,
  holder: Hash,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_CLAIM_TTL_MS,
): Promise<{ acquired: true; result: T } | { acquired: false; currentHolder?: Hash }> {
  const lock = await store.acquireClaim(artifactId, holder, ttlMs)
  if (!lock.acquired) return { acquired: false, currentHolder: lock.currentHolder }
  try {
    const result = await fn()
    return { acquired: true, result }
  } finally {
    await store.releaseClaim(artifactId, holder).catch(() => {})
  }
}
