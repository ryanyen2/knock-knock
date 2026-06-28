/**
 * ClaudeSdkAdapter — the ONLY module that imports or calls the Claude Agent SDK.
 * The relay and driver never see the SDK; they see the AgentAdapter interface.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  TurnOptions,
  Verdict,
  WatchToolHandlers,
  ShareToolHandlers,
} from '../agent-adapter.ts'
import { pickAnthropicEnv, toThinkingConfig } from '../lib.ts'
import { makeWatchMcpServer, WATCH_TOOL_NAMES } from './watch-mcp.ts'
import { makeNotionMcpServer, NOTION_TOOL_NAMES, NOTION_MCP_SERVER } from './notion-mcp.ts'
import { makeShareMcpServer, SHARE_TOOL_NAMES, SHARE_MCP_SERVER } from './share-mcp.ts'

/** Optional page-scoped Notion read/write tools for a Notion-platform bot. */
export type NotionToolConfig = { token: string; pageId: string }

/** Env for the SDK subprocess: process.env plus the Anthropic auth/gateway keys
 *  from the global settings.json env block (isolation mode doesn't read it). */
function resolveSdkEnv(): Record<string, string | undefined> {
  let fromSettings: Record<string, string> = {}
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      env?: Record<string, unknown>
    }
    fromSettings = pickAnthropicEnv(parsed.env)
  } catch {
    // No/unreadable global settings — rely on process.env alone.
  }
  return { ...process.env, ...fromSettings }
}

export class ClaudeSdkAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void
  private readonly mcpServers?: Record<string, McpServerConfig>
  private readonly alwaysAllow: string[]
  private readonly env = resolveSdkEnv()

  constructor(
    private readonly cwd: string,
    watchTools?: WatchToolHandlers,
    notion?: NotionToolConfig,
    shareTools?: ShareToolHandlers,
  ) {
    // In-process MCP servers: the watch tool (arm/disarm), the share_file tool, and, for a
    // Notion bot, the page-scoped read/write tools. All stay deny-floored / classified by
    // the host; their tool names are auto-allowed so the agent isn't prompted to use its own seam.
    const servers: Record<string, McpServerConfig> = {}
    const allow: string[] = []
    if (watchTools) {
      servers['knock-knock'] = makeWatchMcpServer(watchTools)
      allow.push(...WATCH_TOOL_NAMES)
    }
    if (shareTools) {
      servers[SHARE_MCP_SERVER] = makeShareMcpServer(shareTools)
      allow.push(...SHARE_TOOL_NAMES)
    }
    if (notion) {
      servers[NOTION_MCP_SERVER] = makeNotionMcpServer(notion.token, notion.pageId)
      allow.push(...NOTION_TOOL_NAMES)
    }
    if (Object.keys(servers).length > 0) this.mcpServers = servers
    this.alwaysAllow = allow
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
    options?: TurnOptions
  }): Promise<{ sessionId: string; text: string }> {
    let sessionId = ''
    let text = ''
    const startedAt = Date.now()

    // Per-turn knobs (owner !config), each omitted when unset.
    const opts = input.options ?? {}
    const thinkingCfg = toThinkingConfig(opts.thinking)
    const turnOptionFields = {
      ...(opts.model ? { model: opts.model } : {}),
      ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
      ...(opts.effort ? { effort: opts.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    }

    // Bridge the relay's AbortSignal to the SDK's AbortController (🛑 stop).
    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) abortController.abort()
      else input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

    // One query run, optionally resuming a session; a failed resume falls back to fresh.
    const runOnce = async (resumeId?: string): Promise<void> => {
      const result = query({
        prompt: input.text,
        options: {
          cwd: this.cwd,
          permissionMode: 'default',
          abortController,
          // Inject gateway/auth env — isolation mode doesn't read global settings.json.
          env: this.env,
          ...turnOptionFields,
          allowedTools: [...this.profile.allow, ...this.alwaysAllow],
          // deny is the hard floor — must reach the SDK here, not via canUseTool alone.
          disallowedTools: this.profile.deny,
          ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
          // Isolation mode: don't load disk config from cwd; all policy passed programmatically.
          settingSources: [],
          ...(resumeId ? { resume: resumeId } : {}),
          canUseTool: async (toolName, toolInput) => {
            const handler = this.permHandler
            if (!handler) {
              return { behavior: 'deny' as const, message: 'No approval handler registered.' }
            }
            const verdict = await handler({ toolName, input: toolInput })
            // On allow, echo input back as updatedInput — the documented "approve unchanged" shape.
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
          // Fallback accumulation when result.result isn't populated.
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
      // Abort (owner 🛑) surfaces as a throw — return partial text, don't fail the turn.
      if (abortController.signal.aborted) {
        return { sessionId, text: text.trim() || '(no response)' }
      }
      // A resume that produced nothing is likely an invalid/expired id — fall back to fresh.
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
        // Tool results arrive as user messages with tool_result blocks.
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
