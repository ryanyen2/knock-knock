/**
 * buildSandboxLaunch: the OS sandbox wrapper must confine writes to the
 * workspace, toggle the network rule, and always preserve the inner command —
 * and must NOT silently claim confinement on an unsupported platform.
 */

import { test, expect } from 'bun:test'
import { buildSandboxLaunch, seatbeltProfile } from './sandbox.ts'

const LAUNCH = { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] }

test('darwin: wraps in sandbox-exec, profile binds the workspace, inner cmd preserved', () => {
  const r = buildSandboxLaunch(LAUNCH, { platform: 'darwin', workspace: '/Users/me/proj', allowNetwork: true })
  expect(r.sandboxed).toBe(true)
  expect(r.command).toBe('sandbox-exec')
  expect(r.args[0]).toBe('-p')
  expect(r.args[1]).toContain('/Users/me/proj')
  // the inner launch survives at the tail, in order
  expect(r.args.slice(-3)).toEqual(['npx', '-y', '@agentclientprotocol/claude-agent-acp'])
})

test('darwin: network denied adds (deny network*); allowed omits it', () => {
  expect(seatbeltProfile('/w', false)).toContain('(deny network*)')
  expect(seatbeltProfile('/w', true)).not.toContain('(deny network*)')
})

test('darwin: seatbelt denies writes then re-allows the workspace subtree', () => {
  const prof = seatbeltProfile('/Users/me/proj', true)
  expect(prof).toContain('(deny file-write*)')
  expect(prof).toContain('(allow file-write* (subpath "/Users/me/proj"))')
  // order matters in SBPL: the workspace allow must come AFTER the blanket deny
  expect(prof.indexOf('(deny file-write*)')).toBeLessThan(prof.indexOf('(subpath "/Users/me/proj")'))
})

test('linux: wraps in bwrap, binds workspace rw, unshares net when denied', () => {
  const r = buildSandboxLaunch(LAUNCH, { platform: 'linux', workspace: '/home/me/proj', allowNetwork: false })
  expect(r.sandboxed).toBe(true)
  expect(r.command).toBe('bwrap')
  expect(r.args).toEqual(expect.arrayContaining(['--bind', '/home/me/proj', '/home/me/proj']))
  expect(r.args).toContain('--unshare-net')
  // inner command after the `--` separator
  const sep = r.args.indexOf('--')
  expect(r.args.slice(sep + 1)).toEqual(['npx', '-y', '@agentclientprotocol/claude-agent-acp'])
})

test('linux: network allowed omits --unshare-net', () => {
  const r = buildSandboxLaunch(LAUNCH, { platform: 'linux', workspace: '/home/me/proj', allowNetwork: true })
  expect(r.args).not.toContain('--unshare-net')
})

test('unsupported platform: returns the launch unchanged + a warning, sandboxed=false', () => {
  const r = buildSandboxLaunch(LAUNCH, { platform: 'win32', workspace: 'C:/proj', allowNetwork: false })
  expect(r.sandboxed).toBe(false)
  expect(r.command).toBe('npx')
  expect(r.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  expect(r.warning).toBeTruthy()
})

test('a command with no args is preserved', () => {
  const r = buildSandboxLaunch({ command: 'opencode' }, { platform: 'linux', workspace: '/w', allowNetwork: true })
  expect(r.args.slice(-1)).toEqual(['opencode'])
})
