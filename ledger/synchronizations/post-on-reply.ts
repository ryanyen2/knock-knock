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

import type { Synchronization } from '../sync.ts'
import { withClaim } from '../artifacts/external.ts'

export type PostOnReplyOpts = {
  /**
   * Send a chunk to Discord. Returns the posted message id (best-effort).
   * Failures throw — the claim is released on throw via withClaim's finally.
   */
  discordSend: (channelId: string, text: string) => Promise<string | undefined>
  /** TTL for the claim while we're posting. */
  claimTtlMs?: number
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
          await opts.discordSend(i.channel, text)
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
