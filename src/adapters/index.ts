/** Adapter factory — an agent's `runtime` becomes a live AgentAdapter.
 *  claude-sdk = in-process SDK; everything else = ACP over stdio. */

import type { AgentAdapter } from '../agent-adapter.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'
import { AcpAdapter, type AcpLaunch } from './acp.ts'
import type { WatchToolHandlers, ShareToolHandlers } from '../agent-adapter.ts'

/** Built-in ACP launch presets, keyed by an agent's `runtime`. */
const ACP_PRESETS: Record<string, AcpLaunch> = {
  'claude-acp': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  opencode: { command: 'opencode', args: ['acp'] },
  codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
}

/** Does this runtime expose the in-process watch tool? Only the SDK adapter. */
export function runtimeSelfArmsWatches(runtime: string): boolean {
  if (runtime === 'acp' && process.env.KNOCK_KNOCK_ACP_COMMAND) return false
  if (ACP_PRESETS[runtime]) return false
  return true
}

export function makeAdapter(
  runtime: string,
  opts: {
    workspace: string
    watchTools?: WatchToolHandlers
    /** In-process share_file tool (claude-sdk only). Lets the agent share a workspace
     *  file back to the channel, secret-floored + consent-gated by the host. ACP ignores it. */
    shareTools?: ShareToolHandlers
    /** Page-scoped Notion read/write tools (claude-sdk only). Set for a Notion bot so
     *  the agent can write INTO the page, not just comment. ACP runtimes ignore it. */
    notion?: { token: string; pageId: string }
  },
): AgentAdapter {
  // Explicit command override (agent without a preset).
  const override = process.env.KNOCK_KNOCK_ACP_COMMAND
  if (runtime === 'acp' && override) {
    const args = process.env.KNOCK_KNOCK_ACP_ARGS?.split(' ').filter(Boolean) ?? []
    return new AcpAdapter({ command: override, args }, opts.workspace)
  }

  const preset = ACP_PRESETS[runtime]
  if (preset) return new AcpAdapter(preset, opts.workspace)

  return new ClaudeSdkAdapter(opts.workspace, opts.watchTools, opts.notion, opts.shareTools)
}
