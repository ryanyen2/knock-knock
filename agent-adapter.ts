/**
 * AgentAdapter seam — the interface the relay and driver use to talk to any
 * agent runtime. No SDK imports here; this module is the contract only. Adding
 * a runtime means writing a new adapter against this interface, nothing else.
 */

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
   */
  prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }>
}
