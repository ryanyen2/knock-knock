/**
 * Driver — the imported <shared-context> rides ahead of the <channel> envelope,
 * after the first-turn preamble, and only on the turn it's passed.
 */

import { test, expect } from 'bun:test'
import { Driver, type TurnMeta } from './driver.ts'
import type { AgentAdapter, AgentEvent, PermissionProfile, Verdict } from './agent-adapter.ts'

/** Records the prompt text it's handed; returns a stable session id. */
class StubAdapter implements AgentAdapter {
  prompts: string[] = []
  applyPolicy(_p: PermissionProfile): void {}
  onPermissionRequest(_h: (r: { toolName: string; input: unknown }) => Promise<Verdict>): void {}
  onEvent(_h: (e: AgentEvent) => void): void {}
  async prompt(input: { text: string }): Promise<{ sessionId: string; text: string }> {
    this.prompts.push(input.text)
    return { sessionId: 'sess-1', text: 'ok' }
  }
}

const PROFILE: PermissionProfile = { allow: [], ask: [], deny: [] }
const meta: TurnMeta = {
  senderId: 'u1',
  kind: 'owner',
  messageId: 'm1',
  ts: '2026-05-29T10:00:00Z',
  channelId: 'chan-X',
}
const ctx = { identity: { name: 'Bot', ownerUserId: 'u1', blurb: 'b' }, rosterLines: '' }
const PREFIX = '<shared-context source="claude-code:abc">prior plan</shared-context>'

test('contextPrefix is injected after the preamble and before the <channel> envelope', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, async () => ({ behavior: 'deny', message: 'x' }), ctx)

  await driver.runTurn('hello', meta, undefined, PREFIX)

  const prompt = stub.prompts[0]!
  expect(prompt).toContain(PREFIX)
  // The envelope is identified by its chat_id (the preamble also mentions the
  // literal "<channel …>" while explaining the format, so match the real one).
  const envOpen = prompt.indexOf('chat_id="chan-X"')
  expect(envOpen).toBeGreaterThan(-1)
  // order: preamble … shared-context … <channel> envelope
  expect(prompt.indexOf('You are')).toBeLessThan(prompt.indexOf(PREFIX))
  expect(prompt.indexOf(PREFIX)).toBeLessThan(envOpen)
  // the actual user text sits inside the envelope, after the context block
  expect(prompt.indexOf('hello')).toBeGreaterThan(prompt.indexOf(PREFIX))
})

test('a turn with no prefix carries no shared-context (and no preamble on turn 2)', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, async () => ({ behavior: 'deny', message: 'x' }), ctx)

  await driver.runTurn('first', meta, undefined, PREFIX) // delivers once
  await driver.runTurn('second', meta) // host passes no prefix the next turn

  const second = stub.prompts[1]!
  expect(second).not.toContain(PREFIX)
  expect(second).not.toContain('You are') // preamble only on the first turn
  expect(second).toContain('second')
})
