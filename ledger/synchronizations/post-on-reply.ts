/**
 * post-on-reply — Phase 3 outbound inversion.
 *
 * Fires on admitted `turn.replied`. Acquires a claim on the channel's
 * external-proxy artifact, invokes the injected `discordSend` callback for
 * each chunk, releases the claim. The claim primitive serializes two
 * concurrent post attempts at the same channel (e.g., a second relay host
 * sharing the same ledger after Phase 4 cross-machine).
 *
 * The post itself is a side effect with no follow-on Interaction in
 * Phase 3 — the turn.replied IS the canonical record. If we later want
 * delivery confirmation in the ledger, an `external.posted` verb (Phase
 * 4) can journal the resulting Discord message id.
 */

import type { Synchronization, SyncCtx } from '../sync.ts'
import type { Interaction } from '../interaction.ts'
import type { Store } from '../store.ts'
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
  /**
   * Send a chunk to Discord. Returns the posted message id (best-effort).
   * Failures throw — the claim is released on throw via withClaim's finally.
   */
  discordSend: (channelId: string, text: string) => Promise<string | undefined>
  /** TTL for the claim while we're posting. */
  claimTtlMs?: number
  /**
   * Map an actor id to a display handle for the §4.3 attribution line.
   * Defaults to the raw id when omitted.
   */
  resolveActorName?: ResolveName
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

      // §4.3 + §4.6 — annotate the reply with already-captured ledger facts.
      // The ⚠️ stale flag (a warning) comes first; the small attribution
      // subtext (§4.3) sits last under the reply.
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

      // Claim is on the channel's external-proxy artifact — same artifactId
      // the turn.replied targets, so concurrent posts to the same channel
      // serialize at the store layer.
      const result = await withClaim(
        ctx.store,
        i.target.artifactId,
        i.hash,
        async () => {
          // Phase 3 ships text as-is (Driver already chunked under
          // CHUNK_LIMIT for Discord). A future split-on-paragraph helper
          // could subdivide here if turn.replied carries an over-long text.
          await opts.discordSend(i.channel, finalText)
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

/**
 * Walk the reply's causal parents for the §4.3 attribution line:
 * turn.replied.caused_by = [promptHash, ...executedToolHashes]. The prompt's
 * own first parent is the originating channel.message — that's who/when the
 * turn was "traced from". Returns undefined when the chain isn't fully
 * captured (e.g. a synthetic reply with no parents).
 */
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
    // Everything after the prompt hash is an executed tool (turn-recorder).
    toolCount: Math.max(0, replied.caused_by.length - 1),
  }
}

/**
 * Stale knowledge the replying agent holds, for the §4.6 flag. Degrades
 * silently to "none" if the Knowledge fold isn't registered on this engine —
 * §4.6 is then simply off, the rest of the post still ships.
 */
function collectStaleNotes(ctx: SyncCtx, agentKey: string): { body: string }[] {
  let state: KnowledgeFoldState
  try {
    state = ctx.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
  } catch {
    return []
  }
  return staleNotesForActor(state, agentKey).map(sn => ({ body: sn.note.body }))
}
