/**
 * makeAdapter dispatch: every supported runtime resolves to the right transport,
 * the OS sandbox wraps the out-of-process (ACP) ones, and the in-process SDK
 * warns (rather than silently pretending to be confined). Construction must not
 * spawn or connect — these are unit-cheap.
 */

import { test, expect, afterEach } from 'bun:test'
import { makeAdapter, runtimeSelfArmsWatches } from './index.ts'
import { AcpAdapter } from './acp.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'

const WS = '/tmp/knock-ws'

afterEach(() => {
  delete process.env.KNOCK_KNOCK_ACP_COMMAND
  delete process.env.KNOCK_KNOCK_ACP_ARGS
})

test('every ACP preset runtime constructs an AcpAdapter', () => {
  for (const runtime of ['claude-acp', 'opencode', 'codex', 'gemini']) {
    expect(makeAdapter(runtime, { workspace: WS }), runtime).toBeInstanceOf(AcpAdapter)
  }
})

test('claude-sdk constructs the in-process SDK adapter', () => {
  expect(makeAdapter('claude-sdk', { workspace: WS })).toBeInstanceOf(ClaudeSdkAdapter)
})

test('the generic "acp" runtime uses KNOCK_KNOCK_ACP_COMMAND', () => {
  process.env.KNOCK_KNOCK_ACP_COMMAND = 'my-agent'
  process.env.KNOCK_KNOCK_ACP_ARGS = 'acp --foo'
  expect(makeAdapter('acp', { workspace: WS })).toBeInstanceOf(AcpAdapter)
})

test('an unknown runtime falls back to the in-process SDK adapter', () => {
  expect(makeAdapter('totally-unknown', { workspace: WS })).toBeInstanceOf(ClaudeSdkAdapter)
})

test('sandbox config is accepted for every ACP runtime without throwing', () => {
  for (const runtime of ['claude-acp', 'opencode', 'codex', 'gemini']) {
    expect(
      makeAdapter(runtime, { workspace: WS, sandbox: { network: 'deny' } }),
      runtime,
    ).toBeInstanceOf(AcpAdapter)
  }
})

test('sandbox on the in-process SDK warns (cannot be OS-jailed)', () => {
  const orig = process.stderr.write.bind(process.stderr)
  let out = ''
  process.stderr.write = ((s: string) => {
    out += s
    return true
  }) as typeof process.stderr.write
  try {
    makeAdapter('claude-sdk', { workspace: WS, sandbox: { network: 'deny' } })
  } finally {
    process.stderr.write = orig
  }
  expect(out).toContain('in-process')
  expect(out.toLowerCase()).toContain('sandbox')
})

test('runtimeSelfArmsWatches: only the in-process SDK self-arms; ACP presets do not', () => {
  expect(runtimeSelfArmsWatches('claude-sdk')).toBe(true)
  for (const runtime of ['claude-acp', 'opencode', 'codex', 'gemini']) {
    expect(runtimeSelfArmsWatches(runtime), runtime).toBe(false)
  }
})
