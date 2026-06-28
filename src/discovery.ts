/**
 * Shared discovery-snapshot assembler — the ONE impure source-gathering step the gap-resolver
 * runs on. It connects nothing of its own decision logic: it turns whatever sources a caller can
 * supply (a connected adapter, a directory) into a normalized `DiscoverySnapshot` of live facts —
 * self-id, enumerated channels/members, claimed directory peers, configured transport — carrying
 * each enumeration's three-valued outcome through unswallowed so the pure resolver picks the right
 * fill rung. Built ONCE here (not per caller) so the capability-branched enumeration and
 * degradation logic can't drift across the five flows (KTD1).
 */

import { makeMessagingAdapter } from './adapters-msg/index.ts'
import type {
  DiscoveryCapabilities,
  DiscoveredEntity,
  EnumerationOutcome,
  MessagingAdapter,
} from './messaging-adapter.ts'
import type { AgentIdentity, Bot, Platform, DiscoverySnapshot } from './lib.ts'
export type { DiscoverySnapshot } from './lib.ts'

/** The subset of a MessagingAdapter the assembler touches — self-id plus the duck-typed
 *  discovery calls (off the core interface, present only where capable). A real adapter satisfies
 *  this structurally; tests pass a fake. */
export type DiscoveryAdapter = {
  readonly botUserId?: string | undefined
  readonly botLabel?: string | undefined
  discoveryCapabilities(): DiscoveryCapabilities
  listChannels?(): Promise<EnumerationOutcome>
  listMembers?(channelId: string): Promise<EnumerationOutcome>
  createChannel?(name: string): Promise<EnumerationOutcome>
}

/** Sources a caller can supply. The relay has all of them; doctor has an adapter + a
 *  pending-derived directory; setup has a fresh adapter + an empty directory. */
export type AssembleSources = {
  platform: Platform
  /** An already-connected adapter; absent ⇒ no live enumeration (offline doctor). */
  adapter?: DiscoveryAdapter
  /** Directory identities (live from the relay, or pending-derived for doctor); absent ⇒
   *  directory unavailable. */
  directory?: ReadonlyArray<AgentIdentity>
  /** Override for whether `directory` is live; defaults to "available iff a directory was given." */
  directoryAvailable?: boolean
  /** Focus channel id for member enumeration. */
  channelId?: string
  /** Whether a transport channel is already configured on this platform. */
  transportConfigured?: boolean
}

const NO_DISCOVERY: DiscoveryCapabilities = {
  selfId: false,
  channelEnumeration: false,
  memberEnumeration: false,
  channelCreation: false,
}

// ─── short-TTL enumeration cache ───────────────────────────────────────────────
// Enumeration is rate-limited on every platform. Cache each outcome briefly per pass so
// repeated doctor/relay passes don't exhaust the budget; a `degraded` outcome is cached the
// same way, so it's sticky within the window rather than re-hammered.
const TTL_MS = 30_000
type CacheEntry = { at: number; outcome: EnumerationOutcome }
const enumCache = new Map<string, CacheEntry>()

/** Clear the enumeration cache (test seam; also lets a caller force a fresh pass). */
export function clearSnapshotCache(): void {
  enumCache.clear()
}

async function cachedEnum(key: string, run: () => Promise<EnumerationOutcome>): Promise<EnumerationOutcome> {
  const hit = enumCache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.outcome
  let outcome: EnumerationOutcome
  try {
    outcome = await run()
  } catch {
    outcome = { kind: 'degraded', reason: 'enumeration call threw' }
  }
  enumCache.set(key, { at: Date.now(), outcome })
  return outcome
}

/** Build the snapshot once from whatever sources are available. The capability descriptor gates
 *  whether an enumeration is attempted; the duck-typed method's presence is the real gate; the
 *  three-valued outcome distinguishes empty from forbidden. Pure of decisions — it only gathers. */
export async function assembleSnapshot(sources: AssembleSources): Promise<DiscoverySnapshot> {
  const { platform, adapter, directory, channelId } = sources
  const capabilities = adapter?.discoveryCapabilities() ?? NO_DISCOVERY
  // Enumeration results are BOT-specific (each bot sees only the channels/members it has access
  // to — a different bot on the same platform sees a different list, or is degraded where it isn't
  // a member), so the cache MUST key on the connected bot's self-id, not just the platform.
  // Otherwise a second same-platform bot within the TTL reuses the first bot's list (e.g. doctor
  // looping bots reports a false membership pass/fail).
  const selfKey = adapter?.botUserId ?? '?'

  const channels: EnumerationOutcome =
    capabilities.channelEnumeration && adapter?.listChannels
      ? await cachedEnum(`${platform}:${selfKey}:channels`, () => adapter.listChannels!())
      : { kind: 'unsupported' }

  const members: EnumerationOutcome =
    channelId && capabilities.memberEnumeration && adapter?.listMembers
      ? await cachedEnum(`${platform}:${selfKey}:${channelId}:members`, () => adapter.listMembers!(channelId))
      : { kind: 'unsupported' }

  const directoryPeers = directory ? directory.filter(d => d.platform === platform) : []

  return {
    platform,
    ...(adapter?.botUserId ? { selfId: adapter.botUserId } : {}),
    ...(adapter?.botLabel ? { selfLabel: adapter.botLabel } : {}),
    channels,
    members,
    directoryPeers: [...directoryPeers],
    directoryAvailable: sources.directoryAvailable ?? directory !== undefined,
    transportConfigured: sources.transportConfigured ?? false,
    capabilities,
  }
}

/** Construct + connect an adapter for a bot so setup/doctor can enumerate (nothing outside the
 *  relay connects one today). Resolves `secretEnv` → env exactly as `AgentHost.start` does. Returns
 *  the connected adapter (caller MUST `disconnect()` when done), or undefined when the token is
 *  unset or connect fails. */
export async function connectDiscoveryAdapter(
  bot: Bot,
  env: Record<string, string | undefined> = process.env,
): Promise<MessagingAdapter | undefined> {
  const token = bot.tokenEnv ? env[bot.tokenEnv] : undefined
  if (!token) return undefined
  const adapter = makeMessagingAdapter(bot.platform)
  const secrets: Record<string, string> = {}
  for (const [name, envName] of Object.entries(bot.secretEnv ?? {})) {
    const v = envName ? env[envName] : undefined
    if (v) secrets[name] = v
  }
  try {
    await adapter.connect(token, secrets)
    return adapter
  } catch {
    try {
      await adapter.disconnect()
    } catch {}
    return undefined
  }
}

/** A discovered channel/member list as a flat array, or [] for degraded/unsupported. Convenience
 *  for callers that only want the items (the resolver itself reads the full outcome). */
export function itemsOf(outcome: EnumerationOutcome<DiscoveredEntity>): DiscoveredEntity[] {
  return outcome.kind === 'results' ? outcome.items : []
}
