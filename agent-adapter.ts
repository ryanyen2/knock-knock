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

export interface AgentAdapter {
  /** Map allow/ask/deny onto the runtime's native mechanism. deny = hard floor. */
  applyPolicy(profile: PermissionProfile): void

  /** Register the handler the adapter calls when a tool needs interactive approval. */
  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void

  /**
   * Run one turn. Resume the prior session if sessionId is given.
   * Returns the (new) sessionId and the agent's final text.
   */
  prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }>
}
