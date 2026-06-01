/**
 * Small shared ledger utilities.
 */

/**
 * Best-effort stringify for keying/comparing a value (e.g. a tool's input) as a
 * string. Lenient — falls back to `String(v)` on non-serializable input. This
 * is NOT the canonical, sorted-key encoding used for hashing; see
 * `canonical.ts` for that.
 */
export function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
