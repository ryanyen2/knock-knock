/** prompt-on-message — on admitted `channel.message`, consult the LoopGuard fold
 *  and admit a `turn.prompted` unless the guard denies. */

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
  /** The room's loop-guard thresholds (host-resolved). */
  loopGuardOpts?: LoopGuardOpts
}

export type PromptOnMessageOpts = {
  /** Resolve the agent for a channel; undefined if none listens. `preferAgentKey`
   *  routes to the addressed bot so co-resident bots don't cross-handle. */
  getAgentForChannel: (channelId: ChannelId, preferAgentKey?: string) => AgentForChannel | undefined
  /** Optional clock for tests. */
  now?: () => number
}

/** The bot a `channel.message` was addressed to, stamped by the admitting host. */
function targetAgentHint(patch: unknown): string | undefined {
  const args = (patch as { intent?: { args?: { targetAgent?: unknown } } })?.intent?.args
  return typeof args?.targetAgent === 'string' ? args.targetAgent : undefined
}

export function promptOnMessage(opts: PromptOnMessageOpts): Synchronization {
  const now = opts.now ?? (() => Date.now())
  return {
    name: 'prompt-on-message',
    matches: i =>
      i.verb === 'channel.message' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      const agentInfo = opts.getAgentForChannel(i.channel, targetAgentHint(i.patch))
      if (!agentInfo) return // no agent listens on this channel

      const lgState = ctx.engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD)
      const decision = decideLoopGuard(lgState, i.channel, i.role, now(), agentInfo.loopGuardOpts)
      if (!decision.allow) {
        // declined; the absent turn.prompted is the audit signal
        return
      }

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
