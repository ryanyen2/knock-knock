/**
 * §4.3 + §4.6 — pure reply annotations.
 *
 * Two small renderers that turn already-captured ledger facts into the
 * human-facing lines appended under an agent's Discord reply:
 *
 *  - §4.3 the attribution line: "traced from @who's message at HH:MM · N tools"
 *    — drawn from `turn.replied.caused_by` (prompt hash + every executed tool).
 *  - §4.6 the stale-note flag: a ⚠️ warning when the reply rests on knowledge
 *    whose source was invalidated — drawn from the Knowledge fold's staleness.
 *
 * These are pure (no I/O) the same way `lib.ts` is: `post-on-reply` does the
 * ledger lookups and hands the resolved facts in here. Keeping the formatting
 * pure makes the visual vocabulary unit-testable without a store or a fold.
 */

export type AttributionFacts = {
  /** Actor id of the original `channel.message` that started this turn. */
  originActor: string
  /** ISO `createdAt` of that original message. */
  originTs: string
  /** Number of tools the agent executed during the turn. */
  toolCount: number
}

/** Map an actor id to a display handle. Defaults to the raw id. */
export type ResolveName = (actorId: string) => string

/**
 * §4.3 attribution line, rendered as Discord subtext (`-#`, small grey). The
 * caller links the timestamp back to the source message at the Discord layer;
 * here we just produce the text. Returns undefined when we can't name the
 * originating message (e.g. a reply with no captured causal parent).
 */
export function renderAttributionLine(
  facts: AttributionFacts | undefined,
  resolveName: ResolveName = id => id,
): string | undefined {
  if (!facts) return undefined
  const who = resolveName(facts.originActor)
  const time = formatIsoTime(facts.originTs)
  const tools =
    facts.toolCount > 0
      ? ` · ${facts.toolCount} ${facts.toolCount === 1 ? 'tool' : 'tools'}`
      : ''
  return `-# — traced from @${who}'s message${time ? ` at ${time}` : ''}${tools}`
}

export type StaleFlagNote = { body: string }

/**
 * §4.6 stale-note flag. Returns undefined when nothing the reply rests on is
 * stale. Note bodies are truncated so the flag stays a single short paragraph
 * regardless of how much knowledge was invalidated.
 */
export function renderStaleFlag(stale: StaleFlagNote[]): string | undefined {
  if (stale.length === 0) return undefined
  const count = stale.length
  const sample = stale
    .slice(0, 3)
    .map(n => `“${truncate(n.body, 80)}”`)
    .join(', ')
  const more = count > 3 ? ` (+${count - 3} more)` : ''
  const noun = count === 1 ? 'note' : 'notes'
  return (
    `⚠️ This reply may rest on ${count} invalidated ${noun}: ${sample}${more}. ` +
    `The underlying source was marked stale — re-derive from fresh sources if needed.`
  )
}

/** HH:MM (UTC) extracted from an ISO timestamp; '' if unparseable. */
export function formatIsoTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso)
  return m ? m[1]! : ''
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}
