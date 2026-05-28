/**
 * External-proxy artifact — the Claim primitive that serializes side effects.
 *
 * Two `external.*` Interactions can't supersede each other (both may have
 * already realized — sent a Discord message, fired an HTTP POST). The merge
 * gate bypasses role-ordered merge for `effect: external`; serialization is
 * provided by `external_claim` instead.
 *
 * The contract:
 *   1. Before proposing an external.* interaction, acquire the claim.
 *   2. Run the side effect.
 *   3. Append the result interaction.
 *   4. Release the claim.
 *
 * If acquire fails, the actor must wait or abort. If the holder dies between
 * acquire and release, the claim's TTL ensures another actor eventually
 * succeeds. The deny floor (`classifyTool` deny patterns) sits BELOW this:
 * even a held claim can't bypass deny.
 */

import type { ArtifactId, Hash } from '../interaction.ts'
import type { Store } from '../store.ts'

export const DEFAULT_CLAIM_TTL_MS = 30_000

/**
 * Acquire-run-release helper. Releases on success AND on throw (so a crashed
 * side effect doesn't permanently block the artifact). If acquire fails,
 * `fn` is never called and the resolved value carries `{ acquired: false }`.
 */
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
