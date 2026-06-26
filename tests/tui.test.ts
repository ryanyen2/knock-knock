/**
 * PaneTUI smoke tests — the renderer writes ANSI to process.stdout, so we stub
 * stdout.write and assert it (a) drives all RelayUI methods without throwing,
 * (b) actually paints pane content, and (c) restores the terminal on stop().
 * Not a pixel test — a guard against format/regex/lifecycle crashes.
 */

import { test, expect, afterEach } from 'bun:test'
import { PaneTUI } from '../src/tui.ts'

const realWrite = process.stdout.write.bind(process.stdout)
let captured = ''

function stub(): void {
  captured = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
}

afterEach(() => {
  process.stdout.write = realWrite
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('PaneTUI: drives the full RelayUI surface and paints pane content', async () => {
  stub()
  const ui = new PaneTUI()
  ui.banner([{ key: 'reviewer', runtime: 'claude-sdk', workspace: '/repo' }])
  expect(captured).toContain('\x1b[?1049h') // entered the alternate screen on first banner
  ui.connected('reviewer', 'reviewer#1')
  ui.turnStart('reviewer', { channel: { label: '#infra' }, sender: { label: 'alice', kind: 'human' }, text: 'please review' })
  ui.event('reviewer', { type: 'session_init', sessionId: 'abcdef123456', model: 'claude-opus-4-8', tools: 12 })
  ui.event('reviewer', { type: 'tool_call', toolCallId: 't1', name: 'Read', input: { file_path: '/repo/x.ts' } })
  ui.event('reviewer', { type: 'tool_result', toolCallId: 't1', status: 'failed' })
  ui.event('reviewer', { type: 'assistant_text', text: 'looks good' })
  ui.event('reviewer', { type: 'turn_done', durationMs: 1500, tokensIn: 2000, tokensOut: 500, costUsd: 0.012 })
  ui.note('watch', 'armed a watch') // global note → footer
  await sleep(140) // let the throttled redraw fire
  expect(captured).toContain('reviewer')
  expect(captured).toContain('claude-opus-4-8')
  ui.stop()
})

test('PaneTUI: idle strip and wake-activation render without throwing', async () => {
  stub()
  const ui = new PaneTUI()
  ui.banner([{ key: 'a', runtime: 'codex', workspace: '/a' }])
  ui.setIdle([{ key: 'b', rooms: 2 }])
  await sleep(140)
  expect(captured).toContain('idle')
  ui.activate('b', 'gemini')
  await sleep(140)
  expect(captured).toContain('b')
  ui.stop()
})

test('PaneTUI: stop() restores the terminal and is idempotent', () => {
  stub()
  const ui = new PaneTUI()
  ui.banner([{ key: 'a', runtime: 'claude-sdk', workspace: '/a' }])
  captured = ''
  ui.stop()
  expect(captured).toContain('\x1b[?1049l') // left the alternate screen
  expect(captured).toContain('\x1b[?25h') // cursor shown again
  captured = ''
  ui.stop() // second call is a no-op
  expect(captured).toBe('')
})
