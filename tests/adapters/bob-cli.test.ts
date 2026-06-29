/**
 * Pure tests for the Bob Shell adapter helpers: argv building, stream-json event
 * parsing (against the real v1.0.5 schema), policy→launch mapping, .bobignore merge,
 * and runtime registration. No subprocess, no BOBSHELL_API_KEY.
 */

import { test, expect } from 'bun:test'
import {
  buildBobArgs,
  parseBobStreamLine,
  bobPolicyToLaunch,
  denyGlobFromPattern,
  mergeBobignore,
  completionText,
  BOB_COMPLETION_TOOL,
} from '../../src/adapters/bob-cli.ts'
import { makeAdapter, runtimeSelfArmsWatches } from '../../src/adapters/index.ts'
import { BobShellCliAdapter } from '../../src/adapters/bob-cli.ts'
import { RUNTIME_VALUES, RUNTIMES } from '../../src/lib.ts'

// ─── buildBobArgs ──────────────────────────────────────────────────────────────

test('buildBobArgs: always non-interactive stream-json with the license accepted', () => {
  const args = buildBobArgs({ prompt: 'hello', approvalMode: 'default', sandbox: true })
  expect(args[0]).toBe('hello') // positional prompt, never shell-interpolated
  expect(args).toContain('-o')
  expect(args).toContain('stream-json')
  expect(args).toContain('--accept-license')
  expect(args).toContain('--approval-mode')
  expect(args).toContain('--sandbox')
})

test('buildBobArgs: resume and model are included only when set', () => {
  const withBoth = buildBobArgs({ prompt: 'x', approvalMode: 'auto_edit', sandbox: true, resume: 'sess-1', model: 'granite' })
  expect(withBoth).toContain('--resume')
  expect(withBoth[withBoth.indexOf('--resume') + 1]).toBe('sess-1')
  expect(withBoth[withBoth.indexOf('--model') + 1]).toBe('granite')

  const neither = buildBobArgs({ prompt: 'x', approvalMode: 'default', sandbox: false })
  expect(neither).not.toContain('--resume')
  expect(neither).not.toContain('--model')
  expect(neither).not.toContain('--sandbox')
})

// ─── parseBobStreamLine (real v1.0.5 schema) ────────────────────────────────────

test('parseBobStreamLine: parses each documented event type', () => {
  expect(parseBobStreamLine('{"type":"init","session_id":"s1","model":"granite"}')).toMatchObject({
    type: 'init', session_id: 's1', model: 'granite',
  })
  expect(parseBobStreamLine('{"type":"message","role":"assistant","content":"hi","delta":true}')).toMatchObject({
    type: 'message', role: 'assistant',
  })
  expect(parseBobStreamLine('{"type":"tool_use","tool_name":"write_file","tool_id":"t1","parameters":{}}')).toMatchObject({
    type: 'tool_use', tool_name: 'write_file', tool_id: 't1',
  })
  expect(parseBobStreamLine('{"type":"tool_result","tool_id":"t1","status":"success"}')).toMatchObject({
    type: 'tool_result', tool_id: 't1', status: 'success',
  })
  expect(parseBobStreamLine('{"type":"result","status":"success","stats":{}}')).toMatchObject({
    type: 'result', status: 'success',
  })
})

test('parseBobStreamLine: ignores blank, non-JSON, and foreign-type lines', () => {
  expect(parseBobStreamLine('')).toBeNull()
  expect(parseBobStreamLine('   ')).toBeNull()
  expect(parseBobStreamLine('some plain log line')).toBeNull()
  expect(parseBobStreamLine('{ broken json')).toBeNull()
  expect(parseBobStreamLine('{"type":"telemetry","x":1}')).toBeNull() // not in our enum
})

// ─── completionText: the final answer lives in attempt_completion, not message ──
// These payloads are copied verbatim from a real `bob -o stream-json` turn (v1.0.5).

test('completionText: extracts the answer from tool_use parameters (object)', () => {
  const params = { result: '\nHello! I am Bob.\n' }
  expect(completionText(params)).toBe('\nHello! I am Bob.\n')
})

test('completionText: extracts the answer from tool_result output (bare string)', () => {
  expect(completionText('\nHello! I am Bob.\n')).toBe('\nHello! I am Bob.\n')
})

test('completionText: blank / non-answer payloads yield undefined', () => {
  expect(completionText('')).toBeUndefined()
  expect(completionText('   ')).toBeUndefined()
  expect(completionText({})).toBeUndefined()
  expect(completionText(null)).toBeUndefined()
})

test('attempt_completion is the recognized answer tool', () => {
  // A real turn returns the answer via this tool, not via assistant message chunks
  // (which carry "[using tool attempt_completion: …]" status lines).
  expect(BOB_COMPLETION_TOOL).toBe('attempt_completion')
  const toolUse = parseBobStreamLine(
    '{"type":"tool_use","tool_name":"attempt_completion","tool_id":"tool-1","parameters":{"result":"the answer"}}',
  )
  expect(toolUse).toMatchObject({ type: 'tool_use', tool_name: 'attempt_completion' })
})

// ─── bobPolicyToLaunch (the permission mapping) ─────────────────────────────────

test('bobPolicyToLaunch: ask-tier present → turn gate, never yolo', () => {
  const plan = bobPolicyToLaunch({ allow: ['Read(**)'], ask: ['Write(**)'], deny: [] })
  expect(plan.needsWriteGate).toBe(true)
  expect(plan.approvalMode).toBe('default') // gate decides auto_edit at turn time; never yolo here
})

test('bobPolicyToLaunch: allow-only (no ask) → auto_edit, never yolo', () => {
  const plan = bobPolicyToLaunch({ allow: ['Bash(*)', 'Write(**)'], ask: [], deny: [] })
  expect(plan.needsWriteGate).toBe(false)
  expect(plan.approvalMode).toBe('auto_edit')
})

test('bobPolicyToLaunch: NEVER emits yolo — preserves the command-tier deny floor', () => {
  // yolo would auto-run a denied command like `rm -rf` (Bob has no per-command hook).
  for (const profile of [
    { allow: ['Bash(*)'], ask: [], deny: ['Bash(rm -rf *)'] },
    { allow: ['Read(**)', 'Write(**)'], ask: [], deny: [] },
    { allow: [], ask: ['Write(**)'], deny: [] },
    { allow: [], ask: [], deny: [] },
  ]) {
    expect(bobPolicyToLaunch(profile).approvalMode).not.toBe('yolo')
  }
})

test('bobPolicyToLaunch: locked down (no allow, no ask) → read-only default', () => {
  const plan = bobPolicyToLaunch({ allow: [], ask: [], deny: ['Bash(rm -rf *)'] })
  expect(plan.needsWriteGate).toBe(false)
  expect(plan.approvalMode).toBe('default')
})

test('bobPolicyToLaunch: deny path globs are collected, command denies are not', () => {
  const plan = bobPolicyToLaunch({
    allow: [],
    ask: ['Write(**)'],
    deny: ['Write(~/.ssh/**)', 'Read(**/.env)', 'Bash(rm -rf *)', 'Bash(sudo *)'],
  })
  expect(plan.denyGlobs).toContain('~/.ssh/**')
  expect(plan.denyGlobs).toContain('**/.env')
  expect(plan.denyGlobs).not.toContain('rm -rf *') // a command, not a path
})

test('denyGlobFromPattern: distinguishes path tiers from command tiers', () => {
  expect(denyGlobFromPattern('Read(src/secrets.json)')).toBe('src/secrets.json')
  expect(denyGlobFromPattern('**/.env')).toBe('**/.env') // bare glob
  expect(denyGlobFromPattern('Bash(rm -rf *)')).toBeNull()
  expect(denyGlobFromPattern('Bash(npm test)')).toBeNull()
  expect(denyGlobFromPattern('Write()')).toBeNull()
})

test('denyGlobFromPattern: a file-tool path with spaces is NOT dropped (secret stays protected)', () => {
  // Regression: spaces in an explicit file-tool arg are valid path chars, not a command.
  expect(denyGlobFromPattern('Read(/My Keys/.env)')).toBe('/My Keys/.env')
  expect(denyGlobFromPattern('Write(~/My Projects/secret.pem)')).toBe('~/My Projects/secret.pem')
  // But a bare (un-wrapped) command-shaped string is still rejected.
  expect(denyGlobFromPattern('rm -rf /tmp')).toBeNull()
})

// ─── mergeBobignore ─────────────────────────────────────────────────────────────

test('mergeBobignore: adds a managed block, preserving user content', () => {
  const out = mergeBobignore('node_modules/\n*.log\n', ['**/.env', '*.pem'])
  expect(out).toContain('node_modules/')
  expect(out).toContain('*.log')
  expect(out).toContain('**/.env')
  expect(out).toContain('*.pem')
})

test('mergeBobignore: is idempotent (re-merging does not stack blocks)', () => {
  const once = mergeBobignore('user stuff\n', ['**/.env'])
  const twice = mergeBobignore(once, ['**/.env'])
  expect(twice).toBe(once)
  expect((twice.match(/>>> knock-knock managed/g) ?? []).length).toBe(1)
})

test('mergeBobignore: empty deny globs → no managed block, user content kept', () => {
  expect(mergeBobignore('keep me\n', [])).toContain('keep me')
  expect(mergeBobignore('keep me\n', [])).not.toContain('knock-knock managed')
})

// ─── Fail-closed deny floor ──────────────────────────────────────────────────────

test('prompt refuses the turn (does not spawn bob) when the .bobignore deny floor cannot be written', async () => {
  // cwd does not exist → writeFileSync throws → fail closed rather than expose files.
  const adapter = new BobShellCliAdapter('/nonexistent-knockknock-dir/ws')
  adapter.applyPolicy({ allow: [], ask: [], deny: ['Read(**/.env)', 'Write(*.pem)'] })
  const res = await adapter.prompt({ text: 'read my secrets' })
  expect(res.text).toContain('refusing the turn')
})

// ─── Runtime registration ───────────────────────────────────────────────────────

test('bob is a registered runtime in both pickers', () => {
  expect(RUNTIME_VALUES).toContain('bob')
  expect(RUNTIMES.some(r => r.value === 'bob')).toBe(true)
})

test('makeAdapter("bob") returns the Bob adapter, not the SDK fallthrough', () => {
  const adapter = makeAdapter('bob', { workspace: '/tmp/ws' })
  expect(adapter).toBeInstanceOf(BobShellCliAdapter)
})

test('bob does not self-arm in-process watches (CLI subprocess)', () => {
  expect(runtimeSelfArmsWatches('bob')).toBe(false)
})
