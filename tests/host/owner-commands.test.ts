/**
 * Owner turn-control commands (!clear / !compact): owner-only gating + the in-flight-turn guard.
 *
 * These are reached from handleInbound only when `kind === 'owner'`, and each handler re-checks
 * `userId === ownerUserId`, so a non-owner can never trigger them. The newer guard refuses while a
 * turn is live, because deleting the session entry mid-turn would orphan its AbortController and
 * leave a later !stop unable to abort the run. There is no full AgentHost message-path harness in
 * the suite, so we construct a host with a real in-memory store and drive the handlers directly,
 * stubbing only the channel/owner lookups and the messaging sink to observe the gate decision.
 */

import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.KNOCK_KNOCK_STATE_DIR = mkdtempSync(join(tmpdir(), 'kk-owner-cmd-'))

const { AgentHost } = await import('../../src/agent-host.ts')
const { SqliteStore } = await import('../../src/ledger/store-sqlite.ts')
const { FoldEngine } = await import('../../src/ledger/fold.ts')

const OWNER = 'OWNER_USER'
const CH = 'ch1'

function harness() {
  const agent: any = { platform: 'discord', runtime: 'claude-sdk', workspace: '/tmp', ownerUserId: OWNER, rooms: {} }
  const access: any = { agents: { cc: agent } }
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const ui: any = { note() {}, error() {} }
  const ledger: any = {}
  const host: any = new AgentHost('cc', agent, () => access, ui, ledger, store, engine)

  const sent: string[] = []
  host.messaging = {
    platform: 'discord',
    send: async (_c: string, t: string) => { sent.push(t) },
    parentOfSync: () => undefined,
  }
  // Focus the test on the gate decision: the agent/owner lookups are exercised elsewhere.
  host.getAgentForChannel = () => ({ agentKey: 'cc', loopGuardOpts: {} })
  host.getOwnerForChannel = () => OWNER
  return { host, sent }
}

beforeEach(() => { process.env.KNOCK_KNOCK_STATE_DIR ||= mkdtempSync(join(tmpdir(), 'kk-owner-cmd-')) })

test('!clear from a non-owner is a no-op (no session deletion, no message)', async () => {
  const { host, sent } = harness()
  host.sessions.set(CH, { driver: { currentSessionId: 's1' } })
  await host.handleClearSession(CH, 'SOMEONE_ELSE')
  expect(host.sessions.has(CH)).toBe(true)
  expect(sent).toEqual([])
})

test('!clear while a turn is in flight refuses and keeps the session (so !stop still works)', async () => {
  const { host, sent } = harness()
  host.sessions.set(CH, { driver: { currentSessionId: 's1' }, activeTurn: { abort: new AbortController() } })
  await host.handleClearSession(CH, OWNER)
  expect(host.sessions.has(CH)).toBe(true) // not orphaned
  expect(sent.join(' ')).toContain('!stop first')
})

test('!clear from the owner with no live turn clears the session', async () => {
  const { host, sent } = harness()
  host.sessions.set(CH, { driver: { currentSessionId: 's1' } })
  await host.handleClearSession(CH, OWNER)
  expect(host.sessions.has(CH)).toBe(false)
  expect(sent.join(' ')).toContain('cleared')
})

test('!compact from a non-owner is a no-op', async () => {
  const { host, sent } = harness()
  host.sessions.set(CH, { driver: { currentSessionId: 's1' } })
  await host.handleCompactSession(CH, 'SOMEONE_ELSE')
  expect(host.sessions.has(CH)).toBe(true)
  expect(sent).toEqual([])
})

test('!compact while a turn is in flight refuses without touching the session', async () => {
  const { host, sent } = harness()
  host.sessions.set(CH, { driver: { currentSessionId: 's1' }, activeTurn: { abort: new AbortController() } })
  await host.handleCompactSession(CH, OWNER)
  expect(host.sessions.has(CH)).toBe(true)
  expect(sent.join(' ')).toContain('!stop first')
})

test('!compact from the owner with no active session reports nothing to compact', async () => {
  const { host, sent } = harness()
  await host.handleCompactSession(CH, OWNER)
  expect(sent.join(' ')).toContain('Nothing to compact')
})
