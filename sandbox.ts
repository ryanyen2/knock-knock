/**
 * OS-level sandbox launchers for out-of-process (ACP) agent runtimes.
 *
 * The relay spawns ACP agents as child processes (adapters/acp.ts spawn). When an
 * agent is configured with a sandbox, we WRAP its launch command in an OS
 * confinement tool so filesystem writes are limited to the workspace and the
 * network can be denied — containment that does NOT depend on the agent asking
 * before it runs a tool (the application deny floor in `classifyTool` only holds
 * for an ask-first agent; a yolo/bypass agent slips past it).
 *
 * Honest limits:
 *  - The in-process Claude SDK runtime runs INSIDE the relay and cannot be
 *    OS-jailed without jailing the whole relay. Use runtime `claude-acp`
 *    (out-of-process) when sandboxing is required.
 *  - Supported launchers: macOS seatbelt (`sandbox-exec`) and Linux bubblewrap
 *    (`bwrap`). Any other platform returns the launch UNCHANGED with
 *    `sandboxed: false` and a warning, so the caller can surface it rather than
 *    silently believe the agent is confined.
 *
 * This module is PURE — it builds the wrapper command + args and never spawns;
 * `sandbox.test.ts` asserts the generated profile/args per platform.
 */

export type SandboxOpts = {
  platform: NodeJS.Platform
  /** Absolute path the agent may write under. */
  workspace: string
  /** When false, the sandbox blocks outbound network. */
  allowNetwork: boolean
}

export type SandboxResult = {
  command: string
  args: string[]
  /** True when an OS sandbox actually wraps the command. */
  sandboxed: boolean
  /** Set when sandboxing was requested but is unavailable here. */
  warning?: string
}

/** Quote a path as a seatbelt (SBPL) string literal. */
function sbLiteral(path: string): string {
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * macOS seatbelt profile: allow-by-default, then deny ALL filesystem writes and
 * re-allow only the workspace and the standard temp/dev paths. Optionally deny
 * the network. Later rules win in SBPL, so the workspace re-allow overrides the
 * blanket write-deny inside the workspace subtree.
 */
export function seatbeltProfile(workspace: string, allowNetwork: boolean): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sbLiteral(workspace)}))`,
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))',
    '(allow file-write-data (regex #"^/dev/"))',
  ]
  if (!allowNetwork) lines.push('(deny network*)')
  return lines.join('\n')
}

/**
 * Wrap a runtime launch (`command` + `args`) in an OS sandbox. Returns the
 * (possibly unchanged) launch plus whether confinement was actually applied.
 */
export function buildSandboxLaunch(
  launch: { command: string; args?: string[] },
  opts: SandboxOpts,
): SandboxResult {
  const inner = [launch.command, ...(launch.args ?? [])]

  if (opts.platform === 'darwin') {
    return {
      command: 'sandbox-exec',
      args: ['-p', seatbeltProfile(opts.workspace, opts.allowNetwork), ...inner],
      sandboxed: true,
    }
  }

  if (opts.platform === 'linux') {
    const args = [
      '--ro-bind', '/', '/', // whole fs read-only…
      '--bind', opts.workspace, opts.workspace, // …workspace read-write
      '--bind', '/tmp', '/tmp',
      '--dev', '/dev',
      '--proc', '/proc',
    ]
    if (!opts.allowNetwork) args.push('--unshare-net')
    args.push('--', ...inner)
    return { command: 'bwrap', args, sandboxed: true }
  }

  return {
    command: launch.command,
    args: launch.args ?? [],
    sandboxed: false,
    warning: `no OS sandbox available on platform "${opts.platform}" — relying on the deny floor only`,
  }
}
