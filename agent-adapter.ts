/**
 * AgentAdapter seam — the interface the relay and driver use to talk to any
 * agent runtime. No SDK imports here; this module is the contract only. Adding
 * a runtime means writing a new adapter against this interface, nothing else.
 */

import type { WatchSpec } from './lib.ts'

export type PermissionProfile = {
  allow: string[]
  ask: string[]
  deny: string[]
}

export type Verdict = { behavior: 'allow' } | { behavior: 'deny'; message: string }

/**
 * Structured progress events emitted by an adapter while a turn runs. The host
 * subscribes via onEvent and feeds them into the terminal renderer and the
 * owner DM courier so the operator can see what the agent is doing in real
 * time — without parsing stderr or enabling KNOCK_KNOCK_DEBUG.
 */
export type AgentEvent =
  | { type: 'session_init'; sessionId: string; model?: string; tools?: number; cwd?: string }
  | { type: 'assistant_text'; text: string }
  | {
      type: 'tool_call'
      toolCallId?: string
      name: string
      kind?: string
      title?: string
      input: unknown
    }
  | {
      type: 'tool_result'
      toolCallId?: string
      status: 'completed' | 'failed' | 'pending'
    }
  | {
      type: 'turn_done'
      tokensIn?: number
      tokensOut?: number
      costUsd?: number
      turns?: number
      durationMs?: number
    }

/** The watch fields an agent supplies; the host fills in channel + agentKey. */
export type WatchArmPartial = Omit<WatchSpec, 'channel' | 'agentKey'>

/**
 * Channel/agent-bound callbacks the host injects into a runtime that can expose
 * a "watch" tool (today: the in-process SDK adapter, via adapters/watch-mcp.ts).
 * Plain functions only — no SDK type crosses this seam, so the host stays
 * SDK-free. The command a watch runs is deny-floored by the host inside `arm`.
 */
export type WatchToolHandlers = {
  arm: (spec: WatchArmPartial) => Promise<{ ok: boolean; message: string }>
  disarm: (name: string) => Promise<{ ok: boolean; message: string }>
  list: () => Promise<string>
}

export interface AgentAdapter {
  /** Map allow/ask/deny onto the runtime's native mechanism. deny = hard floor. */
  applyPolicy(profile: PermissionProfile): void

  /** Register the handler the adapter calls when a tool needs interactive approval. */
  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void

  /** Subscribe to progress events. At most one handler; later calls replace it. */
  onEvent(handler: (event: AgentEvent) => void): void

  /**
   * Run one turn. Resume the prior session if sessionId is given.
   * Returns the (new) sessionId and the agent's final text.
   *
   * `signal` (optional) aborts the turn promptly — the relay fires it when the
   * owner reacts 🛑. An adapter that can cancel should stop its work and return
   * whatever text it has; one that can't may ignore it (the relay still
   * suppresses the reply).
   */
  prompt(input: {
    text: string
    sessionId?: string
    signal?: AbortSignal
  }): Promise<{ sessionId: string; text: string }>
}
