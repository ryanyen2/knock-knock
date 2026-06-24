/**
 * prompt-on-message — Phase 3 inbound inversion.
 *
 * Fires on admitted `channel.message`. Looks up which agent owns this
 * channel (via injected callback — the host has live access to the agent
 * registry). Consults the LoopGuard fold to decide whether to admit a
 * `turn.prompted`. If the loop guard says deny, this synchronization is a
 * no-op — the channel.message stays in the ledger as evidence of the
 * inbound, but no agent turn is initiated.
 *
 * Behavioral equivalence with the old AgentHost.handleInbound:
 *   - The same `loopGuard(state, kind, now)` from lib.ts is the gate.
 *   - The same per-channel state is used (via the LoopGuard fold).
 *   - Owner/human messages always reset the counter and pass.
 *   - The 31 lib.test.ts cases continue to describe the rules verbatim.
 */

import type { Synchronization } from '../sync.ts'
import type { ChannelId, Role } from '../interaction.ts'
import type { LoopGuardOpts } from '../../lib.ts'
import {
  LOOP_GUARD_FOLD,
  decideLoopGuard,
  type LoopGuardFoldState,
} from '../concepts/loop-guard.ts'

export type AgentForChannel = {
  /** Which agent's turn we're prompting on this channel. */
  agentKey: string
  /** The room's loop-guard thresholds (owner `!config` overlay, else defaults).
   *  Resolved by the host, which owns scope→room + the config fold. */
  loopGuardOpts?: LoopGuardOpts
}

export type PromptOnMessageOpts = {
  /** Resolve the agent for a channel; null if no agent listens here. */
  getAgentForChannel: (channelId: ChannelId) => AgentForChannel | undefined
  /** Optional clock for tests. */
  now?: () => number
}

export function promptOnMessage(opts: PromptOnMessageOpts): Synchronization {
  const now = opts.now ?? (() => Date.now())
  return {
    name: 'prompt-on-message',
    matches: i =>
      i.verb === 'channel.message' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      const agentInfo = opts.getAgentForChannel(i.channel)
      if (!agentInfo) return // no agent listens on this channel

      // The sender's role-in-channel is snapshotted on the inbound
      // interaction. The loop guard uses it to decide; owner/human pass,
      // agent goes through the threshold + cooldown check.
      const lgState = ctx.engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD)
      const decision = decideLoopGuard(lgState, i.channel, i.role, now(), agentInfo.loopGuardOpts)
      if (!decision.allow) {
        // Silently skip — the operator console gets a note elsewhere. The
        // channel.message stays in the ledger as evidence; the absence of
        // a follow-up turn.prompted is the audit signal "we declined to act".
        return
      }

      // Admit the turn.prompted causal pin. The drive-turn synchronization
      // observes this and runs the adapter.
      await ctx.admit({
        actor: agentInfo.agentKey,
        role: 'agent' as Role,
        channel: i.channel,
        target: { artifactId: i.target.artifactId, anchor: { kind: 'none' } },
        verb: 'turn.prompted',
        patch: { kind: 'none' },
        effect: 'pure',
        caused_by: [i.hash],
      })
    },
  }
}
