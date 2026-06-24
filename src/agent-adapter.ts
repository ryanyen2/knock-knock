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

/** Per-turn runtime knobs from the thread config. claude-sdk honors them; ACP self-manages and ignores. Omitted field leaves the default unchanged. */
export type TurnOptions = {
  /** Model id, e.g. "claude-opus-4-8". */
  model?: string
  /** Extended-thinking mode: 'off' | 'auto' | 'high' (the adapter maps it). */
  thinking?: string
  /** Reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. */
  effort?: string
}

/** Structured progress events emitted by an adapter while a turn runs; the host feeds them into the terminal renderer and owner DM courier. */
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

/** Channel/agent-bound callbacks the host injects into a runtime exposing a "watch" tool. Plain functions only (no SDK type crosses this seam); the command is deny-floored by the host inside `arm`. */
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
   * Run one turn (resume the prior session if sessionId is given); returns the new sessionId and final text.
   * `signal` aborts promptly (owner 🛑); an adapter that can't cancel may ignore it (the relay still suppresses the reply).
   */
  prompt(input: {
    text: string
    sessionId?: string
    signal?: AbortSignal
    /** Per-turn knobs. claude-sdk honors; ACP ignores. Omit to leave the default. */
    options?: TurnOptions
  }): Promise<{ sessionId: string; text: string }>
}
