/**
 * Session readers — fixture-driven, env-isolated (no real ~/.claude etc.).
 *
 * Each runtime's store reads from a base dir we point at via its env override
 * (CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCODE_DATA_DIR / GEMINI_DIR), so the test
 * touches only a temp tree. Fixtures are minimal but representative of each
 * runtime's real on-disk shape.
 */

import { test, expect, beforeAll, afterAll, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ClaudeCodeSessionStore } from './claude.ts'
import { CodexSessionStore } from './codex.ts'
import { OpenCodeSessionStore } from './opencode.ts'
import { GeminiSessionStore } from './gemini.ts'
import { listAllSessions, makeSessionStore, sessionRuntimeForAgent } from './index.ts'

const WS = '/tmp/ws/proj'
let root: string
const saved: Record<string, string | undefined> = {}

function jsonl(lines: unknown[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kk-sessions-'))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_DATA_DIR', 'GEMINI_DIR']) {
    saved[k] = process.env[k]
  }

  // ── Claude Code: <config>/projects/<encoded-cwd>/<id>.jsonl ──
  const claudeBase = join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = claudeBase
  const encoded = WS.replace(/[^a-zA-Z0-9]/g, '-')
  const projDir = join(claudeBase, 'projects', encoded)
  mkdirSync(projDir, { recursive: true })
  writeFileSync(
    join(projDir, 'sess-123.jsonl'),
    jsonl([
      { type: 'user', message: { role: 'user', content: 'build a feature' }, cwd: WS, timestamp: '2026-05-29T10:00:00Z', sessionId: 'sess-123' },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: "I'll plan first." },
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Step 1: do X\nStep 2: do Y' } },
      ] }, cwd: WS, timestamp: '2026-05-29T10:01:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'do X', status: 'completed' },
          { content: 'do Y', status: 'pending' },
        ] } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/ws/proj/a.ts' } },
      ] }, cwd: WS, timestamp: '2026-05-29T10:02:00Z' },
    ]),
  )
  // A session in an unrelated project must NOT surface.
  const otherDir = join(claudeBase, 'projects', '-tmp-other-proj')
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(
    join(otherDir, 'other.jsonl'),
    jsonl([{ type: 'user', message: { content: 'unrelated' }, cwd: '/tmp/other/proj', timestamp: '2026-05-29T09:00:00Z' }]),
  )

  // ── Codex: <home>/sessions/YYYY/MM/DD/*.jsonl ──
  const codexBase = join(root, 'codex')
  process.env.CODEX_HOME = codexBase
  const rolloutDir = join(codexBase, 'sessions', '2026', '05', '29')
  mkdirSync(rolloutDir, { recursive: true })
  writeFileSync(
    join(rolloutDir, 'rollout-abc.jsonl'),
    jsonl([
      { type: 'session_meta', payload: { id: 'cdx-1', cwd: WS, timestamp: '2026-05-29T11:00:00Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi codex' }] }, timestamp: '2026-05-29T11:00:30Z' },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sure thing' }] }, timestamp: '2026-05-29T11:01:00Z' },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' }, timestamp: '2026-05-29T11:01:30Z' },
    ]),
  )

  // ── OpenCode: <data>/storage/{session,message}/… ──
  const ocBase = join(root, 'oc')
  process.env.OPENCODE_DATA_DIR = ocBase
  const sessDir = join(ocBase, 'storage', 'session', 'projhash')
  const msgDir = join(ocBase, 'storage', 'message', 'oc-1')
  mkdirSync(sessDir, { recursive: true })
  mkdirSync(msgDir, { recursive: true })
  writeFileSync(
    join(sessDir, 'oc-1.json'),
    JSON.stringify({ id: 'oc-1', title: 'opencode work', directory: WS, time: { created: 1700000000000, updated: 1700000100000 } }),
  )
  writeFileSync(join(msgDir, 'msg_001.json'), JSON.stringify({ id: 'msg_001', role: 'user', parts: [{ type: 'text', text: 'do it' }] }))
  writeFileSync(
    join(msgDir, 'msg_002.json'),
    JSON.stringify({ id: 'msg_002', role: 'assistant', parts: [
      { type: 'text', text: 'done' },
      { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } },
    ] }),
  )

  // ── Gemini: <base>/tmp/<sha256(cwd)>/chats/*.json ──
  const gemBase = join(root, 'gem')
  process.env.GEMINI_DIR = gemBase
  const hash = createHash('sha256').update(WS).digest('hex')
  const chatsDir = join(gemBase, 'tmp', hash, 'chats')
  mkdirSync(chatsDir, { recursive: true })
  writeFileSync(
    join(chatsDir, 'session-1.json'),
    JSON.stringify({ sessionId: 'gem-1', lastUpdated: '2026-05-29T12:00:00Z', messages: [
      { role: 'user', parts: [{ text: 'hello gemini' }] },
      { role: 'model', parts: [{ text: 'hi' }, { functionCall: { name: 'run', args: { x: 1 } } }] },
    ] }),
  )
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('ClaudeCodeSessionStore', () => {
  test('list filters to the workspace and reads metadata', async () => {
    const sessions = await new ClaudeCodeSessionStore().list({ workspace: WS })
    expect(sessions.map(s => s.id)).toEqual(['sess-123']) // unrelated project excluded
    const s = sessions[0]!
    expect(s.runtime).toBe('claude-code')
    expect(s.cwd).toBe(WS)
    expect(s.title).toBe('build a feature')
    expect(s.messageCount).toBe(2) // user + assistant text; tool calls don't count
    expect(s.updatedAt).toBe('2026-05-29T10:02:00Z')
  })

  test('read returns normalized events incl. tool_use plan/todos', async () => {
    const t = await new ClaudeCodeSessionStore().read('sess-123')
    expect(t).toBeTruthy()
    const plan = t!.events.find(e => e.tool?.name === 'ExitPlanMode')
    expect((plan!.tool!.input as { plan: string }).plan).toContain('Step 1')
    expect(t!.events.some(e => e.tool?.name === 'TodoWrite')).toBe(true)
    expect(t!.events.some(e => e.role === 'user' && e.text === 'build a feature')).toBe(true)
  })
})

describe('CodexSessionStore', () => {
  test('list reads id + cwd from session_meta', async () => {
    const sessions = await new CodexSessionStore().list({ workspace: WS })
    expect(sessions.map(s => s.id)).toContain('cdx-1')
    const s = sessions.find(x => x.id === 'cdx-1')!
    expect(s.cwd).toBe(WS)
    expect(s.messageCount).toBe(2)
  })

  test('read normalizes messages + function_call', async () => {
    const t = await new CodexSessionStore().read('cdx-1')
    expect(t!.events.some(e => e.role === 'user' && e.text === 'hi codex')).toBe(true)
    expect(t!.events.some(e => e.role === 'assistant' && e.text === 'sure thing')).toBe(true)
    const tool = t!.events.find(e => e.tool?.name === 'shell')
    expect((tool!.tool!.input as { command: string }).command).toBe('ls')
  })
})

describe('OpenCodeSessionStore', () => {
  test('list reads meta (title/directory/time) + message count', async () => {
    const sessions = await new OpenCodeSessionStore().list({ workspace: WS })
    const s = sessions.find(x => x.id === 'oc-1')!
    expect(s.title).toBe('opencode work')
    expect(s.cwd).toBe(WS)
    expect(s.messageCount).toBe(2)
  })

  test('read assembles parts (inline) into events', async () => {
    const t = await new OpenCodeSessionStore().read('oc-1')
    expect(t!.events.map(e => e.text).filter(Boolean)).toEqual(['do it', 'done'])
    expect(t!.events.some(e => e.tool?.name === 'bash')).toBe(true)
  })
})

describe('GeminiSessionStore', () => {
  test('list keys off sha256(workspace)', async () => {
    const sessions = await new GeminiSessionStore().list({ workspace: WS })
    const s = sessions.find(x => x.id === 'gem-1')!
    expect(s.cwd).toBe(WS)
    expect(s.messageCount).toBe(2)
  })

  test('read normalizes parts incl. functionCall', async () => {
    const t = await new GeminiSessionStore().read('gem-1')
    expect(t!.events.some(e => e.role === 'user' && e.text === 'hello gemini')).toBe(true)
    expect(t!.events.some(e => e.tool?.name === 'run')).toBe(true)
  })
})

describe('trailing-slash workspace (access.json may store one)', () => {
  // Regression: a workspace like "/tmp/ws/proj/" must still resolve. The Claude
  // reader encodes the path into a project-dir name and Gemini sha256-hashes it,
  // so a stray trailing slash silently returned ZERO sessions before normalize.
  test('Claude reader finds the session with a trailing slash', async () => {
    const sessions = await new ClaudeCodeSessionStore().list({ workspace: WS + '/' })
    expect(sessions.map(s => s.id)).toEqual(['sess-123'])
  })

  test('Gemini reader finds the session with a trailing slash', async () => {
    const sessions = await new GeminiSessionStore().list({ workspace: WS + '/' })
    expect(sessions.some(s => s.id === 'gem-1')).toBe(true)
  })

  test('listAllSessions is trailing-slash invariant', async () => {
    const a = (await listAllSessions(WS)).map(s => s.id).sort()
    const b = (await listAllSessions(WS + '/')).map(s => s.id).sort()
    expect(b).toEqual(a)
  })
})

describe('factory + fan-out', () => {
  test('makeSessionStore maps relay runtimes to session stores', () => {
    expect(makeSessionStore('claude-sdk')!.runtime).toBe('claude-code')
    expect(makeSessionStore('claude-acp')!.runtime).toBe('claude-code')
    expect(makeSessionStore('codex')!.runtime).toBe('codex')
    expect(makeSessionStore('opencode')!.runtime).toBe('opencode')
    expect(makeSessionStore('gemini')!.runtime).toBe('gemini')
    expect(makeSessionStore('nonsense')).toBeUndefined()
  })

  test('sessionRuntimeForAgent resolves the resumable runtime (or undefined)', () => {
    expect(sessionRuntimeForAgent('claude-sdk')).toBe('claude-code')
    expect(sessionRuntimeForAgent('claude-acp')).toBe('claude-code')
    expect(sessionRuntimeForAgent('opencode')).toBe('opencode')
    expect(sessionRuntimeForAgent('gemini')).toBe('gemini')
    expect(sessionRuntimeForAgent('nonsense')).toBeUndefined()
  })

  test('listAllSessions merges every runtime, newest first', async () => {
    const all = await listAllSessions(WS)
    const ids = all.map(s => s.id)
    expect(ids).toContain('sess-123')
    expect(ids).toContain('cdx-1')
    expect(ids).toContain('oc-1')
    expect(ids).toContain('gem-1')
    // Gemini (12:00) is newest, Claude (10:02) oldest of the four.
    expect(all[0]!.id).toBe('gem-1')
  })

  test('a missing base dir yields an empty list, never throws', async () => {
    const all = await listAllSessions('/no/such/workspace/anywhere')
    expect(all).toEqual([])
  })
})
