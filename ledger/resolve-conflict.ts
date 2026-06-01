/**
 * resolveConflict — the headless core of a conflict-card resolution.
 *
 * Records the owner's `merge.resolve`, flips lifecycles (chosen → applied, the
 * rest → superseded), and surfaces the drop to each loser's inbox (the same
 * surface-back the admission gate uses, so `dm-on-supersede` DMs the losing
 * agent's owner). This logic used to live inside the Discord button handler
 * (`host/conflict-ui.ts`); extracting it makes resolution a ledger verb that any
 * source — a Discord click, a CLI, a future API — can drive, while Discord stays
 * the human surface (the handler is now a thin adapter over this).
 *
 * Identity boundary: the caller must pass an `ownerId` that is a real owner for
 * the scope; this function does not authenticate. The Discord handler gates on
 * `ownerUserId` before calling; a headless caller must do the equivalent.
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

/** Apply an owner's conflict resolution. Returns the merge.resolve hash + the
 *  superseded losers, or undefined when the chosen branch can't be found. */
export async function resolveConflict(
  store: Store,
  ledger: Ledger,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  const { ownerId, channel, branchHashes, chosenHash } = input
  const losers = branchHashes.filter(h => h !== chosenHash)

  const winner = await store.getByHash(chosenHash)
  if (!winner) return undefined

  // Journal the owner's decision, then flip lifecycles. The merge.resolve targets
  // the winning branch's artifact; caused_by links all branches so the audit
  // trail is "branches → resolve".
  const resolve = await ledger.record({
    actor: ownerId,
    role: 'owner',
    channel,
    target: winner.target,
    verb: 'merge.resolve',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [...branchHashes].sort(),
  })
  await store.updateLifecycle(chosenHash, 'applied')
  await store.updateLifecycle(resolve.hash, 'applied', { supersedes: losers })

  for (const loser of losers) {
    await store.updateLifecycle(loser, 'superseded')
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
