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
import type { WatchToolHandlers } from '../agent-adapter.ts'

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

/**
 * Does this runtime expose the in-process watch tool to the agent? Only the SDK
 * adapter does today (ACP agents self-arm via their own MCP config — deferred);
 * the host uses this to decide whether to advertise watches in the preamble.
 * Mirrors the dispatch in makeAdapter.
 */
export function runtimeSelfArmsWatches(runtime: string): boolean {
  if (runtime === 'acp' && process.env.KNOCK_KNOCK_ACP_COMMAND) return false
  if (ACP_PRESETS[runtime]) return false
  return true
}

export function makeAdapter(
  runtime: string,
  opts: { workspace: string; watchTools?: WatchToolHandlers },
): AgentAdapter {
  // Explicit command override (for an agent without a preset).
  const override = process.env.KNOCK_KNOCK_ACP_COMMAND
  if (runtime === 'acp' && override) {
    const args = process.env.KNOCK_KNOCK_ACP_ARGS?.split(' ').filter(Boolean) ?? []
    return new AcpAdapter({ command: override, args }, opts.workspace)
  }

  const preset = ACP_PRESETS[runtime]
  if (preset) return new AcpAdapter(preset, opts.workspace)

  // ACP runtimes self-arm via their own MCP config (deferred); the in-process
  // SDK adapter gets the watch tools wired here, and `!watch` works for all.
  return new ClaudeSdkAdapter(opts.workspace, opts.watchTools)
}
