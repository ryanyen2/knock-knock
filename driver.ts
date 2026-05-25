/**
 * Driver — one live agent conversation.
 * Owns a sessionId, a per-session turn queue (so concurrent messages can't
 * race), and one AgentAdapter. The relay holds Drivers in its routing table;
 * a Driver never holds other Drivers.
 */

import type { AgentAdapter, PermissionProfile, Verdict } from './agent-adapter.ts'
import { chunk } from './lib.ts'

export type TurnMeta = {
  senderId: string
  kind: 'owner' | 'human' | 'agent' | 'unknown'
  messageId: string
  ts: string
  channelId: string
}

const CHUNK_LIMIT = 1900
const CHUNK_MODE = 'newline' as const

export class Driver {
  private sessionId?: string
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly sessionKey: string,
    profile: PermissionProfile,
    permissionHandler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ) {
    adapter.applyPolicy(profile)
    adapter.onPermissionRequest(permissionHandler)
  }

  /** Enqueue a turn; runs serially so concurrent messages don't corrupt session state. */
  runTurn(text: string, _meta: TurnMeta): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      this.queue = this.queue.then(async () => {
        try {
          const result = await this.adapter.prompt({ text, sessionId: this.sessionId })
          this.sessionId = result.sessionId
          resolve(chunk(result.text, CHUNK_LIMIT, CHUNK_MODE))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`driver[${this.sessionKey}]: turn error: ${err}\n`)
          resolve([`Error: ${msg}`])
        }
      })
    })
  }
}
