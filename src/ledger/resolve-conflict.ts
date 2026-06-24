/**
 * resolveConflict — headless core of a conflict-card resolution. Resolution is
 * NOT a lifecycle flip: the owner admits an owner-role copy of the chosen branch
 * that the total order floats to the top, so the conflict clears via derived
 * dominance with no UPDATE to propagate. Caller must authenticate `ownerId`.
 */

import type { Hash } from './interaction.ts'
import type { Store } from './store.ts'
import type { Ledger } from './capture.ts'
import { surfaceToInbox } from './admit.ts'

export type ResolveConflictInput = {
  ownerId: string
  channel: string
  /** All branch hashes in the conflict (the proposed + its concurrent peers). */
  branchHashes: Hash[]
  /** Which branch the owner kept. */
  chosenHash: Hash
  /** Optional human label for the surface-back note (e.g. "took 🅰"). */
  label?: string
}

export type ResolveConflictResult = { resolveHash: Hash; losers: Hash[] } | undefined

/** Apply an owner's conflict resolution. Returns the hash of the resolving
 *  owner-role edit + the dominated losers, or undefined when the chosen branch
 *  can't be found (or isn't a versionable edit). */
export async function resolveConflict(
  store: Store,
  ledger: Ledger,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  const { ownerId, channel, branchHashes, chosenHash } = input
  const losers = branchHashes.filter(h => h !== chosenHash)

  const chosen = await store.getByHash(chosenHash)
  if (!chosen || chosen.patch.kind !== 'versionable') return undefined

  // Owner-role COPY of the chosen branch with the SAME parents so it stays
  // concurrent + interfering — excluding the agent branches via derived dominance.
  const resolve = await ledger.record({
    actor: ownerId,
    role: 'owner',
    channel,
    target: chosen.target,
    verb: 'workspace.edit',
    patch: chosen.patch,
    effect: 'workspace',
    caused_by: chosen.caused_by,
  })

  // Surface the drop to each loser's author via an INSERT so `dm-on-supersede` fires across replicas.
  for (const loser of losers) {
    const peer = await store.getByHash(loser)
    if (peer) {
      await surfaceToInbox(store, peer, {
        why: `superseded by owner conflict resolution ${resolve.hash.slice(0, 10)}${input.label ? ` (${input.label})` : ''}`,
        winner: resolve.hash,
        channel,
      })
    }
  }

  return { resolveHash: resolve.hash, losers }
}
