/** Small shared ledger utilities. */

/** Best-effort stringify for keying/comparing a value. NOT the canonical hashing
 *  encoding — see `canonical.ts`. */
export function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
