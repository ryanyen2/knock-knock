/**
 * Adapter factory — the single point where an agent name becomes a runtime.
 * This is the only sanctioned relay-side change for multi-runtime support;
 * relay.ts/driver.ts/lib.ts and the AgentAdapter interface stay untouched.
 *
 * Three transports, one interface:
 *   claude-sdk    in-process Claude Agent SDK (pull iterator, no install)
 *   opencode-http out-of-process OpenCode over HTTP + SSE (legacy/experimental)
 *   <the rest>    ACP over stdio — one AcpAdapter, agent chosen by launch command
 *
 * ACP unlocks every ACP-speaking agent (Claude Code, OpenCode, Codex, Gemini,
 * Cursor, …) behind the same seam. Select with KNOCK_KNOCK_AGENT; override the
 * spawn command with KNOCK_KNOCK_ACP_COMMAND / KNOCK_KNOCK_ACP_ARGS for an
 * agent without a built-in preset.
 */

import type { AgentAdapter } from '../agent-adapter.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'
import { OpenCodeAdapter } from './opencode.ts'
import { AcpAdapter, type AcpLaunch } from './acp.ts'

/** Built-in ACP launch presets. `npx -y` resolves the adapter on first run so
 *  there's nothing to install globally beyond the underlying agent's auth. */
const ACP_PRESETS: Record<string, AcpLaunch> = {
  // Claude Code over ACP (alternative to the in-process claude-sdk adapter).
  'claude-acp': { command: 'npx', args: ['-y', '@zed-industries/claude-code-acp'] },
  // OpenCode speaks ACP natively.
  opencode: { command: 'opencode', args: ['acp'] },
  // OpenAI Codex via the community ACP server.
  codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
  // Google Gemini CLI's experimental ACP mode.
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
}

export function makeAdapter(name: string, opts: { workspace: string }): AgentAdapter {
  // Explicit command override (for Cursor or any agent without a preset).
  const override = process.env.KNOCK_KNOCK_ACP_COMMAND
  if (name === 'acp' && override) {
    const args = process.env.KNOCK_KNOCK_ACP_ARGS?.split(' ').filter(Boolean) ?? []
    return new AcpAdapter({ command: override, args }, opts.workspace)
  }

  const preset = ACP_PRESETS[name]
  if (preset) return new AcpAdapter(preset, opts.workspace)

  switch (name) {
    case 'opencode-http':
      return new OpenCodeAdapter(opts.workspace)
    case 'claude-sdk':
    default:
      return new ClaudeSdkAdapter(opts.workspace)
  }
}
