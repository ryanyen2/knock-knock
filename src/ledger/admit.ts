/**
 * The admission gate: runs the role-ordered merge, sets lifecycle, supersedes
 * losers, and surfaces supersession/rejection back to the loser's inbox.
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

/** Admit (or deny / hold-as-conflict) a proposed Interaction. Always appended,
 *  even when denied (denied/superseded entries stay in the audit trail). */
export async function admit(
  store: Store,
  proposal: ProposedInteraction,
): Promise<AdmissionResult> {
  const hash = hashInteraction(proposal)

  // Idempotency: surface the existing outcome rather than re-running the gate.
  const existing = await store.getByHash(hash)
  if (existing) return toResult(existing)

  // Versionable edits admitted `applied`, bypassing the role gate — dominance is
  // derived in projectVersionable from immutable ops, not a mutated lifecycle.
  if (proposal.verb === 'workspace.edit' && proposal.effect === 'workspace') {
    const applied: Interaction = {
      ...proposal,
      hash,
      lifecycle: 'applied',
      createdAt: new Date().toISOString(),
    }
    await store.append(applied)
    return { kind: 'admitted', interaction: applied, superseded: [] }
  }

  // Shell Interaction for the concurrency query (its caused_by feeds the ancestor check).
  const shell: Interaction = {
    ...proposal,
    hash,
    lifecycle: 'proposed',
    createdAt: new Date().toISOString(),
  }
  const concurrent = await findConcurrentAtAnchor(store, shell)
  const outcome = mergeProposal(shell, concurrent)

  // Compute the FINAL lifecycle before inserting, so fold subscribers see the
  // interaction exactly once in its post-gate state.
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
      // updateLifecycle fires the store's lifecycle signal so live folds drop the superseded peer immediately.
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
      // lifecycle 'proposed' — folds filter it out by default
      return { kind: 'conflict', interaction: final, branches: outcome.branches }
  }
}

/** Write a knowledge.append note to the loser's inbox so the next turn surfaces
 *  the supersession back to its author. Inbox anchor is `none` so it never
 *  conflicts. The `system:merge-gate` author is what `dm-on-supersede` matches. */
export async function surfaceToInbox(
  store: Store,
  loser: Interaction,
  reason: { why: string; winner: Hash; channel: string },
): Promise<void> {
  const noteId = `superseded-${loser.hash.slice(0, 10)}-${Date.now()}`
  const inbox = inboxArtifact(loser.actor)
  const note: ProposedInteraction = {
    actor: 'system:merge-gate',
    role: 'owner', // gate speaks with system authority, not the loser's role
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
