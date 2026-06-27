/** post-on-reply — on admitted `turn.replied`, post each chunk to the channel
 *  under a per-channel claim so concurrent relays don't double-post. */

import type { Synchronization, SyncCtx } from '../sync.ts'
import type { Interaction } from '../interaction.ts'
import type { Store } from '../store.ts'
import { chunk } from '../../lib.ts'
import { withClaim } from '../artifacts/external.ts'
import {
  KNOWLEDGE_FOLD,
  staleNotesForActor,
  type KnowledgeFoldState,
} from '../artifacts/knowledge.ts'
import {
  renderAttributionLine,
  renderStaleFlag,
  type AttributionFacts,
  type ResolveName,
} from '../render/reply-annotations.ts'

export type PostOnReplyOpts = {
  /** Send a chunk; returns the posted message id (best-effort). Failures throw. `agentKey`
   *  is the replying agent (the `turn.replied` actor) — with co-resident bots in one room
   *  the reply MUST post via that agent's host, not just any host serving the channel, or
   *  the wrong bot posts the reply (the "@cc → d-bot answers" bug). */
  discordSend: (channelId: string, text: string, agentKey: string) => Promise<string | undefined>
  /** The platform's hard message-length cap for a channel; falls back to the default. */
  maxMessageLength?: (channelId: string) => number | undefined
  /** TTL for the claim while posting. */
  claimTtlMs?: number
  /** Map an actor id to a display handle for the attribution line. */
  resolveActorName?: ResolveName
}

/** Fallback when the platform cap is unknown — Discord's 2000, less a margin. */
const DEFAULT_LIMIT = 1900
/** Stay this far under the platform's hard cap (annotations are appended). */
const SAFETY_MARGIN = 100

/** Effective chunk width: the platform cap minus a margin, floored above zero. */
export function chunkLimitFor(cap: number | undefined): number {
  if (!cap || cap <= 0) return DEFAULT_LIMIT
  return Math.max(280, cap - SAFETY_MARGIN)
}

export function postOnReply(opts: PostOnReplyOpts): Synchronization {
  const ttl = opts.claimTtlMs ?? 30_000
  return {
    name: 'post-on-reply',
    matches: i =>
      i.verb === 'turn.replied' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
      if (i.patch.kind !== 'external') return
      const args = i.patch.intent.args as { text?: string } | undefined
      const text = args?.text?.trim()
      if (!text) return

      // Annotate: stale flag first, attribution subtext last.
      const annotations: string[] = []
      const stale = renderStaleFlag(collectStaleNotes(ctx, i.actor))
      if (stale) annotations.push(stale)
      const attribution = renderAttributionLine(
        await buildAttributionFacts(ctx.store, i),
        opts.resolveActorName,
      )
      if (attribution) annotations.push(attribution)
      const finalText = annotations.length
        ? `${text}\n\n${annotations.join('\n')}`
        : text

      // Claim on the channel's external-proxy artifact serializes concurrent posts.
      const result = await withClaim(
        ctx.store,
        i.target.artifactId,
        i.hash,
        async () => {
          // Split to stay under the platform's hard limit; sent sequentially.
          const limit = chunkLimitFor(opts.maxMessageLength?.(i.channel))
          for (const part of chunk(finalText, limit, 'newline')) {
            await opts.discordSend(i.channel, part, i.actor)
          }
        },
        ttl,
      )
      if (!result.acquired) {
        process.stderr.write(
          `post-on-reply: could not claim ${i.target.artifactId} (held by ${result.currentHolder?.slice(0, 10)})\n`,
        )
      }
    },
  }
}

/** Walk the reply's causal parents (prompt → originating message) for the
 *  attribution line; undefined when the chain isn't fully captured. */
async function buildAttributionFacts(
  store: Store,
  replied: Interaction,
): Promise<AttributionFacts | undefined> {
  const promptHash = replied.caused_by[0]
  if (!promptHash) return undefined
  const prompt = await store.getByHash(promptHash)
  const inboundHash = prompt?.caused_by[0]
  if (!inboundHash) return undefined
  const inbound = await store.getByHash(inboundHash)
  if (!inbound) return undefined
  return {
    originActor: inbound.actor,
    originTs: inbound.createdAt,
    // Everything after the prompt hash is an executed tool.
    toolCount: Math.max(0, replied.caused_by.length - 1),
  }
}

/** Stale knowledge the replying agent holds; degrades to none if the fold is absent. */
function collectStaleNotes(ctx: SyncCtx, agentKey: string): { body: string }[] {
  let state: KnowledgeFoldState
  try {
    state = ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
  } catch {
    return []
  }
  return staleNotesForActor(state, agentKey).map(sn => ({ body: sn.note.body }))
}
