/**
 * ClaudeSdkAdapter — the ONLY module that imports or calls the Claude Agent SDK.
 * The relay and driver never see the SDK; they see the AgentAdapter interface.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKSystemMessage, SDKResultSuccess, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAdapter, AgentEvent, PermissionProfile, Verdict } from '../agent-adapter.ts'

export class ClaudeSdkAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void

  constructor(private readonly cwd: string) {}

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

  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    let sessionId = ''
    let text = ''
    const startedAt = Date.now()

    const result = query({
      prompt: input.text,
      options: {
        cwd: this.cwd,
        permissionMode: 'default',
        allowedTools: this.profile.allow,
        // deny is the hard floor — must reach the SDK here, not via canUseTool alone
        disallowedTools: this.profile.deny,
        // Isolation mode: prevent the SDK from loading .mcp.json, CLAUDE.md, or
        // any project/local settings from the workspace cwd. The relay passes all
        // policy programmatically; stray disk config is the bug this guards against.
        settingSources: [],
        ...(input.sessionId ? { resume: input.sessionId } : {}),
        canUseTool: async (toolName, toolInput) => {
          const handler = this.permHandler
          if (!handler) {
            return { behavior: 'deny' as const, message: 'No approval handler registered.' }
          }
          const verdict = await handler({ toolName, input: toolInput })
          return verdict.behavior === 'allow'
            ? { behavior: 'allow' as const }
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
