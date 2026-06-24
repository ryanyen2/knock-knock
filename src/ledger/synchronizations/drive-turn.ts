/** drive-turn — on admitted `turn.prompted`, pull the originating
 *  channel.message and call Driver.runTurn via host-injected callbacks. */

import type { Synchronization } from '../sync.ts'
import type { Interaction, Hash } from '../interaction.ts'

export type DriveTurnHandle = {
  /** Run the adapter end-to-end for this turn. */
  run(opts: {
    promptHash: Hash
    inboundHash: Hash
    promptText: string
    senderId: string
    senderKindKind: 'owner' | 'human' | 'agent'
    messageId: string
    ts: string
  }): Promise<{ chunks: string[]; error?: string }>
}

export type DriveTurnOpts = {
  /** Resolve the handle owning the adapter + recorder for this channel. */
  getDriveHandle: (channelId: string) => DriveTurnHandle | undefined
  /** Look up an admitted interaction by hash. */
  getByHash: (hash: Hash) => Promise<Interaction | undefined>
}

export function driveTurn(opts: DriveTurnOpts): Synchronization {
  return {
    name: 'drive-turn',
    matches: i =>
      i.verb === 'turn.prompted' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (prompted, _ctx) => {
      const handle = opts.getDriveHandle(prompted.channel)
      if (!handle) return // no live agent — nothing to drive

      const inboundHash = prompted.caused_by[0]
      if (!inboundHash) return // ill-formed prompt (no parent message) — skip
      const inbound = await opts.getByHash(inboundHash)
      if (!inbound || inbound.patch.kind !== 'external') return

      const args = inbound.patch.intent.args as { text?: string; messageId?: string } | undefined
      const promptText = args?.text ?? ''
      const messageId = args?.messageId ?? inboundHash.slice(0, 10)

      const kind: 'owner' | 'human' | 'agent' =
        inbound.role === 'owner' || inbound.role === 'human' || inbound.role === 'agent'
          ? inbound.role
          : 'agent'

      await handle.run({
        promptHash: prompted.hash,
        inboundHash,
        promptText,
        senderId: inbound.actor,
        senderKindKind: kind,
        messageId,
        ts: inbound.createdAt,
      })
    },
  }
}
