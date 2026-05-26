/**
 * ClaudeSdkAdapter — the ONLY module that imports or calls the Claude Agent SDK.
 * The relay and driver never see the SDK; they see the AgentAdapter interface.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKSystemMessage, SDKResultSuccess, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAdapter, PermissionProfile, Verdict } from '../agent-adapter.ts'

const DEBUG = process.env.KNOCK_KNOCK_DEBUG === '1'

function preview(v: unknown, n = 120): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** Log one SDK stream message to stderr. Proves the reply came from a real
 *  Claude turn: you'll see model + session id + tool calls + token usage. */
function logSdkMessage(m: any): void {
  if (!DEBUG) return
  switch (m?.type) {
    case 'system':
      if (m.subtype === 'init') {
        process.stderr.write(
          `[sdk] init · model=${m.model} · session=${m.session_id} · cwd=${m.cwd} · tools=${m.tools?.length ?? '?'}\n`,
        )
      }
      break
    case 'assistant':
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text') process.stderr.write(`[sdk] assistant: ${preview(block.text)}\n`)
        else if (block.type === 'tool_use') process.stderr.write(`[sdk] tool_use: ${block.name}(${preview(block.input)})\n`)
      }
      break
    case 'user':
      process.stderr.write(`[sdk] tool result received\n`)
      break
    case 'result':
      process.stderr.write(
        `[sdk] result · ${m.subtype} · turns=${m.num_turns} · ` +
          `tokens(in/out)=${m.usage?.input_tokens ?? '?'}/${m.usage?.output_tokens ?? '?'} · cost_usd=${m.total_cost_usd ?? '?'}\n`,
      )
      break
  }
}

export class ClaudeSdkAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>

  constructor(private readonly cwd: string) {}

  applyPolicy(profile: PermissionProfile): void {
    this.profile = profile
  }

  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void {
    this.permHandler = handler
  }

  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    let sessionId = ''
    let text = ''

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
      logSdkMessage(msg)
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
}
