/**
 * OS-level sandbox launchers for out-of-process (ACP) agent runtimes — pure: builds the wrapper command + args, never spawns.
 * Confinement that does NOT depend on the agent asking before running a tool (the deny floor only holds for an ask-first agent).
 * Limits: in-process Claude SDK can't be OS-jailed (use `claude-acp`); only macOS seatbelt + Linux bwrap supported, else launch is returned unchanged with `sandboxed: false`.
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

/** macOS seatbelt profile: allow-by-default, deny all writes, re-allow workspace + temp/dev (later SBPL rule wins); optional network deny. */
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

/** Wrap a runtime launch in an OS sandbox; returns the (possibly unchanged) launch plus whether confinement was applied. */
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
      '--ro-bind', '/', '/', // whole fs read-only; workspace read-write
      '--bind', opts.workspace, opts.workspace,
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
