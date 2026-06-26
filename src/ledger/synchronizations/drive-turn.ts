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
      if (!inboundHash) return // ill-formed prompt (no parent) — skip
      const inbound = await opts.getByHash(inboundHash)
      if (!inbound) return

      let promptText: string
      let messageId: string
      if (inbound.patch.kind === 'external') {
        // Normal inbound (channel.message) or a watch.fired wake.
        const args = inbound.patch.intent.args as { text?: string; messageId?: string } | undefined
        promptText = args?.text ?? ''
        messageId = args?.messageId ?? inboundHash.slice(0, 10)
      } else if (inbound.patch.kind === 'task') {
        // Scheduler wake (Problem C): the parent is the task.created op — synthesize a
        // prompt from the task so the owner knows what to work on.
        const d = inbound.patch.data
        promptText = `You have been allocated task "${d.id}"${d.label ? `: ${d.label}` : ''}. Work on it now; coordinate with peers via the shared board.`
        messageId = inboundHash.slice(0, 10)
      } else {
        return // unsupported parent — skip
      }

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
