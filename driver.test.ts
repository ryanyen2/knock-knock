/**
 * Driver — imported <shared-context> rides ahead of the <channel> envelope and
 * after the preamble; the preamble is sent once per session; a resume bind
 * continues a foreign session id and re-sends the preamble for it.
 */

import { test, expect } from 'bun:test'
import { Driver, type TurnMeta } from './driver.ts'
import type { AgentAdapter, AgentEvent, PermissionProfile, Verdict } from './agent-adapter.ts'

/** Records each prompt + the sessionId it was handed; echoes the id back (or
 *  mints one for a fresh session) like a real adapter. */
class StubAdapter implements AgentAdapter {
  calls: { text: string; sessionId?: string }[] = []
  applyPolicy(_p: PermissionProfile): void {}
  onPermissionRequest(_h: (r: { toolName: string; input: unknown }) => Promise<Verdict>): void {}
  onEvent(_h: (e: AgentEvent) => void): void {}
  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    this.calls.push({ text: input.text, sessionId: input.sessionId })
    return { sessionId: input.sessionId ?? 'fresh-1', text: 'ok' }
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
const deny = async (): Promise<Verdict> => ({ behavior: 'deny', message: 'x' })

test('contextPrefix is injected after the preamble and before the <channel> envelope', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, deny, ctx)

  await driver.runTurn('hello', meta, undefined, PREFIX)

  const prompt = stub.calls[0]!.text
  expect(prompt).toContain(PREFIX)
  // The envelope is identified by its chat_id (the preamble also mentions the
  // literal "<channel …>" while explaining the format, so match the real one).
  const envOpen = prompt.indexOf('chat_id="chan-X"')
  expect(envOpen).toBeGreaterThan(-1)
  expect(prompt.indexOf('You are')).toBeLessThan(prompt.indexOf(PREFIX))
  expect(prompt.indexOf(PREFIX)).toBeLessThan(envOpen)
  expect(prompt.indexOf('hello')).toBeGreaterThan(prompt.indexOf(PREFIX))
})

test('a turn with no prefix carries no shared-context (and no preamble on turn 2)', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, deny, ctx)

  await driver.runTurn('first', meta, undefined, PREFIX)
  await driver.runTurn('second', meta)

  const second = stub.calls[1]!.text
  expect(second).not.toContain(PREFIX)
  expect(second).not.toContain('You are') // preamble only on the first turn
  expect(second).toContain('second')
})

test('bindSession resumes the foreign session id and re-sends the preamble', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, deny, ctx)

  driver.bindSession('foreign-123')
  await driver.runTurn('continue please', meta)

  expect(stub.calls[0]!.sessionId).toBe('foreign-123') // resumed, not a fresh session
  expect(stub.calls[0]!.text).toContain('You are') // resumed session is told the room context
})

test('binding mid-conversation rebinds and re-sends the preamble', async () => {
  const stub = new StubAdapter()
  const driver = new Driver(stub, 'chan-X', PROFILE, deny, ctx)

  await driver.runTurn('first', meta) // fresh session: preamble sent, id = fresh-1
  driver.bindSession('foreign-9') // owner resumes a different session
  await driver.runTurn('second', meta)

  expect(stub.calls[1]!.sessionId).toBe('foreign-9')
  expect(stub.calls[1]!.text).toContain('You are') // preamble re-sent after the rebind
})
