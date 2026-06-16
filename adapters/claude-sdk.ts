/**
 * ClaudeSdkAdapter — the ONLY module that imports or calls the Claude Agent SDK.
 * The relay and driver never see the SDK; they see the AgentAdapter interface.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  SDKSystemMessage,
  SDKResultSuccess,
  SDKAssistantMessage,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentAdapter,
  AgentEvent,
  PermissionProfile,
  Verdict,
  WatchToolHandlers,
} from '../agent-adapter.ts'
import { makeWatchMcpServer, WATCH_TOOL_NAMES } from './watch-mcp.ts'

export class ClaudeSdkAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void
  private readonly mcpServers?: Record<string, McpServerConfig>
  private readonly alwaysAllow: string[]

  constructor(private readonly cwd: string, watchTools?: WatchToolHandlers) {
    // The watch MCP server (if the host wired callbacks) lets the agent arm
    // watches by calling a tool. The tool calls auto-allow so arming is smooth;
    // the *command* a watch runs is deny-floored by the host before it runs.
    if (watchTools) {
      this.mcpServers = { 'knock-knock': makeWatchMcpServer(watchTools) }
      this.alwaysAllow = WATCH_TOOL_NAMES
    } else {
      this.alwaysAllow = []
    }
  }

  applyPolicy(profile: PermissionProfile): void {
    this.profile = profile
  }

  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void {
    this.permHandler = handler
  }

  onEvent(handler: (event: AgentEvent) => void): void {
    this.eventHandler = handler
  }

  private emit(event: AgentEvent): void {
    try {
      this.eventHandler?.(event)
    } catch {
      // A bad subscriber must never break the turn.
    }
  }

  async prompt(input: {
    text: string
    sessionId?: string
    signal?: AbortSignal
  }): Promise<{ sessionId: string; text: string }> {
    let sessionId = ''
    let text = ''
    const startedAt = Date.now()

    // Bridge the relay's AbortSignal to the SDK's AbortController so a 🛑 stops
    // the query promptly.
    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) abortController.abort()
      else input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

    // One query run, optionally resuming a session. Extracted so a failed resume
    // (invalid/expired/deleted session id) can fall back to a fresh session.
    const runOnce = async (resumeId?: string): Promise<void> => {
      const result = query({
        prompt: input.text,
        options: {
          cwd: this.cwd,
          permissionMode: 'default',
          abortController,
          allowedTools: [...this.profile.allow, ...this.alwaysAllow],
          // deny is the hard floor — must reach the SDK here, not via canUseTool alone
          disallowedTools: this.profile.deny,
          ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
          // Isolation mode: prevent the SDK from loading .mcp.json, CLAUDE.md, or
          // any project/local settings from the workspace cwd. The relay passes all
          // policy programmatically; stray disk config is the bug this guards against.
          settingSources: [],
          ...(resumeId ? { resume: resumeId } : {}),
          canUseTool: async (toolName, toolInput) => {
            const handler = this.permHandler
            if (!handler) {
              return { behavior: 'deny' as const, message: 'No approval handler registered.' }
            }
            const verdict = await handler({ toolName, input: toolInput })
            // On allow, echo the (unmodified) input back as `updatedInput`. The
            // SDK's control protocol validates the permission result and a bare
            // `{behavior:'allow'}` can be rejected — surfacing to the agent as a
            // tool error the moment the owner approves. Echoing the input is the
            // documented "approve unchanged" shape.
            return verdict.behavior === 'allow'
              ? { behavior: 'allow' as const, updatedInput: toolInput }
              : { behavior: 'deny' as const, message: verdict.message }
          },
        },
      })
      for await (const msg of result) {
        this.translate(msg, startedAt)
        if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
          sessionId = msg.session_id
        } else if (msg.type === 'result' && (msg as SDKResultSuccess).subtype === 'success') {
          const r = msg as SDKResultSuccess
          sessionId = r.session_id
          text = r.result
        } else if (msg.type === 'assistant' && !text) {
          // Accumulate assistant text as fallback if result.result is not populated
          const a = msg as SDKAssistantMessage
          const content = a.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && 'text' in block) {
                text += (block as { type: 'text'; text: string }).text
              }
            }
          }
        }
      }
    }

    try {
      await runOnce(input.sessionId)
    } catch (err) {
      // Aborting the query (owner 🛑) surfaces as a throw — return whatever
      // text we had rather than failing the turn.
      if (abortController.signal.aborted) {
        return { sessionId, text: text.trim() || '(no response)' }
      }
      // A resume that produced nothing is almost certainly an invalid/expired
      // session id (the binding outlived the session). Degrade gracefully to a
      // fresh session — matching the ACP adapter's load-failure fallback —
      // rather than failing the turn. Skip if the owner aborted (don't start a
      // fresh session just to cancel it), and don't let the retry's own failure
      // escape unlabeled.
      if (input.sessionId && !sessionId && !text && !abortController.signal.aborted) {
        process.stderr.write(
          `claude-sdk: resume ${input.sessionId.slice(0, 8)} failed (${err}); starting a fresh session\n`,
        )
        try {
          await runOnce(undefined)
        } catch (freshErr) {
          if (!abortController.signal.aborted) throw freshErr
        }
      } else if (!abortController.signal.aborted) {
        throw err
      }
    }

    return { sessionId, text: text.trim() || '(no response)' }
  }

  /** Translate one SDK stream message into the structured event the host listens for. */
  private translate(m: any, startedAt: number): void {
    switch (m?.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.emit({
            type: 'session_init',
            sessionId: m.session_id,
            model: m.model,
            tools: Array.isArray(m.tools) ? m.tools.length : undefined,
            cwd: m.cwd,
          })
        }
        return
      case 'assistant':
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text') {
            this.emit({ type: 'assistant_text', text: block.text })
          } else if (block.type === 'tool_use') {
            this.emit({
              type: 'tool_call',
              toolCallId: block.id,
              name: block.name,
              input: block.input,
            })
          }
        }
        return
      case 'user': {
        // Tool result(s) — SDK ships them as user-typed messages containing tool_result blocks.
        const content = m.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              this.emit({
                type: 'tool_result',
                toolCallId: block.tool_use_id,
                status: block.is_error ? 'failed' : 'completed',
              })
            }
          }
        }
        return
      }
      case 'result':
        this.emit({
          type: 'turn_done',
          tokensIn: m.usage?.input_tokens,
          tokensOut: m.usage?.output_tokens,
          costUsd: m.total_cost_usd,
          turns: m.num_turns,
          durationMs: Date.now() - startedAt,
        })
        return
    }
  }
}
