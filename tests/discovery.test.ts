/**
 * Shared snapshot assembler (U4). Uses fake DiscoveryAdapters (no live SDK) to prove the
 * capability-branched gathering, the carried-through three-valued outcomes, the offline-doctor
 * path (directory from pending, marked unavailable), and source→snapshot determinism.
 */

import { test, expect, beforeEach } from 'bun:test'
import { assembleSnapshot, clearSnapshotCache, connectDiscoveryAdapter, itemsOf } from '../src/discovery.ts'

const itemsOfCh = (o: EnumerationOutcome): string[] => itemsOf(o).map(i => i.id)
import type { DiscoveryAdapter } from '../src/discovery.ts'
import type { DiscoveryCapabilities, EnumerationOutcome } from '../src/messaging-adapter.ts'
import type { AgentIdentity, Bot } from '../src/lib.ts'

const CAP_FULL: DiscoveryCapabilities = { selfId: true, channelEnumeration: true, memberEnumeration: true, channelCreation: true }
const CAP_NONE: DiscoveryCapabilities = { selfId: true, channelEnumeration: false, memberEnumeration: false, channelCreation: false }

function fakeAdapter(over: Partial<DiscoveryAdapter> & { caps?: DiscoveryCapabilities } = {}): DiscoveryAdapter {
  const caps = over.caps ?? CAP_FULL
  return {
    botUserId: over.botUserId ?? 'U_self',
    botLabel: over.botLabel ?? 'self-bot',
    discoveryCapabilities: () => caps,
    ...(over.listChannels ? { listChannels: over.listChannels } : {}),
    ...(over.listMembers ? { listMembers: over.listMembers } : {}),
  }
}

const ident = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentKey: 'peerKey',
  platform: 'discord',
  userId: 'U_peer',
  rooms: ['C1'],
  ...over,
})

beforeEach(() => clearSnapshotCache())

test('member-enumeration-capable adapter → snapshot carries the member list + self-id', async () => {
  const adapter = fakeAdapter({
    listMembers: async () => ({ kind: 'results', items: [{ id: 'U1', label: 'alice' }] }),
  })
  const snap = await assembleSnapshot({ platform: 'discord', adapter, channelId: 'C1' })
  expect(snap.selfId).toBe('U_self')
  expect(snap.members).toEqual({ kind: 'results', items: [{ id: 'U1', label: 'alice' }] })
})

test('a degraded member outcome is carried with its reason (drives R15)', async () => {
  const adapter = fakeAdapter({
    listMembers: async (): Promise<EnumerationOutcome> => ({ kind: 'degraded', reason: 'intent not granted' }),
  })
  const snap = await assembleSnapshot({ platform: 'discord', adapter, channelId: 'C1' })
  expect(snap.members).toEqual({ kind: 'degraded', reason: 'intent not granted' })
})

test('a member-incapable platform reports unsupported, never an empty list mislabeled as "no members"', async () => {
  const adapter = fakeAdapter({ caps: CAP_NONE })
  const snap = await assembleSnapshot({ platform: 'telegram', adapter, channelId: 'C1' })
  expect(snap.members).toEqual({ kind: 'unsupported' })
  expect(snap.channels).toEqual({ kind: 'unsupported' })
})

test('no adapter (offline doctor): peers come from the supplied directory, live directory marked unavailable', async () => {
  const snap = await assembleSnapshot({
    platform: 'discord',
    directory: [ident(), ident({ platform: 'slack', userId: 'U_slack' })],
    directoryAvailable: false,
  })
  expect(snap.directoryAvailable).toBe(false)
  expect(snap.directoryPeers.map(p => p.userId)).toEqual(['U_peer']) // scoped to platform
  expect(snap.selfId).toBeUndefined()
  expect(snap.members).toEqual({ kind: 'unsupported' })
})

test('directory present without an override is treated as available', async () => {
  const snap = await assembleSnapshot({ platform: 'discord', directory: [ident()] })
  expect(snap.directoryAvailable).toBe(true)
})

test('the same sources produce the same snapshot regardless of caller (drift-prevention)', async () => {
  const mk = () =>
    fakeAdapter({ listMembers: async () => ({ kind: 'results', items: [{ id: 'U1', label: 'a' }] }) })
  const a = await assembleSnapshot({ platform: 'discord', adapter: mk(), channelId: 'C1', directory: [ident()] })
  const b = await assembleSnapshot({ platform: 'discord', adapter: mk(), channelId: 'C1', directory: [ident()] })
  expect(JSON.stringify(a)).toBe(JSON.stringify(b))
})

test('enumeration cache is keyed per-bot: two same-platform adapters get their OWN channel lists', async () => {
  // listChannels is bot-specific — each bot sees only the channels it can access. The cache must
  // not let a second same-platform bot reuse the first bot's list within the TTL (doctor regression).
  const a = fakeAdapter({ botUserId: 'U_a', listChannels: async () => ({ kind: 'results', items: [{ id: 'A', label: 'guildA' }] }) })
  const b = fakeAdapter({ botUserId: 'U_b', listChannels: async () => ({ kind: 'results', items: [{ id: 'B', label: 'guildB' }] }) })
  const snapA = await assembleSnapshot({ platform: 'discord', adapter: a })
  const snapB = await assembleSnapshot({ platform: 'discord', adapter: b })
  expect(itemsOfCh(snapA.channels)).toEqual(['A'])
  expect(itemsOfCh(snapB.channels)).toEqual(['B']) // NOT 'A' from a stale platform-only cache key
})

test('connectDiscoveryAdapter returns undefined when the token env is unset', async () => {
  const bot: Bot = { platform: 'discord', tokenEnv: 'KK_TEST_TOKEN_UNSET_XYZ', runtime: 'claude-sdk' }
  expect(await connectDiscoveryAdapter(bot, {})).toBeUndefined()
})
