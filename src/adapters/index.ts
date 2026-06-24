/** Adapter factory — an agent's `runtime` becomes a live AgentAdapter.
 *  claude-sdk = in-process SDK; everything else = ACP over stdio. */

import type { AgentAdapter } from '../agent-adapter.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'
import { AcpAdapter, type AcpLaunch } from './acp.ts'
import type { WatchToolHandlers } from '../agent-adapter.ts'
import { buildSandboxLaunch } from '../sandbox.ts'

/** OS-sandbox config for an agent (a subset of AgentConfig.sandbox). */
type SandboxOpt = { network: 'deny' | 'allow' }

/** Wrap an ACP launch in an OS sandbox when configured; warn when unavailable. */
function wrapSandbox(launch: AcpLaunch, workspace: string, sandbox?: SandboxOpt): AcpLaunch {
  if (!sandbox) return launch
  const res = buildSandboxLaunch(launch, {
    platform: process.platform,
    workspace,
    allowNetwork: sandbox.network === 'allow',
  })
  if (res.warning) process.stderr.write(`knock-knock: sandbox requested but ${res.warning}\n`)
  return { command: res.command, args: res.args, env: launch.env }
}

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
  opts: { workspace: string; watchTools?: WatchToolHandlers; sandbox?: SandboxOpt },
): AgentAdapter {
  // Explicit command override (agent without a preset).
  const override = process.env.KNOCK_KNOCK_ACP_COMMAND
  if (runtime === 'acp' && override) {
    const args = process.env.KNOCK_KNOCK_ACP_ARGS?.split(' ').filter(Boolean) ?? []
    return new AcpAdapter(wrapSandbox({ command: override, args }, opts.workspace, opts.sandbox), opts.workspace)
  }

  const preset = ACP_PRESETS[runtime]
  if (preset) return new AcpAdapter(wrapSandbox(preset, opts.workspace, opts.sandbox), opts.workspace)

  // The in-process SDK can't be OS-jailed — warn so a sandbox request isn't silently dropped.
  if (opts.sandbox) {
    process.stderr.write(
      `knock-knock: runtime "${runtime}" is in-process and cannot be OS-sandboxed; ` +
        `use runtime "claude-acp" for confinement. Relying on the deny floor.\n`,
    )
  }
  return new ClaudeSdkAdapter(opts.workspace, opts.watchTools)
}
