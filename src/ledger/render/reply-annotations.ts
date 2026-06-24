/** Pure reply annotations: the attribution line and the stale-note flag. */

export type AttributionFacts = {
  originActor: string
  originTs: string
  toolCount: number
}

/** Map an actor id to a display handle. Defaults to the raw id. */
export type ResolveName = (actorId: string) => string

/** Attribution line as Discord subtext; undefined when the origin can't be named. */
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

/** Stale-note flag; undefined when nothing the reply rests on is stale. */
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
