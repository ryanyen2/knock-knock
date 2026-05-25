import { test, expect } from 'bun:test'
import {
  approverFor,
  guildSenderAllowed,
  isWithinRoots,
  buildRosterLines,
  pruneExpired,
  chunk,
  defaultAccess,
  type Access,
  type RoomConfig,
} from './lib.ts'

function room(overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    requireMention: true,
    participants: {},
    humans: [],
    sendableRoots: [],
    ...overrides,
  }
}

function access(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

// ─── approverFor: who may approve this agent's work ──────────────────────────

test('approverFor falls back to self.ownerUserId when no room override', () => {
  const a = access({
    self: { name: 'A', ownerUserId: 'owner1', blurb: '', roomChannelId: 'chan1' },
    rooms: { chan1: room() },
  })
  expect(approverFor(a)).toBe('owner1')
})

test('approverFor prefers room.approvalActorId over self owner', () => {
  const a = access({
    self: { name: 'A', ownerUserId: 'owner1', blurb: '', roomChannelId: 'chan1' },
    rooms: { chan1: room({ approvalActorId: 'delegate2' }) },
  })
  expect(approverFor(a)).toBe('delegate2')
})

test('approverFor is undefined when self is unconfigured', () => {
  expect(approverFor(access())).toBeUndefined()
})

// ─── guildSenderAllowed: who may drive this agent in a room ──────────────────

test('guildSenderAllowed accepts a registered peer bot', () => {
  const r = room({ participants: { peerBot: { name: 'C', blurb: '' } } })
  expect(guildSenderAllowed(r, 'peerBot', 'selfBot')).toBe(true)
})

test('guildSenderAllowed accepts a listed human', () => {
  const r = room({ humans: ['human1'] })
  expect(guildSenderAllowed(r, 'human1', 'selfBot')).toBe(true)
})

test('guildSenderAllowed rejects an unknown sender', () => {
  expect(guildSenderAllowed(room(), 'stranger', 'selfBot')).toBe(false)
})

test('guildSenderAllowed rejects self even if listed (loop guard)', () => {
  const r = room({ participants: { selfBot: { name: 'me', blurb: '' } } })
  expect(guildSenderAllowed(r, 'selfBot', 'selfBot')).toBe(false)
})

// ─── isWithinRoots: the send-path security boundary ──────────────────────────

test('isWithinRoots accepts a file nested under a root', () => {
  expect(isWithinRoots('/home/me/proj/src/a.ts', ['/home/me/proj'])).toBe(true)
})

test('isWithinRoots accepts the root itself', () => {
  expect(isWithinRoots('/home/me/proj', ['/home/me/proj'])).toBe(true)
})

test('isWithinRoots rejects a file outside all roots', () => {
  expect(isWithinRoots('/etc/passwd', ['/home/me/proj'])).toBe(false)
})

test('isWithinRoots rejects a sibling-prefix path (no partial match)', () => {
  // /home/me/project-secret must NOT match root /home/me/proj
  expect(isWithinRoots('/home/me/proj-secret/x', ['/home/me/proj'])).toBe(false)
})

test('isWithinRoots rejects everything when roots is empty', () => {
  expect(isWithinRoots('/anything', [])).toBe(false)
})

// ─── buildRosterLines ────────────────────────────────────────────────────────

test('buildRosterLines formats peers with mention handles', () => {
  const a = access({
    self: { name: 'A', ownerUserId: 'o', blurb: '', roomChannelId: 'chan1' },
    rooms: {
      chan1: room({
        participants: {
          '111': { name: 'agent-C', blurb: 'schema specialist' },
          '222': { name: 'agent-B', blurb: 'deploy agent' },
        },
      }),
    },
  })
  const lines = buildRosterLines(a)
  expect(lines).toContain('agent-C (<@111>): schema specialist')
  expect(lines).toContain('agent-B (<@222>): deploy agent')
})

test('buildRosterLines is empty when no peers', () => {
  const a = access({
    self: { name: 'A', ownerUserId: 'o', blurb: '', roomChannelId: 'chan1' },
    rooms: { chan1: room() },
  })
  expect(buildRosterLines(a)).toBe('')
})

// ─── pruneExpired ──────────────────────────────────────────────────────────────

test('pruneExpired removes expired codes and reports the change', () => {
  const now = Date.now()
  const a = access({
    pending: {
      old: { senderId: 's', chatId: 'c', createdAt: 0, expiresAt: now - 1000, replies: 1 },
      fresh: { senderId: 's', chatId: 'c', createdAt: 0, expiresAt: now + 60_000, replies: 1 },
    },
  })
  expect(pruneExpired(a)).toBe(true)
  expect(Object.keys(a.pending)).toEqual(['fresh'])
})

test('pruneExpired reports no change when nothing expired', () => {
  const a = access()
  expect(pruneExpired(a)).toBe(false)
})

// ─── chunk: Discord 2000-char split ──────────────────────────────────────────

test('chunk returns a single piece under the limit', () => {
  expect(chunk('hello', 2000, 'length')).toEqual(['hello'])
})

test('chunk splits oversized text and preserves all content', () => {
  const text = 'a'.repeat(4500)
  const parts = chunk(text, 2000, 'length')
  expect(parts.length).toBe(3)
  expect(parts.join('').length).toBe(4500)
  expect(parts.every(p => p.length <= 2000)).toBe(true)
})
