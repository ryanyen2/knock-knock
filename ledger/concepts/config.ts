/**
 * Config concept — the per-channel behavioral overlay, folded from the log.
 *
 * The fold IS the overlay state; nothing else holds it. Each owner `!config`
 * edit is a `config.set` interaction targeting `cfg:channel/<roomId>` with a
 * `none` anchor (so the merge gate is a provable no-op and the edit is admitted
 * `applied` immediately). The fold accumulates the raw delta records per
 * artifact; `configFor` projects them through the pure, order-independent
 * `projectChannelConfig` (lib.ts) — so every replica and every replay path
 * converges on the same view regardless of arrival order (fold rubric #1).
 *
 * State is keyed by artifactId (a Map) so the fold engine's O(artifact) slice
 * rebuild applies; config.set never undergoes a lifecycle change (anchor:none →
 * never superseded), so in practice no re-fold is triggered for it.
 *
 * The base layer (identity, allowlist, permission floor) lives in the terminal-
 * written files and is merged OVER by callers — the overlay only tunes behavior.
 */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId, ArtifactId } from '../interaction.ts'
import {
  projectChannelConfig,
  resolveTwoLayerConfig,
  type ChannelConfig,
  type ConfigDeltaRecord,
} from '../../lib.ts'

export type ConfigFoldState = ReadonlyMap<ArtifactId, ConfigDeltaRecord[]>

export const CONFIG_FOLD = 'config'

/** The overlay artifact for a room (the parent channel whose config governs it). */
export function configArtifact(roomId: ChannelId): ArtifactId {
  return `cfg:channel/${roomId}`
}

function deltaOf(i: Interaction): ConfigDeltaRecord['delta'] | undefined {
  if (i.patch.kind !== 'external') return undefined
  const args = i.patch.intent.args
  return args && typeof args === 'object' ? (args as ConfigDeltaRecord['delta']) : undefined
}

export const configFold: Fold<ConfigFoldState> = {
  name: CONFIG_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.verb === 'config.set' &&
    i.target.artifactId.startsWith('cfg:'),
  step: (state, i) => {
    const delta = deltaOf(i)
    if (!delta) return state
    const next = new Map(state)
    const prev = next.get(i.target.artifactId) ?? []
    next.set(i.target.artifactId, [...prev, { delta, createdAt: i.createdAt, hash: i.hash }])
    return next
  },
}

/** The effective config for a single artifact id (room OR thread scope) — the
 *  file base is merged OVER by the caller. */
export function configFor(state: ConfigFoldState, id: ChannelId): ChannelConfig {
  return projectChannelConfig(state.get(configArtifact(id)) ?? [])
}

/**
 * The effective config for a turn running in `scopeId` whose room is `roomId`:
 * the room overlay is the inherited default, and the scope (thread) overlay wins
 * per key. When the scope IS the room (no thread) this collapses to the room
 * config — both layers read the same artifact, so resolution is a no-op.
 *
 * The two layers are independent artifacts, each projected + clamped on its own;
 * we merge the RESULTS (never concatenate raw deltas), so a room `_clear` can't
 * reach into a scope key. See `resolveTwoLayerConfig`.
 */
export function resolveConfigFor(
  state: ConfigFoldState,
  roomId: ChannelId,
  scopeId: ChannelId,
): ChannelConfig {
  if (scopeId === roomId) return configFor(state, roomId)
  return resolveTwoLayerConfig(configFor(state, roomId), configFor(state, scopeId))
}

/** The artifact's records ordered for causal chaining — the host chains a new
 *  `config.set`'s `caused_by` onto the latest so re-affirming a prior value
 *  isn't deduped to the older (earlier-timestamped) interaction. */
export function latestConfigHash(state: ConfigFoldState, roomId: ChannelId): string | undefined {
  const records = state.get(configArtifact(roomId)) ?? []
  if (records.length === 0) return undefined
  let best = records[0]!
  for (const r of records) {
    if (r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.hash > best.hash)) best = r
  }
  return best.hash
}
