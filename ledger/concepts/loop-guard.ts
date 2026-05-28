/**
 * LoopGuard concept — per-channel "consecutive agent turns + last agent reply
 * timestamp" derived purely from admitted channel.message Interactions.
 *
 * Replaces `AgentHost.loopState: Map<channelId, LoopGuardState>`. The pure
 * `loopGuard(...)` function in lib.ts (and the 7 tested cases that describe
 * its behavior) is reused verbatim — the fold only computes the inputs.
 *
 * Behavioral equivalence with the imperative version:
 *   - owner/human channel.message → counter resets, lastAgentReplyAt cleared.
 *   - agent channel.message       → counter increments, lastAgentReplyAt set
 *                                   to the interaction's createdAt.
 *
 * The decision (`allow` / `deny`) is still computed by calling `loopGuard`
 * from lib.ts at the call site — keeps the merge/admission gate in one place.
 */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId } from '../interaction.ts'
import { loopGuard, type LoopGuardState, type LoopGuardOpts } from '../../lib.ts'

export type LoopGuardFoldState = ReadonlyMap<ChannelId, LoopGuardState>

const FRESH: LoopGuardState = { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 }

export const LOOP_GUARD_FOLD = 'loop-guard'

export const loopGuardFold: Fold<LoopGuardFoldState> = {
  name: LOOP_GUARD_FOLD,
  init: () => new Map(),
  /**
   * Steps on:
   *   - `turn.prompted` — represents "we decided to take a turn here." This
   *     is what increments the counter; matches the original Phase 0
   *     semantics where lgNext was set only when the loop guard allowed.
   *   - `channel.message` with role=owner|human — resets the counter (a
   *     human breaking the chain is the canonical reset signal).
   * Crucially does NOT step on agent-role channel.messages — those are
   *  pending inputs that the loop-guard decides on; counting them before
   *  the decision causes the synchronization's pre-prompt check to see
   *  state that already includes the message it's deciding about, which
   *  breaks the cooldown semantics.
   */
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
      // owner/human channel.message → reset counter
      next.set(i.channel, { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 })
    } else {
      // turn.prompted → this is a turn we decided to take, count it.
      next.set(i.channel, {
        consecutiveAgentTurns: prior.consecutiveAgentTurns + 1,
        lastAgentReplyAt: Date.parse(i.createdAt),
      })
    }
    return next
  },
}

/** Convenience: read the per-channel state, falling back to FRESH. */
export function stateFor(
  fold: LoopGuardFoldState,
  channelId: ChannelId,
): LoopGuardState {
  return fold.get(channelId) ?? FRESH
}

/**
 * Apply the admission decision: read the fold, run the pure loopGuard from
 * lib.ts, return its verdict. Pure — does not mutate anything (the fold
 * advances itself when the resulting channel.message lands in the store).
 */
export function decideLoopGuard(
  fold: LoopGuardFoldState,
  channelId: ChannelId,
  kind: 'owner' | 'human' | 'agent' | 'unknown',
  now: number,
  opts?: LoopGuardOpts,
): { allow: boolean; reason?: 'threshold' | 'cooldown' } {
  return loopGuard(stateFor(fold, channelId), kind, now, opts).decision
}
