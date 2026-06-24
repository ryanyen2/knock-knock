/** LoopGuard concept — per-channel consecutive-agent-turns + last-reply
 *  timestamp; the decision is computed by `loopGuard` (lib.ts) at the call site. */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId } from '../interaction.ts'
import { loopGuard, type LoopGuardState, type LoopGuardOpts } from '../../lib.ts'

export type LoopGuardFoldState = ReadonlyMap<ChannelId, LoopGuardState>

const FRESH: LoopGuardState = { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 }

export const LOOP_GUARD_FOLD = 'loop-guard'

export const loopGuardFold: Fold<LoopGuardFoldState> = {
  name: LOOP_GUARD_FOLD,
  init: () => new Map(),
  // Steps on turn.prompted (increment) and owner/human channel.message (reset).
  // Must NOT step on agent-role channel.messages — counting them before the
  // loop-guard decision would break cooldown semantics.
  key: i => {
    if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return false
    if (i.verb === 'turn.prompted') return true
    if (i.verb === 'channel.message' && (i.role === 'owner' || i.role === 'human')) return true
    return false
  },
  step: (state, i) => {
    const next = new Map(state)
    const prior = next.get(i.channel) ?? FRESH
    if (i.verb === 'channel.message') {
      next.set(i.channel, { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 })
    } else {
      next.set(i.channel, {
        consecutiveAgentTurns: prior.consecutiveAgentTurns + 1,
        lastAgentReplyAt: Date.parse(i.createdAt),
      })
    }
    return next
  },
}

/** Per-channel state, falling back to FRESH. */
export function stateFor(
  fold: LoopGuardFoldState,
  channelId: ChannelId,
): LoopGuardState {
  return fold.get(channelId) ?? FRESH
}

/** Read the fold, run the pure loopGuard from lib.ts, return its verdict. */
export function decideLoopGuard(
  fold: LoopGuardFoldState,
  channelId: ChannelId,
  kind: 'owner' | 'human' | 'agent' | 'unknown',
  now: number,
  opts?: LoopGuardOpts,
): { allow: boolean; reason?: 'threshold' | 'cooldown' } {
  return loopGuard(stateFor(fold, channelId), kind, now, opts).decision
}
