/**
 * The admission gate — Phase 2 evolution of capture.ts.
 *
 * `record()` (Phase 0) appends every proposal with `lifecycle: 'applied'`,
 * no checks. `admit()` (Phase 2) runs the role-ordered merge gate, sets
 * lifecycle to `applied | denied | proposed` (proposed = conflict held for
 * resolution), updates lifecycles of any superseded peers, and surfaces
 * supersession + rejection back to the loser's inbox knowledge artifact.
 *
 * The capture path (`record()`) stays for back-compat AND for the cases
 * where the gate is provably a no-op: non-anchored verbs (channel.message,
 * turn.prompted, turn.replied, tool.*) all use `anchor: {kind: 'none'}` and
 * the merge function bypasses them. Wiring the gate end-to-end through
 * TurnRecorder is therefore a no-op for today's flows — the value shows up
 * once anchored verbs (workspace.edit, knowledge.*) start landing.
 */

import { hashInteraction } from './canonical.ts'
import { findConcurrentAtAnchor } from './concurrency.ts'
import { mergeProposal } from './merge.ts'
import type {
  ActorId,
  Hash,
  Interaction,
  Lifecycle,
  ProposedInteraction,
} from './interaction.ts'
import type { Store } from './store.ts'

export type AdmissionResult =
  | { kind: 'admitted'; interaction: Interaction; superseded: Hash[] }
  | {
      kind: 'denied'
      interaction: Interaction
      reason: 'lower-role' | 'claim-violated'
      winner?: Hash
    }
  | { kind: 'conflict'; interaction: Interaction; branches: Hash[] }

/**
 * Admit (or deny / hold-as-conflict) a proposed Interaction. The interaction
 * is always appended (even when denied) — denied/superseded entries stay in
 * the audit trail. Lifecycle is set per the outcome:
 *   - admit  → 'applied'   (capture-style; Phase 3+ may delay applied until
 *                          the side effect actually runs)
 *   - reject → 'denied'
 *   - conflict → 'proposed' (visible to operators, not yet a fold projection)
 */
export async function admit(
  store: Store,
  proposal: ProposedInteraction,
): Promise<AdmissionResult> {
  const hash = hashInteraction(proposal)

  // Idempotency short-circuit: if the same content is already in the store,
  // surface the existing outcome rather than re-running the gate.
  const existing = await store.getByHash(hash)
  if (existing) return toResult(existing)

  // Build a "shell" Interaction for the concurrency query — its caused_by is
  // what feeds the ancestor check; its hash is needed for isAncestor in the
  // reverse direction (no row exists yet, so the SQL walk simply returns
  // false for that branch — fine).
  const shell: Interaction = {
    ...proposal,
    hash,
    lifecycle: 'proposed',
    createdAt: new Date().toISOString(),
  }
  const concurrent = await findConcurrentAtAnchor(store, shell)
  const outcome = mergeProposal(shell, concurrent)

  // Compute the FINAL lifecycle before inserting — fold subscribers see the
  // interaction exactly once, in its post-gate state. Without this, folds
  // that key on `lifecycle in admitted|applied` miss interactions that
  // were inserted at 'proposed' and later transitioned.
  const finalLifecycle: Lifecycle =
    outcome.kind === 'admit'
      ? 'applied'
      : outcome.kind === 'reject'
        ? 'denied'
        : 'proposed' // conflict — held until a higher-role resolves

  const final: Interaction = {
    ...shell,
    lifecycle: finalLifecycle,
    ...(outcome.kind === 'admit' && outcome.supersede.length > 0
      ? { supersedes: outcome.supersede }
      : {}),
    ...(outcome.kind === 'reject' ? { deniedReason: outcome.reason } : {}),
  }
  await store.append(final)

  switch (outcome.kind) {
    case 'admit': {
      // Peer lifecycle updates. updateLifecycle fires the store's awaited
      // lifecycle signal, so the FoldEngine re-folds and live folds drop the
      // superseded peer immediately (matching a fresh replay) — no restart.
      for (const loser of outcome.supersede) {
        await store.updateLifecycle(loser, 'superseded')
        const peer = await store.getByHash(loser)
        if (peer) {
          await surfaceToInbox(store, peer, {
            why: `superseded by higher-role admission ${hash.slice(0, 10)} at the same anchor`,
            winner: hash,
            channel: final.channel,
          })
        }
      }
      return { kind: 'admitted', interaction: final, superseded: outcome.supersede }
    }
    case 'reject': {
      await surfaceToInbox(store, final, {
        why: `rejected: ${outcome.reason} — winner ${outcome.winner.slice(0, 10)} holds the anchor`,
        winner: outcome.winner,
        channel: final.channel,
      })
      return {
        kind: 'denied',
        interaction: final,
        reason: outcome.reason,
        winner: outcome.winner,
      }
    }
    case 'conflict':
      // final.lifecycle is 'proposed' — folds filter it out by default.
      return { kind: 'conflict', interaction: final, branches: outcome.branches }
  }
}

/**
 * Write a knowledge.append note to the loser's inbox so the next turn's
 * "what do I know" fold surfaces the supersession back to its author.
 * This IS the surface-back mechanism — no separate code path, no UI hook.
 *
 * The inbox is anchor: 'none' so it never conflicts (notes are addressed
 * by note.id; the artifact is append-only).
 *
 * Exported so both surface-back paths share one implementation: the gate
 * (above, for higher-role admissions and lower-role rejections) and the
 * owner conflict-card resolution in `AgentHost.resolveConflict`. The note's
 * `system:merge-gate` author is also what `dm-on-supersede` matches on, so
 * surfacing here likewise DMs the losing agent's owner.
 */
export async function surfaceToInbox(
  store: Store,
  loser: Interaction,
  reason: { why: string; winner: Hash; channel: string },
): Promise<void> {
  const noteId = `superseded-${loser.hash.slice(0, 10)}-${Date.now()}`
  const inbox = inboxArtifact(loser.actor)
  const note: ProposedInteraction = {
    actor: 'system:merge-gate',
    role: 'owner', // The gate speaks with system authority, not the loser's role.
    channel: reason.channel,
    target: { artifactId: inbox, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: {
      kind: 'knowledge',
      append: {
        id: noteId,
        body: `Your proposal ${loser.hash.slice(0, 10)} was ${reason.why}.`,
        tags: ['merge', 'superseded'],
      },
    },
    effect: 'pure',
    caused_by: [loser.hash, reason.winner],
  }
  const noteHash = hashInteraction(note)
  await store.append({
    ...note,
    hash: noteHash,
    lifecycle: 'applied',
    createdAt: new Date().toISOString(),
  })
}

export function inboxArtifact(actor: ActorId): string {
  return `know:actor/${actor}/inbox`
}

function toResult(i: Interaction): AdmissionResult {
  // Map an existing interaction's lifecycle back to an AdmissionResult shape.
  const lc: Lifecycle = i.lifecycle
  if (lc === 'denied') {
    return {
      kind: 'denied',
      interaction: i,
      reason: (i.deniedReason as 'lower-role' | 'claim-violated') ?? 'lower-role',
    }
  }
  if (lc === 'proposed') return { kind: 'conflict', interaction: i, branches: [i.hash] }
  return { kind: 'admitted', interaction: i, superseded: i.supersedes ?? [] }
}
