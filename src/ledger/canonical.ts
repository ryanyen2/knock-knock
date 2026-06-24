/**
 * Canonical-JSON serialization and content-addressing for Interactions. Equal
 * immutable fields MUST hash equally; mutable bookkeeping is excluded.
 */

import { createHash } from 'crypto'
import type { Interaction, ProposedInteraction, Hash } from './interaction.ts'

/** Stable JSON: sorted keys, no whitespace, fixed array order. NaN/Infinity
 *  throw — they would round-trip to `null` and corrupt the hash. */
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
  const causes = Array.from(new Set(p.caused_by)).sort() // sorted + deduped so callers needn't pre-sort
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

/** Verify an Interaction's stored hash matches its content. */
export function verifyHash(i: Interaction): boolean {
  return hashInteraction(i) === i.hash
}
