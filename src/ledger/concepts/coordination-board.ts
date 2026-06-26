/** Coordination-board concept (Problem B) — per-scope shared awareness, folded
 *  from the log. `coord.note` interactions use anchor:none so they're admitted
 *  applied and never conflict (same convention as the knowledge fold). The board
 *  records what each agent is doing (presence) and who has taken a message
 *  (designation); the projection is the pure `projectCoordinationBoard` in lib.ts. */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId, ArtifactId } from '../interaction.ts'
import {
  projectCoordinationBoard,
  type CoordBoard,
  type CoordRecord,
} from '../../lib.ts'

export type CoordBoardFoldState = ReadonlyMap<ArtifactId, CoordRecord[]>

export const COORD_BOARD_FOLD = 'coordination-board'

/** The board artifact for a scope (thread or plain channel). */
export function coordArtifact(scopeId: ChannelId): ArtifactId {
  return `coord:channel/${scopeId}`
}

export const coordBoardFold: Fold<CoordBoardFoldState> = {
  name: COORD_BOARD_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.verb === 'coord.note' &&
    i.target.artifactId.startsWith('coord:'),
  step: (state, i) => {
    if (i.patch.kind !== 'coord') return state
    const next = new Map(state)
    const prev = next.get(i.target.artifactId) ?? []
    next.set(i.target.artifactId, [...prev, { note: i.patch.note, createdAt: i.createdAt, hash: i.hash }])
    return next
  },
}

/** Effective board for a scope. */
export function boardFor(state: CoordBoardFoldState, scopeId: ChannelId): CoordBoard {
  return projectCoordinationBoard(state.get(coordArtifact(scopeId)) ?? [])
}
