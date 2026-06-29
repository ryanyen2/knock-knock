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

// ─── Bob Shell runtime preflight ──────────────────────────────────────────────

import { bobInUse, bobPreflightChecks } from '../src/doctor.ts'

const access = (over: Partial<AuthoringAccess> = {}): AuthoringAccess =>
  ({ bots: {}, channels: {}, roster: { peers: {}, humans: {} }, me: {}, ...over } as unknown as AuthoringAccess)

test('bobInUse: true when a bot default runtime is bob', () => {
  expect(bobInUse(access({ bots: { b1: { runtime: 'bob' } } as any }))).toBe(true)
})

test('bobInUse: true when a channel membership picks bob', () => {
  const a = access({
    bots: { b1: { runtime: 'claude-sdk' } } as any,
    channels: { c1: { members: [{ bot: 'b1', runtime: 'bob' }] } } as any,
  })
  expect(bobInUse(a)).toBe(true)
})

test('bobInUse: false when no bob anywhere', () => {
  const a = access({
    bots: { b1: { runtime: 'claude-sdk' } } as any,
    channels: { c1: { members: [{ bot: 'b1' }] } } as any,
  })
  expect(bobInUse(a)).toBe(false)
})

test('bobPreflightChecks: no lines when bob not in use', () => {
  expect(bobPreflightChecks(false, false, false)).toEqual([])
})

test('bobPreflightChecks: both pass when bob present + key set', () => {
  const checks = bobPreflightChecks(true, true, true)
  expect(checks.length).toBe(2)
  expect(checks.every(c => c.ok)).toBe(true)
})

test('bobPreflightChecks: missing key fails with an actionable fix', () => {
  const checks = bobPreflightChecks(true, true, false)
  const keyCheck = checks.find(c => c.label.includes('BOBSHELL_API_KEY'))!
  expect(keyCheck.ok).toBe(false)
  expect(keyCheck.fix).toContain('BOBSHELL_API_KEY')
})

test('bobPreflightChecks: missing binary fails with an install fix', () => {
  const checks = bobPreflightChecks(true, false, true)
  const pathCheck = checks.find(c => c.label.includes('bob'))!
  expect(pathCheck.ok).toBe(false)
  expect(pathCheck.fix).toContain('install')
})
