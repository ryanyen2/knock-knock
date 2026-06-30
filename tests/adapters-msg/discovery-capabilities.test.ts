/**
 * Discovery-capability descriptor (U1) — each adapter's static claim for the gap-resolver's
 * fill ladder, matched against the origin capability matrix. Read WITHOUT connecting (the
 * resolver picks a fill rung before any network call), so these assert on bare instances.
 */

import { test, expect } from 'bun:test'
import { makeMessagingAdapter } from '../../src/adapters-msg/index.ts'
import type { Platform } from '../../src/lib.ts'
import type { DiscoveryCapabilities } from '../../src/messaging-adapter.ts'

// The origin matrix (docs/brainstorms/2026-06-28-auto-configuring-onboarding-requirements.md):
// channel binding enumerable on Discord/Slack only; members enumerable everywhere except
// Telegram; transport-channel creation on Discord/Slack only; self-ID derivable on all.
const EXPECTED: Record<Platform, DiscoveryCapabilities> = {
  discord: { selfId: true, channelEnumeration: true, memberEnumeration: true, channelCreation: true },
  slack: { selfId: true, channelEnumeration: true, memberEnumeration: true, channelCreation: true },
  telegram: { selfId: true, channelEnumeration: false, memberEnumeration: false, channelCreation: false },
  github: { selfId: true, channelEnumeration: false, memberEnumeration: true, channelCreation: false },
  notion: { selfId: true, channelEnumeration: false, memberEnumeration: true, channelCreation: false },
}

for (const [platform, expected] of Object.entries(EXPECTED) as [Platform, DiscoveryCapabilities][]) {
  test(`${platform}: discovery descriptor matches the origin matrix (pure read, no connect)`, () => {
    const adapter = makeMessagingAdapter(platform)
    // The method is optional on the interface (minimal adapters may omit it), but every real
    // adapter implements it — that's exactly what this test asserts.
    expect(adapter.discoveryCapabilities!()).toEqual(expected)
  })
}

test('self-ID is declared on every platform (never prompted)', () => {
  for (const platform of Object.keys(EXPECTED) as Platform[]) {
    expect(makeMessagingAdapter(platform).discoveryCapabilities!().selfId).toBe(true)
  }
})

test('channel creation is declared only where a channel can be auto-created (Discord/Slack)', () => {
  const creators = (Object.keys(EXPECTED) as Platform[]).filter(
    p => makeMessagingAdapter(p).discoveryCapabilities!().channelCreation,
  )
  expect(creators.sort()).toEqual(['discord', 'slack'])
})
