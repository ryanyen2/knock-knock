/**
 * ClaudeSdkAdapter — the ONLY module that imports or calls the Claude Agent SDK.
 * The relay and driver never see the SDK; they see the AgentAdapter interface.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKSystemMessage, SDKResultSuccess, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAdapter, PermissionProfile, Verdict } from '../agent-adapter.ts'

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
