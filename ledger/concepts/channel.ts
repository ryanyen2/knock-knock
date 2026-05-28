/**
 * Channel concept — per-channel transcript fold.
 *
 * The transcript projection used by DmCourier and (later) by the operator
 * console. One causal slice of (channel.message + turn.replied) per channel
 * gives both the human audit trail AND the agent's context window — they're
 * the same projection (rubric #3, dual-audience).
 */

import type { Fold } from '../fold.ts'
import type { ChannelId, Interaction } from '../interaction.ts'

export type ChannelTranscriptEntry =
  | { kind: 'message'; hash: string; senderId: string; role: Interaction['role']; text: string; ts: string }
  | { kind: 'reply'; hash: string; agentKey: string; text: string; ts: string }

export type ChannelFoldState = ReadonlyMap<ChannelId, ReadonlyArray<ChannelTranscriptEntry>>

export const CHANNEL_FOLD = 'channel:transcript'

export const channelFold: Fold<ChannelFoldState> = {
  name: CHANNEL_FOLD,
  init: () => new Map(),
  key: i =>
    (i.verb === 'channel.message' || i.verb === 'turn.replied') &&
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
  step: (state, i) => {
    const next = new Map(state)
    const prior = next.get(i.channel) ?? []
    let entry: ChannelTranscriptEntry | undefined
    if (i.verb === 'channel.message' && i.patch.kind === 'external') {
      const args = i.patch.intent.args as { text?: string } | undefined
      entry = {
        kind: 'message',
        hash: i.hash,
        senderId: i.actor,
        role: i.role,
        text: args?.text ?? '',
        ts: i.createdAt,
      }
    } else if (i.verb === 'turn.replied' && i.patch.kind === 'external') {
      const args = i.patch.intent.args as { text?: string } | undefined
      entry = {
        kind: 'reply',
        hash: i.hash,
        agentKey: i.actor,
        text: args?.text ?? '',
        ts: i.createdAt,
      }
    }
    if (!entry) return state
    next.set(i.channel, [...prior, entry])
    return next
  },
}
