import { test, expect } from 'bun:test'
import {
  approverFor,
  guildSenderAllowed,
  senderKind,
  isWithinRoots,
  buildRosterLines,
  pruneExpired,
  chunk,
  classifyTool,
  defaultAccess,
  type Access,
  type RoomConfig,
} from './lib.ts'

// ─── classifyTool: the ACP/runtime-agnostic policy floor ─────────────────────

const PROFILE = {
  allow: ['Read(**)'],
  ask: ['Bash(*)'],
  deny: ['Bash(rm -rf *)', 'Bash(sudo *)'],
}

test('T1: a read tool is auto-allowed without a prompt', () => {
  expect(classifyTool(PROFILE, { kind: 'read', title: 'List directory' })).toBe('allow')
})

test('T2: a shell command falls through to ask (owner prompt)', () => {
  expect(classifyTool(PROFILE, { kind: 'execute', subject: 'bun test' })).toBe('ask')
})

test('T3: rm -rf is denied even though Bash(*) is on the ask list', () => {
  expect(classifyTool(PROFILE, { kind: 'execute', subject: 'rm -rf /tmp/x' })).toBe('deny')
})

test('T3: deny survives command chaining (cd /tmp && rm -rf x)', () => {
  expect(classifyTool(PROFILE, { kind: 'execute', subject: 'cd /tmp && rm -rf x' })).toBe('deny')
})

test('deny matches sudo at a command boundary', () => {
  expect(classifyTool(PROFILE, { kind: 'execute', subject: 'sudo rm file' })).toBe('deny')
})

test('deny does not false-match a substring inside another word', () => {
  // "rm" core must sit at a boundary; "charm" must not trigger the rm -rf deny.
  expect(
    classifyTool({ allow: [], ask: ['Bash(*)'], deny: ['Bash(rm *)'] }, {
      kind: 'execute',
      subject: 'echo charming',
    }),
  ).toBe('ask')
})

test('T3 deny floor holds even when the agent mislabels the tool kind', () => {
  // Observed in the wild: OpenCode surfaced the same `rm -rf` as kind "other"
  // first, then "execute". The deny literal must block it regardless of kind.
  expect(classifyTool(PROFILE, { kind: 'other', subject: 'rm -rf /tmp/x' })).toBe('deny')
  expect(classifyTool(PROFILE, { kind: 'read', subject: 'sudo rm file' })).toBe('deny')
})

test('unmatched tool defaults to ask, never silently allowed', () => {
  expect(classifyTool(PROFILE, { kind: 'fetch', subject: 'https://example.com' })).toBe('ask')
})

test('explicit toolName matches a pattern even without a kind', () => {
  expect(classifyTool(PROFILE, { toolName: 'Read', subject: 'README.md' })).toBe('allow')
})

test('falls back to title when no subject is provided', () => {
  expect(classifyTool(PROFILE, { kind: 'execute', title: 'rm -rf node_modules' })).toBe('deny')
})

test('a bare tool pattern with no arg matches any subject', () => {
  expect(classifyTool({ allow: ['Read'], ask: [], deny: [] }, { kind: 'read', subject: 'x' })).toBe(
    'allow',
  )
})

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

test('guildSenderAllowed allows the owner even when not a participant or listed human', () => {
  expect(guildSenderAllowed(room(), 'owner1', 'selfBot', 'owner1')).toBe(true)
})

test('guildSenderAllowed still blocks self when self happens to be the owner', () => {
  expect(guildSenderAllowed(room(), 'selfBot', 'selfBot', 'selfBot')).toBe(false)
})

// ─── senderKind: priority classification ─────────────────────────────────────

test('senderKind labels the owner, humans, peers, and strangers', () => {
  const r = room({
    participants: { peerBot: { name: 'C', blurb: '' } },
    humans: ['human1'],
  })
  expect(senderKind(r, 'owner1', 'owner1')).toBe('owner')
  expect(senderKind(r, 'human1', 'owner1')).toBe('human')
  expect(senderKind(r, 'peerBot', 'owner1')).toBe('agent')
  expect(senderKind(r, 'stranger', 'owner1')).toBe('unknown')
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
