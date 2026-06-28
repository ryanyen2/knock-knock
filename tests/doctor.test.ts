/**
 * kk doctor (U10) — the pure report cores: cross-machine availability from the relay heartbeat,
 * pending-proposal summaries, and the trust-integrity assertions (R23/R24/R25 + the R11
 * impersonation guard). The live per-channel checks are impure glue around these and the resolver.
 */

import { test, expect } from 'bun:test'
import { crossMachineStatus, pendingSummary, integrityChecks, RELAY_STALE_MS, PROPOSAL_STALE_MS } from '../src/doctor.ts'
import type { PendingStore } from '../src/state.ts'
import type { AuthoringAccess, Proposal, TrustAnchors } from '../src/lib.ts'

const NOW = Date.parse('2026-06-28T12:00:00.000Z')

const peerProp = (over: Partial<Proposal> = {}): Proposal => ({
  kind: 'peer',
  platform: 'discord',
  targetId: 'U_remote',
  claimed: { agentKey: 'rk', userId: 'U_remote', label: 'deploy' },
  discoveredAt: '2026-06-28T11:59:00.000Z',
  status: 'proposed',
  ...over,
})

const authoring = (over: Partial<AuthoringAccess> = {}): AuthoringAccess => ({
  bots: { cc: { platform: 'discord', tokenEnv: 'T', runtime: 'claude-sdk' } },
  channels: {},
  roster: { people: {}, peers: {} },
  me: { discord: 'U_owner' },
  ...over,
})
const noTrust: TrustAnchors = { tombstones: [], trustedPairs: [] }

test('U10: crossMachineStatus distinguishes relay-offline from genuinely-none', () => {
  // absent heartbeat → offline
  expect(crossMachineStatus({ proposals: [] }, NOW)).toBe('unavailable-relay-offline')
  // stale heartbeat → offline
  expect(crossMachineStatus({ proposals: [], lastScanAt: new Date(NOW - RELAY_STALE_MS - 1000).toISOString() }, NOW)).toBe('unavailable-relay-offline')
  // fresh heartbeat, no proposals → none
  expect(crossMachineStatus({ proposals: [], lastScanAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe('none')
  // fresh heartbeat with a proposal → available
  expect(crossMachineStatus({ proposals: [peerProp()], lastScanAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe('available')
})

test('U10: pendingSummary describes the kind and flags aging proposals', () => {
  expect(pendingSummary(peerProp(), NOW).summary).toContain('peer deploy (U_remote)')
  expect(pendingSummary(peerProp({ kind: 'transport', targetId: 'discord', claimed: {} }), NOW).summary).toContain('transport channel on discord')
  expect(pendingSummary(peerProp(), NOW).stale).toBe(false)
  expect(pendingSummary(peerProp({ discoveredAt: new Date(NOW - PROPOSAL_STALE_MS - 1000).toISOString() }), NOW).stale).toBe(true)
})

test('U10/R25: a pending peer colliding with the confirmed owner is flagged', () => {
  const pending: PendingStore = { proposals: [peerProp({ targetId: 'U_owner', claimed: { agentKey: 'rk', userId: 'U_owner' } })] }
  const checks = integrityChecks(authoring(), pending, noTrust)
  expect(checks.some(c => !c.ok && c.label.includes('collides with your confirmed owner'))).toBe(true)
})

test('U10/R24: a trusted key now claiming a different user-id is flagged', () => {
  const pending: PendingStore = { proposals: [peerProp({ claimed: { agentKey: 'rk', userId: 'U_new' } })] }
  const trust: TrustAnchors = { tombstones: [], trustedPairs: [{ agentKey: 'rk', userId: 'U_old', trustedAt: 't' }] }
  const checks = integrityChecks(authoring(), pending, trust)
  expect(checks.some(c => !c.ok && c.label.includes('different user-id'))).toBe(true)
})

test('U10/R23: a pending peer also confirmed in the roster (stale entry) is flagged', () => {
  const a = authoring({ roster: { people: {}, peers: { p: { platform: 'discord', userId: 'U_remote', blurb: 'b', agentKey: 'rk' } } } })
  const checks = integrityChecks(a, { proposals: [peerProp()] }, noTrust)
  expect(checks.some(c => !c.ok && c.label.includes('already confirmed in the roster'))).toBe(true)
})

test('U10/R11: a remote beacon impersonating a local agent-key is flagged', () => {
  // local bot key is "cc"; a pending proposal claims agentKey "cc"
  const pending: PendingStore = { proposals: [peerProp({ claimed: { agentKey: 'cc', userId: 'U_x' } })] }
  const checks = integrityChecks(authoring(), pending, noTrust)
  expect(checks.some(c => !c.ok && c.label.includes('claims your local agent-key'))).toBe(true)
})

test('U10: a clean configuration reports a single ok integrity line', () => {
  const checks = integrityChecks(authoring(), { proposals: [] }, noTrust)
  expect(checks).toHaveLength(1)
  expect(checks[0]!.ok).toBe(true)
})
