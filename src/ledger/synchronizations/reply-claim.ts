/** reply-claim — turn-taking (Problem A). On an admitted `channel.message`, decide
 *  whether THIS relay's agent should reply and, if so, win two claims before
 *  admitting `turn.prompted`:
 *
 *    1. reply election  — `replyClaimKey(channel, msgId)` held by AGENT key, so
 *       distinct eligible agents contend to a single winner.
 *    2. drive election  — `driveClaimKey(channel, agent, msgId)` held by RELAY id,
 *       so the same agent served by multiple relays is driven exactly once.
 *
 *  This replaces the old `prompt-on-message`: it keeps the loop-guard gate (using
 *  the ORIGINAL message role) but adds the claim so two agents no longer both
 *  answer one message. The responder policy (race / designated / role-priority)
 *  only biases WHICH eligible agent wins via a short start delay; the claim
 *  guarantees exactly-one regardless of policy. Cross-machine-correct because the
 *  claim is row-lock atomic, not NOTIFY-dependent. */

import type { Synchronization } from '../sync.ts'
import type { ChannelId, Interaction, Role } from '../interaction.ts'
import {
  LOOP_GUARD_FOLD,
  decideLoopGuard,
  type LoopGuardFoldState,
} from '../concepts/loop-guard.ts'
import { coordArtifact } from '../concepts/coordination-board.ts'
import {
  replyClaimKey,
  driveClaimKey,
  resolveResponderPolicy,
  preferredResponderDelayMs,
  type LoopGuardOpts,
  type ChannelConfig,
  type ResponderSelf,
} from '../../lib.ts'

const REPLY_CLAIM_TTL_MS = 60_000

/** Host-resolved context for a `channel.message` — everything a single relay can
 *  know to decide and key the claims. Undefined from the resolver ⇒ no local agent
 *  serves this message (e.g. the addressed bot runs elsewhere). */
export type ReplyCoordContext = {
  agentKey: string
  loopGuardOpts?: LoopGuardOpts
  /** Is this agent the owner's own bot (role-priority bias)? */
  isOwnerBot: boolean
  /** Merged (room ⊕ thread) config carrying the responder policy. */
  cfg: ChannelConfig
  /** This process's relay id (drive-election holder). */
  relayId: string
}

export type ReplyClaimOpts = {
  resolveCoord: (channel: ChannelId, targetAgent: string | undefined) => ReplyCoordContext | undefined
  now?: () => number
  /** Schedule a deferred claim attempt for a non-preferred agent (responder-policy
   *  bias). Default `setTimeout` (unref'd); tests inject a synchronous runner. */
  defer?: (fn: () => void, ms: number) => void
  claimTtlMs?: number
  /** Mesh mode (no shared Postgres): deterministic election over the shared directory.
   *  When provided, the rank-based delay + designation stand-down replace the atomic
   *  reply claim cross-machine (the local claim is kept as a co-resident backstop). */
  election?: MeshElection
}

function messageArgs(i: Interaction): { messageId?: string; targetAgent?: string; text: string } {
  if (i.patch.kind !== 'external') return { text: '' }
  const a = i.patch.intent.args as { messageId?: unknown; targetAgent?: unknown; text?: unknown } | undefined
  return {
    messageId: typeof a?.messageId === 'string' ? a.messageId : undefined,
    targetAgent: typeof a?.targetAgent === 'string' ? a.targetAgent : undefined,
    text: typeof a?.text === 'string' ? a.text : '',
  }
}

/** Per-rank failover step for deterministic mesh election (ms). Must comfortably
 *  exceed the mesh publish→ingest latency so a loser sees the winner's designation
 *  (its stand-down signal) before its own timer fires. */
export const MESH_FAILOVER_STEP_MS = 2500

/** Cross-machine, no-Postgres turn-taking: a deterministic election over the shared
 *  agent-directory replaces the same-machine-only `acquireClaim` reply election. Every
 *  relay computes the SAME rank order, so rank 0 answers at once and lower ranks step
 *  in only if the winner never posts its designation (failover). Provided by the relay
 *  only when mesh is enabled; absent ⇒ the original atomic-claim path is unchanged. */
export type MeshElection = {
  /** This agent's failover rank for the message (0 = elected winner), or undefined if
   *  it is not eligible to answer at all (so it stands down immediately). */
  rankFor: (channel: ChannelId, messageId: string, text: string, selfAgentKey: string) => number | undefined
  /** Has ANY other agent already taken this message (a designation on the board)? The
   *  cross-machine stand-down signal — a loser yields the moment it ingests the winner's note. */
  alreadyDesignated: (channel: ChannelId, messageId: string, selfAgentKey: string) => boolean
  stepMs?: number
}

export function replyClaim(opts: ReplyClaimOpts): Synchronization {
  const now = opts.now ?? (() => Date.now())
  const defer =
    opts.defer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms) as unknown as { unref?: () => void }
      t.unref?.()
    })
  const ttl = opts.claimTtlMs ?? REPLY_CLAIM_TTL_MS

  return {
    name: 'reply-claim',
    matches: i =>
      i.verb === 'channel.message' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      const { messageId, targetAgent, text } = messageArgs(i)
      if (!messageId) return // can't key a per-message claim without the platform id

      const coord = opts.resolveCoord(i.channel, targetAgent)
      if (!coord) return // no local agent serves this message

      // Loop-guard gate (anti-runaway) — uses the ORIGINAL message role, so an
      // owner/human message still resets and always passes, as before.
      const lg = ctx.engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD)
      if (!decideLoopGuard(lg, i.channel, i.role, now(), coord.loopGuardOpts).allow) return

      const policy = resolveResponderPolicy(coord.cfg)
      const self: ResponderSelf = { agentKey: coord.agentKey, isOwnerBot: coord.isOwnerBot }
      let deferMs = preferredResponderDelayMs(policy, self, coord.cfg)

      // Mesh mode: deterministic election decides WHO answers cross-machine (no atomic
      // lock). The rank sets the failover delay; an ineligible agent stands down.
      if (opts.election) {
        const rank = opts.election.rankFor(i.channel, messageId, text, coord.agentKey)
        if (rank === undefined) return // not eligible to answer this message
        deferMs = rank * (opts.election.stepMs ?? MESH_FAILOVER_STEP_MS)
      }

      const attempt = async () => {
        // Mesh stand-down: a peer already took this message (its designation reached us
        // over the mesh) → yield. This is the cross-machine exactly-one guarantee; the
        // rank delay ensures the winner posts its designation before a loser's timer fires.
        if (opts.election?.alreadyDesignated(i.channel, messageId, coord.agentKey)) return
        // 1) Reply election — which AGENT answers (holder = agentKey).
        const reply = await ctx.store.acquireClaim(
          replyClaimKey(i.channel, messageId),
          coord.agentKey,
          ttl,
        )
        if (!reply.acquired) return // another agent already won the reply
        // 2) Drive election — which RELAY drives this agent's turn (holder = relayId).
        const drive = await ctx.store.acquireClaim(
          driveClaimKey(i.channel, coord.agentKey, messageId),
          coord.relayId,
          ttl,
        )
        if (!drive.acquired) return // another relay of the same agent is driving

        await ctx.admit({
          actor: coord.agentKey,
          role: 'agent' as Role,
          channel: i.channel,
          target: { artifactId: i.target.artifactId, anchor: { kind: 'none' } },
          verb: 'turn.prompted',
          patch: { kind: 'none' },
          effect: 'pure',
          caused_by: [i.hash],
        })

        // U3: record the designation on the board so peers see this agent has the
        // message and don't re-knock — the structural backstop for "others, stay quiet".
        await ctx.admit({
          actor: coord.agentKey,
          role: 'agent' as Role,
          channel: i.channel,
          target: { artifactId: coordArtifact(i.channel), anchor: { kind: 'none' } },
          verb: 'coord.note',
          patch: { kind: 'coord', note: { type: 'designation', agentKey: coord.agentKey, ref: messageId } },
          effect: 'pure',
          caused_by: [i.hash],
        })
      }

      if (deferMs <= 0) {
        await attempt()
      } else {
        // Non-preferred agent: wait the policy window, then step in only if the
        // preferred agent never claimed. Detached (out-of-wave admit is safe).
        defer(() => {
          attempt().catch(err =>
            process.stderr.write(`reply-claim deferred attempt failed: ${err}\n`),
          )
        }, deferMs)
      }
    },
  }
}
