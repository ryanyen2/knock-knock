/**
 * Canonical-JSON serialization and content-addressing for Interactions.
 *
 * The hash is the identity of an Interaction. Two actors producing the same
 * `(actor, role, channel, target, verb, patch, effect, caused_by)` MUST get
 * the same hash — that's how at-least-once delivery, store-side dedup, and
 * cross-machine reconciliation all stay simple.
 *
 * Mutable bookkeeping (`lifecycle`, `supersedes`, `deniedReason`, `signature`,
 * `createdAt`) is excluded from the hash on purpose — the hash names what the
 * actor proposed, not what later happened to it.
 */

import { createHash } from 'crypto'
import type { Interaction, ProposedInteraction, Hash } from './interaction.ts'

/**
 * Stable JSON: sorted object keys, no whitespace, fixed array order. Numbers
 * use JavaScript's standard JSON encoding (which is already deterministic for
 * any finite value); NaN/Infinity throw because they would silently round-trip
 * to `null` and corrupt the hash.
 *
 * Patch-blob deduplication (pre-hashing large patch payloads) is deferred to
 * Phase 2 — it's an optimisation, not a correctness property.
 */
export function canonicalJson(v: unknown): string {
  if (v === undefined) throw new Error('canonicalJson: undefined is not encodable')
  if (v === null) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number ${v}`)
    return JSON.stringify(v)
  }
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined) // match JSON.stringify's elision
      .sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  }
  throw new Error(`canonicalJson: unsupported type ${typeof v}`)
}

/** The subset of fields that feed the hash. */
function hashInput(p: ProposedInteraction) {
  // `caused_by` is sorted + deduped here so callers don't have to pre-sort.
  const causes = Array.from(new Set(p.caused_by)).sort()
  return {
    actor: p.actor,
    role: p.role,
    channel: p.channel,
    target: p.target,
    verb: p.verb,
    patch: p.patch,
    effect: p.effect,
    caused_by: causes,
  }
}

export function hashInteraction(p: ProposedInteraction): Hash {
  return createHash('sha256').update(canonicalJson(hashInput(p))).digest('hex')
}

/**
 * Verify that an Interaction's stored hash matches its content — the
 * content-addressing invariant. Exercised by the ledger's hash-integrity tests.
 */
export function verifyHash(i: Interaction): boolean {
  return hashInteraction(i) === i.hash
}
