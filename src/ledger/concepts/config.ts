/** Config concept — per-channel behavioral overlay, folded from the log.
 *  config.set uses anchor:none so it's admitted applied and never conflicts. */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId, ArtifactId, ProposedInteraction, Hash } from '../interaction.ts'
import {
  projectChannelConfig,
  resolveTwoLayerConfig,
  type ChannelConfig,
  type ChannelConfigDelta,
  type ConfigDeltaRecord,
} from '../../lib.ts'

export type ConfigFoldState = ReadonlyMap<ArtifactId, ConfigDeltaRecord[]>

export const CONFIG_FOLD = 'config'

/** The overlay artifact for a room. */
export function configArtifact(roomId: ChannelId): ArtifactId {
  return `cfg:channel/${roomId}`
}

/** Build an owner-role `config.set` proposal for a scope (room OR thread). Pure — the
 *  caller `admit`s it. Shared by the chat `!config` surface and relay startup quick-config.
 *  `causedBy` should be `latestConfigHash(state, scope)` so re-affirming a value isn't
 *  hash-deduped to an older interaction. Anchor is `none`, so it's admitted applied. */
export function buildConfigSet(
  actor: string,
  scope: ChannelId,
  delta: ChannelConfigDelta,
  causedBy?: Hash,
): ProposedInteraction {
  return {
    actor,
    role: 'owner',
    channel: scope,
    target: { artifactId: configArtifact(scope), anchor: { kind: 'none' } },
    verb: 'config.set',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'config.set', args: delta } },
    effect: 'pure',
    caused_by: causedBy ? [causedBy] : [],
  }
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

/** Effective config for a single artifact id (room OR thread scope). */
export function configFor(state: ConfigFoldState, id: ChannelId): ChannelConfig {
  return projectChannelConfig(state.get(configArtifact(id)) ?? [])
}

/** Effective config for a turn in `scopeId` whose room is `roomId`: thread
 *  overlay wins per key over the room default. Layers are merged as RESULTS, not
 *  concatenated deltas, so a room `_clear` can't reach a scope key. */
export function resolveConfigFor(
  state: ConfigFoldState,
  roomId: ChannelId,
  scopeId: ChannelId,
): ChannelConfig {
  if (scopeId === roomId) return configFor(state, roomId)
  return resolveTwoLayerConfig(configFor(state, roomId), configFor(state, scopeId))
}

/** Latest config record hash for causal chaining (so re-affirming a value isn't
 *  deduped to an older interaction). */
export function latestConfigHash(state: ConfigFoldState, roomId: ChannelId): string | undefined {
  const records = state.get(configArtifact(roomId)) ?? []
  if (records.length === 0) return undefined
  let best = records[0]!
  for (const r of records) {
    if (r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.hash > best.hash)) best = r
  }
  return best.hash
}
