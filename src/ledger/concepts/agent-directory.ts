/** Agent-directory concept — a shared directory of every bot's self-published
 *  platform identity (`agent.identity`, anchor `none` so it's admitted applied and
 *  never conflicts, same convention as the coordination board). Each bot writes its
 *  own `dir:agent/<agentKey>` on connect; the fold projects the latest identity per
 *  agentKey (last-writer-wins by `createdAt,hash`). Lets co-resident AND cross-machine
 *  bots discover and address each other without manual roster entries — the projection
 *  feeds `peerDirectoryParticipants` in lib.ts. */

import type { Fold } from '../fold.ts'
import type { AgentIdentity, ArtifactId } from '../interaction.ts'

type Entry = { identity: AgentIdentity; createdAt: string; hash: string }
export type AgentDirectoryFoldState = ReadonlyMap<string, Entry>

export const AGENT_DIRECTORY_FOLD = 'agent-directory'

/** The directory artifact for a bot (only that bot writes it — no contention). */
export function dirArtifact(agentKey: string): ArtifactId {
  return `dir:agent/${agentKey}`
}

export const agentDirectoryFold: Fold<AgentDirectoryFoldState> = {
  name: AGENT_DIRECTORY_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    i.verb === 'agent.identity' &&
    i.target.artifactId.startsWith('dir:'),
  step: (state, i) => {
    if (i.patch.kind !== 'identity') return state
    const data = i.patch.data
    const prev = state.get(data.agentKey)
    // Last-writer-wins, deterministic across backends: keep the max (createdAt, hash).
    if (prev && (prev.createdAt > i.createdAt || (prev.createdAt === i.createdAt && prev.hash >= i.hash))) {
      return state
    }
    const next = new Map(state)
    next.set(data.agentKey, { identity: data, createdAt: i.createdAt, hash: i.hash })
    return next
  },
}

/** All known bot identities (latest per agentKey). */
export function directoryFor(state: AgentDirectoryFoldState): AgentIdentity[] {
  return [...state.values()].map(e => e.identity)
}
