/**
 * resolveConflict — the headless core of a conflict-card resolution.
 *
 * AOCM: resolution is NOT a lifecycle flip. A versionable conflict is derived by
 * `projectVersionable` from the immutable ops; to resolve it the owner admits an
 * ORDINARY higher-authority op that the total order `(role DESC, hash ASC)` floats
 * to the top. We admit an owner-role COPY of the chosen branch (same ops/intent/
 * target, same parents → concurrent with the agent branches): being owner-role and
 * interfering, it excludes both agent branches from the projection's live set, so
 * the live text becomes the chosen branch's text and the equal-role conflict clears
 * — all DERIVED, with no UPDATE to propagate across replicas. We still surface the
 * drop to each loser's inbox (the same surface-back the admission gate uses, so
 * `dm-on-supersede` DMs the losing agent's owner).
 *
 * This logic used to live inside the Discord button handler (`host/conflict-ui.ts`);
 * extracting it makes resolution a ledger verb that any source — a Discord click, a
 * CLI, a future API — can drive, while Discord stays the human surface (the handler
 * is now a thin adapter over this).
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

  const chosen = await store.getByHash(chosenHash)
  if (!chosen || chosen.patch.kind !== 'versionable') return undefined

  // Admit an owner-role COPY of the chosen branch: same ops/intent/target, and the
  // SAME parents (`caused_by`) so it stays concurrent with — rather than a descendant
  // of — the agent branches. The projection then floats it above both (owner role)
  // and, being concurrent + interfering, excludes them: the live text becomes the
  // chosen branch's text and the equal-role conflict clears. No lifecycle UPDATE; the
  // dominance is derived, so it converges on every replica from this one INSERT.
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

  // Surface the drop to each non-chosen branch's author. The note is an INSERT
  // (knowledge.append), so it crosses replicas and `dm-on-supersede` fires — the
  // human-facing half of the override that the derived exclusion does not carry.
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
