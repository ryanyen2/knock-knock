/**
 * drive-turn — Phase 3 adapter driver.
 *
 * Fires on admitted `turn.prompted`. Pulls the originating channel.message
 * (the prompt's caused_by) for the prompt text. Looks up the per-channel
 * session (Driver + adapter + per-turn TurnRecorder) via injected
 * callbacks owned by AgentHost. Calls Driver.runTurn — exactly the same
 * adapter interaction shape Phase 0/1 had — and records turn.replied via
 * the recorder.
 *
 * AgentAdapter byte-for-byte preserved: the adapter sees only
 * applyPolicy/onPermissionRequest/prompt/onEvent. The permission handler
 * inside Driver is what bridges to await-verdict; that lives in AgentHost
 * (it owns the live Approvals service that posts the Discord prompt).
 *
 * This synchronization is the integration seam — most of the actual work
 * still lives in Driver and TurnRecorder. It just glues admitted
 * turn.prompted events to "actually call the adapter."
 */

import type { Synchronization } from '../sync.ts'
import type { Interaction, Hash } from '../interaction.ts'

export type DriveTurnHandle = {
  /** Run the adapter end-to-end for this turn and return the final text. */
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
<<<<<<< Updated upstream:ledger/synchronizations/drive-turn.ts
  /**
   * Resolve a handle that owns the adapter + recorder for this channel.
   * Returns undefined if no agent is registered for the channel.
   */
  getDriveHandle: (channelId: string) => DriveTurnHandle | undefined
  /**
   * Look up an admitted interaction by hash. Used to fetch the originating
   * channel.message via the prompt's caused_by parent for the prompt text.
   */
=======
  /** Resolve the handle for the agent that owns this turn (agentKey = turn actor). */
  getDriveHandle: (channelId: string, agentKey: string) => DriveTurnHandle | undefined
  /** Look up an admitted interaction by hash. */
>>>>>>> Stashed changes:src/ledger/synchronizations/drive-turn.ts
  getByHash: (hash: Hash) => Promise<Interaction | undefined>
}

export function driveTurn(opts: DriveTurnOpts): Synchronization {
  return {
    name: 'drive-turn',
    matches: i =>
      i.verb === 'turn.prompted' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (prompted, _ctx) => {
      const handle = opts.getDriveHandle(prompted.channel, prompted.actor)
      if (!handle) return // no live agent — nothing to drive

      const inboundHash = prompted.caused_by[0]
      if (!inboundHash) return // ill-formed prompt (no parent message) — skip
      const inbound = await opts.getByHash(inboundHash)
      if (!inbound || inbound.patch.kind !== 'external') return

      const args = inbound.patch.intent.args as { text?: string; messageId?: string } | undefined
      const promptText = args?.text ?? ''
      const messageId = args?.messageId ?? inboundHash.slice(0, 10)

      // Translate the inbound's role-in-channel back to the TurnEnvelope
      // kind expected by the adapter context wrap.
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
