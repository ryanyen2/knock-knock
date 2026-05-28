/**
 * Adapter factory — the single point where an agent's `runtime` becomes a live
 * AgentAdapter. relay.ts, agent-host.ts, driver.ts, and lib.ts stay free of any
 * agent SDK; only the adapters and this factory import one.
 *
 * Two transports, one interface:
 *   claude-sdk   in-process Claude Agent SDK (no install)
 *   <the rest>   ACP over stdio — one AcpAdapter, the agent chosen by the
 *                spawn command (Claude Code, OpenCode, Codex, Gemini, Cursor…)
 *
 * `npx -y` resolves an ACP server on first run, so there is nothing to install
 * globally beyond the underlying agent's auth. For an agent without a preset,
 * set runtime `acp` and provide KNOCK_KNOCK_ACP_COMMAND / KNOCK_KNOCK_ACP_ARGS.
 */

import type { AgentAdapter } from '../agent-adapter.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'
import { AcpAdapter, type AcpLaunch } from './acp.ts'

/** Built-in ACP launch presets, keyed by an agent's `runtime`. */
const ACP_PRESETS: Record<string, AcpLaunch> = {
  // Claude Code over ACP (alternative to the in-process claude-sdk adapter).
  'claude-acp': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  // OpenCode speaks ACP natively.
  opencode: { command: 'opencode', args: ['acp'] },
  // OpenAI Codex via the community ACP server.
  codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
  // Google Gemini CLI's experimental ACP mode.
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
}

export function makeAdapter(runtime: string, opts: { workspace: string }): AgentAdapter {
  // Explicit command override (for an agent without a preset).
  const override = process.env.KNOCK_KNOCK_ACP_COMMAND
  if (runtime === 'acp' && override) {
    const args = process.env.KNOCK_KNOCK_ACP_ARGS?.split(' ').filter(Boolean) ?? []
    return new AcpAdapter({ command: override, args }, opts.workspace)
  }

  const preset = ACP_PRESETS[runtime]
  if (preset) return new AcpAdapter(preset, opts.workspace)

  return new ClaudeSdkAdapter(opts.workspace)
}
