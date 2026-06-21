/**
 * Pure decision-logic tests for lib.ts — the security-critical and routing rules
 * that have no I/O. Fresh, targeted coverage re-established after the test net was
 * dropped (commit a68eb05); tied to the functions the cohesion-hardening plan
 * (U2) names and to the seams later units touch. No store, no Discord, no mocks.
 */

import { test, expect } from 'bun:test'
import {
  classifyTool,
  DENY_FLOOR,
  PRESET_MODES,
  DEFAULT_PRESET,
  expandPreset,
  resolveProfileForActor,
  resolveRoomForScope,
  resolveReactionScope,
  resolveLedgerConfig,
  loopGuard,
  FRESH_WATCH_GATE,
  watchGate,
  parseWatchCommand,
  pickFreshContext,
  threadNameFromPrompt,
  matchesMentionPattern,
  guildSenderAllowed,
  senderKind,
  isShareSessionCommand,
  isResumeSessionCommand,
  projectChannelConfig,
  parseConfigCommand,
  wrapChannelRole,
  CHAT_SETTABLE_KEYS,
  ROLE_MAX_LEN,
  type ConfigDeltaRecord,
  type WatchSpec,
  type RoomConfig,
} from './lib.ts'

// ─── classifyTool ────────────────────────────────────────────────────────────

const FLOORED = { allow: ['Read(**)'], ask: ['Edit(**)'], deny: [...DENY_FLOOR] }

test('classifyTool: a deny literal is blocked regardless of the ToolKind label', () => {
  // The same `rm -rf` can arrive labeled `execute` or `other`; the deny floor
  // must not hinge on the label (denyLiteralHit is checked first).
  const asExecute = classifyTool(FLOORED, { kind: 'execute', subject: 'rm -rf /tmp/x' })
  const asOther = classifyTool(FLOORED, { kind: 'other', subject: 'rm -rf /tmp/x' })
  expect(asExecute).toBe('deny')
  expect(asOther).toBe('deny')
})

test('classifyTool: a chained dangerous command still trips the deny floor', () => {
  expect(classifyTool(FLOORED, { kind: 'execute', subject: 'cd /tmp && rm -rf x' })).toBe('deny')
})

test('classifyTool: an unmatched tool defaults to ask (never silent allow)', () => {
  expect(classifyTool(FLOORED, { toolName: 'SomeUnknownTool', subject: 'whatever' })).toBe('ask')
})

test('classifyTool: deny wins over ask wins over allow', () => {
  const p = { allow: ['Bash(*)'], ask: ['Bash(rm *)'], deny: ['Bash(rm -rf *)'] }
  expect(classifyTool(p, { kind: 'execute', subject: 'rm -rf /' })).toBe('deny')
  expect(classifyTool(p, { kind: 'execute', subject: 'rm foo' })).toBe('ask')
  expect(classifyTool(p, { kind: 'execute', subject: 'ls' })).toBe('allow')
})

test('classifyTool: glob arg matches the subject case-insensitively', () => {
  const p = { allow: ['Read(**)'], ask: [], deny: [] }
  expect(classifyTool(p, { toolName: 'Read', subject: '/Any/Path.ts' })).toBe('allow')
})

// ─── presets ─────────────────────────────────────────────────────────────────

test('every preset carries the full deny floor (deny is never empty)', () => {
  for (const [name, profile] of Object.entries(PRESET_MODES)) {
    for (const f of DENY_FLOOR) {
      expect(profile.deny, `${name} missing floor ${f}`).toContain(f)
    }
  }
})

test('bypass preset is wide-open except the deny floor', () => {
  const bypass = PRESET_MODES.bypass!
  // The floor still denies destructive commands even under bypass.
  expect(classifyTool(bypass, { kind: 'execute', subject: 'rm -rf /' })).toBe('deny')
  // …but ordinary commands/edits are allowed.
  expect(classifyTool(bypass, { kind: 'execute', subject: 'ls -la' })).toBe('allow')
  expect(classifyTool(bypass, { kind: 'edit', subject: 'src/x.ts' })).toBe('allow')
})

test('expandPreset: unknown name falls back to the safe default preset', () => {
  expect(expandPreset('does-not-exist')).toEqual(expandPreset(DEFAULT_PRESET))
})

test('expandPreset: overrides union into the floor and never weaken deny', () => {
  const out = expandPreset('strict', { deny: ['Bash(curl *)'], allow: ['Edit(**)'] })
  for (const f of DENY_FLOOR) expect(out.deny).toContain(f)
  expect(out.deny).toContain('Bash(curl *)')
  expect(out.allow).toContain('Edit(**)')
})

test('expandPreset: dedupes repeated patterns', () => {
  const out = expandPreset('strict', { deny: [...DENY_FLOOR] })
  expect(out.deny.length).toBe(new Set(out.deny).size)
})

// ─── resolveProfileForActor ──────────────────────────────────────────────────

const BASE = { allow: ['Read(**)', 'Edit(**)'], ask: ['Bash(*)'], deny: ['Bash(rm -rf *)'] }

test('resolveProfileForActor: owner gets the base floor unchanged', () => {
  expect(resolveProfileForActor(BASE, { agent: { allow: [] } }, 'owner')).toEqual(BASE)
})

test('resolveProfileForActor: absent tier falls back to base, never empty', () => {
  expect(resolveProfileForActor(BASE, undefined, 'agent')).toEqual(BASE)
  expect(resolveProfileForActor(BASE, { human: { allow: [] } }, 'agent')).toEqual(BASE)
})

test('resolveProfileForActor: most-specific tier wins for allow/ask', () => {
  const tiers = {
    agent: { allow: ['Read(**)'] },
    'peer:BOT9': { allow: ['Read(**)', 'Edit(src/**)'] },
  }
  const out = resolveProfileForActor(BASE, tiers, 'agent', 'BOT9')
  expect(out.allow).toEqual(['Read(**)', 'Edit(src/**)'])
})

test('resolveProfileForActor: deny is the union of base + all applicable tiers', () => {
  const tiers = {
    agent: { deny: ['Bash(curl *)'] },
    'peer:BOT9': { deny: ['Write(/etc/**)'] },
  }
  const out = resolveProfileForActor(BASE, tiers, 'agent', 'BOT9')
  expect(out.deny).toContain('Bash(rm -rf *)') // base floor preserved
  expect(out.deny).toContain('Bash(curl *)')
  expect(out.deny).toContain('Write(/etc/**)')
})

// ─── resolveRoomForScope ─────────────────────────────────────────────────────

const ROOMS: Record<string, RoomConfig> = {
  ROOM1: { requireMention: true, participants: {}, humans: [] },
}

test('resolveRoomForScope: a served room id resolves to itself', () => {
  expect(resolveRoomForScope('ROOM1', ROOMS, new Map(), () => undefined)).toBe('ROOM1')
})

test('resolveRoomForScope: a thread resolves to its parent via the memo', () => {
  const memo = new Map([['THREAD1', 'ROOM1']])
  expect(resolveRoomForScope('THREAD1', ROOMS, memo, () => undefined)).toBe('ROOM1')
})

test('resolveRoomForScope: a thread resolves to its parent via the parentOf probe', () => {
  expect(resolveRoomForScope('THREAD1', ROOMS, new Map(), id => (id === 'THREAD1' ? 'ROOM1' : undefined))).toBe('ROOM1')
})

test('resolveRoomForScope: an unresolved scope returns undefined (fail-restrictive)', () => {
  expect(resolveRoomForScope('UNKNOWN', ROOMS, new Map(), () => undefined)).toBeUndefined()
})

// ─── resolveReactionScope ────────────────────────────────────────────────────

test('resolveReactionScope: a reaction on a message that spawned a thread targets the thread', () => {
  const map = new Map([['MSG_TOP', 'THREAD1']])
  expect(resolveReactionScope('MSG_TOP', 'PARENT_CHANNEL', map)).toBe('THREAD1')
})

test('resolveReactionScope: an unmapped reaction targets its own channel', () => {
  const map = new Map([['MSG_TOP', 'THREAD1']])
  // A 🔁 on a bot reply posted in-thread: its scope is already the thread.
  expect(resolveReactionScope('BOT_REPLY', 'THREAD1', map)).toBe('THREAD1')
  // A reaction in a plain channel (no thread spawned).
  expect(resolveReactionScope('MSG_PLAIN', 'CHANNEL', new Map())).toBe('CHANNEL')
})

// ─── resolveLedgerConfig ─────────────────────────────────────────────────────

test('resolveLedgerConfig: KNOCK_KNOCK_LEDGER_URL env always wins', () => {
  const out = resolveLedgerConfig({ KNOCK_KNOCK_LEDGER_URL: 'postgres://x' }, { ledger: { backend: 'sqlite' } })
  expect(out).toEqual({ backend: 'postgres', url: 'postgres://x' })
})

test('resolveLedgerConfig: settings postgres needs a url, else falls through to sqlite', () => {
  expect(resolveLedgerConfig({}, { ledger: { backend: 'postgres' } }).backend).toBe('sqlite')
  expect(resolveLedgerConfig({}, { ledger: { backend: 'postgres', url: 'postgres://y' } })).toEqual({
    backend: 'postgres',
    url: 'postgres://y',
  })
})

test('resolveLedgerConfig: sqlite default honors KNOCK_KNOCK_LEDGER_FILE', () => {
  expect(resolveLedgerConfig({ KNOCK_KNOCK_LEDGER_FILE: '/tmp/l.sqlite' }, {})).toEqual({
    backend: 'sqlite',
    file: '/tmp/l.sqlite',
  })
})

// ─── loopGuard ───────────────────────────────────────────────────────────────

test('loopGuard: owner/human always pass and reset the consecutive counter', () => {
  const state = { consecutiveAgentTurns: 3, lastAgentReplyAt: 1000 }
  const owner = loopGuard(state, 'owner', 2000)
  expect(owner.decision.allow).toBe(true)
  expect(owner.next.consecutiveAgentTurns).toBe(0)
})

test('loopGuard: agent turns trip the threshold', () => {
  const state = { consecutiveAgentTurns: 4, lastAgentReplyAt: 0 }
  const out = loopGuard(state, 'agent', 1_000_000, { maxConsecutive: 4, cooldownMs: 1000 })
  expect(out.decision).toEqual({ allow: false, reason: 'threshold' })
})

test('loopGuard: agent turns inside the cooldown window are suppressed', () => {
  const state = { consecutiveAgentTurns: 0, lastAgentReplyAt: 1000 }
  const out = loopGuard(state, 'agent', 1500, { maxConsecutive: 4, cooldownMs: 1000 })
  expect(out.decision).toEqual({ allow: false, reason: 'cooldown' })
})

test('loopGuard: an allowed agent turn increments the counter and records the time', () => {
  const state = { consecutiveAgentTurns: 1, lastAgentReplyAt: 0 }
  const out = loopGuard(state, 'agent', 50_000, { maxConsecutive: 4, cooldownMs: 1000 })
  expect(out.decision.allow).toBe(true)
  expect(out.next.consecutiveAgentTurns).toBe(2)
  expect(out.next.lastAgentReplyAt).toBe(50_000)
})

// ─── watchGate ───────────────────────────────────────────────────────────────

const matchSpec: WatchSpec = {
  name: 'w', channel: 'C', agentKey: 'a', command: 'tail -f log',
  fireOn: { kind: 'match', pattern: 'ERROR' },
}

test('watchGate: each-line fires on non-empty lines but not on exit', () => {
  const spec: WatchSpec = { ...matchSpec, fireOn: { kind: 'each-line' } }
  expect(watchGate(spec, FRESH_WATCH_GATE, 'hello').fire).toBe(true)
  expect(watchGate(spec, FRESH_WATCH_GATE, '   ').fire).toBe(false)
  expect(watchGate(spec, FRESH_WATCH_GATE, 'x', true).fire).toBe(false)
})

test('watchGate: change fires only when the line differs from the last fired', () => {
  const spec: WatchSpec = { ...matchSpec, fireOn: { kind: 'change' } }
  const first = watchGate(spec, FRESH_WATCH_GATE, 'a')
  expect(first.fire).toBe(true)
  expect(watchGate(spec, first.next, 'a').fire).toBe(false)
  expect(watchGate(spec, first.next, 'b').fire).toBe(true)
})

test('watchGate: match fires on the regex and increments fires', () => {
  const out = watchGate(matchSpec, FRESH_WATCH_GATE, 'an ERROR happened')
  expect(out.fire).toBe(true)
  expect(out.next.fires).toBe(1)
  expect(watchGate(matchSpec, FRESH_WATCH_GATE, 'all good').fire).toBe(false)
})

test('watchGate: an invalid regex never throws and simply does not fire', () => {
  const spec: WatchSpec = { ...matchSpec, fireOn: { kind: 'match', pattern: '(' } }
  expect(() => watchGate(spec, FRESH_WATCH_GATE, 'anything')).not.toThrow()
  expect(watchGate(spec, FRESH_WATCH_GATE, 'anything').fire).toBe(false)
})

test('watchGate: exit fires only on the exit event', () => {
  const spec: WatchSpec = { ...matchSpec, fireOn: { kind: 'exit' } }
  expect(watchGate(spec, FRESH_WATCH_GATE, 'line').fire).toBe(false)
  expect(watchGate(spec, FRESH_WATCH_GATE, '0', true).fire).toBe(true)
})

// ─── parseWatchCommand ───────────────────────────────────────────────────────

test('parseWatchCommand: arms an on-change watch', () => {
  const out = parseWatchCommand('!watch build on-change npm run build')
  expect(out).toMatchObject({ action: 'arm', spec: { name: 'build', command: 'npm run build', fireOn: { kind: 'change' } } })
})

test('parseWatchCommand: on-exit implies oneShot', () => {
  const out = parseWatchCommand('!watch job on-exit ./run.sh')
  expect(out).toMatchObject({ action: 'arm', spec: { fireOn: { kind: 'exit' }, oneShot: true } })
})

test('parseWatchCommand: match: mode carries the regex', () => {
  const out = parseWatchCommand('!watch errs match:ERROR tail -f log')
  expect(out).toMatchObject({ action: 'arm', spec: { fireOn: { kind: 'match', pattern: 'ERROR' } } })
})

test('parseWatchCommand: every= desugars into a poll loop', () => {
  const out = parseWatchCommand('!watch ping each-line every=10s curl -s host')
  expect(out?.action).toBe('arm')
  if (out?.action === 'arm') {
    expect(out.spec.command).toContain('sleep 10')
    expect(out.spec.command).toContain('while :; do')
    expect(out.spec.command).toContain('curl -s host')
  }
})

test('parseWatchCommand: ttl=/max=/once flags parse', () => {
  const out = parseWatchCommand('!watch w each-line ttl=1h max=3 once echo hi')
  expect(out).toMatchObject({ action: 'arm', spec: { ttlMs: 3_600_000, maxFires: 3, oneShot: true } })
})

test('parseWatchCommand: !unwatch and list', () => {
  expect(parseWatchCommand('!unwatch build')).toEqual({ action: 'disarm', name: 'build' })
  expect(parseWatchCommand('!watch list')).toEqual({ action: 'list' })
})

test('parseWatchCommand: malformed / non-watch input returns null', () => {
  expect(parseWatchCommand('hello there')).toBeNull()
  expect(parseWatchCommand('!watch onlyname')).toBeNull()
  expect(parseWatchCommand('!watch n bogus-mode cmd')).toBeNull()
  expect(parseWatchCommand('!watch n each-line')).toBeNull() // no command
})

// ─── pickFreshContext ────────────────────────────────────────────────────────

const NOTES = [
  { hash: 'h1', body: 'first brief' },
  { hash: 'h2', body: 'second brief' },
]

test('pickFreshContext: returns undelivered notes joined, with their hashes', () => {
  const out = pickFreshContext(NOTES, new Set())
  expect(out.prefix).toBe('first brief\n\nsecond brief')
  expect(out.freshHashes).toEqual(['h1', 'h2'])
})

test('pickFreshContext: returns nothing when all delivered', () => {
  const out = pickFreshContext(NOTES, new Set(['h1', 'h2']))
  expect(out.prefix).toBeUndefined()
  expect(out.freshHashes).toEqual([])
})

test('pickFreshContext: returns only the not-yet-delivered note', () => {
  const out = pickFreshContext(NOTES, new Set(['h1']))
  expect(out.prefix).toBe('second brief')
  expect(out.freshHashes).toEqual(['h2'])
})

// ─── threadNameFromPrompt ────────────────────────────────────────────────────

test('threadNameFromPrompt: strips @mentions and collapses whitespace', () => {
  expect(threadNameFromPrompt('<@!123>  fix   the parser <@456>')).toBe('fix the parser')
})

test('threadNameFromPrompt: caps at 80 chars with an ellipsis', () => {
  const long = 'x'.repeat(100)
  const out = threadNameFromPrompt(long)
  expect(out.endsWith('…')).toBe(true)
  expect(out.length).toBe(81) // 80 chars + ellipsis
})

test('threadNameFromPrompt: empty after stripping falls back to "task"', () => {
  expect(threadNameFromPrompt('<@!123>')).toBe('task')
})

// ─── matchesMentionPattern ───────────────────────────────────────────────────

test('matchesMentionPattern: matches case-insensitively and skips malformed patterns', () => {
  expect(matchesMentionPattern('hey BOT please', ['\\bbot\\b'])).toBe(true)
  expect(matchesMentionPattern('nothing here', ['\\bbot\\b'])).toBe(false)
  expect(() => matchesMentionPattern('text', ['('])).not.toThrow()
  expect(matchesMentionPattern('text', ['(', '\\btext\\b'])).toBe(true)
})

// ─── guildSenderAllowed / senderKind ─────────────────────────────────────────

const ROOM: RoomConfig = {
  requireMention: true,
  participants: { PEER1: { blurb: 'a peer' } },
  humans: ['HUMAN1'],
}

test('guildSenderAllowed: owner allowed, self denied, peer/human allowed, stranger denied', () => {
  expect(guildSenderAllowed(ROOM, 'OWNER', 'SELF', 'OWNER')).toBe(true)
  expect(guildSenderAllowed(ROOM, 'SELF', 'SELF', 'OWNER')).toBe(false) // loop guard
  expect(guildSenderAllowed(ROOM, 'PEER1', 'SELF', 'OWNER')).toBe(true)
  expect(guildSenderAllowed(ROOM, 'HUMAN1', 'SELF', 'OWNER')).toBe(true)
  expect(guildSenderAllowed(ROOM, 'STRANGER', 'SELF', 'OWNER')).toBe(false)
})

test('senderKind: classifies owner/human/agent/unknown', () => {
  expect(senderKind(ROOM, 'OWNER', 'OWNER')).toBe('owner')
  expect(senderKind(ROOM, 'HUMAN1', 'OWNER')).toBe('human')
  expect(senderKind(ROOM, 'PEER1', 'OWNER')).toBe('agent')
  expect(senderKind(ROOM, 'NOBODY', 'OWNER')).toBe('unknown')
})

// ─── session command matchers ────────────────────────────────────────────────

test('isShareSessionCommand: recognizes share/import phrasing, not ordinary chat', () => {
  expect(isShareSessionCommand('/share-session')).toBe(true)
  expect(isShareSessionCommand('can you import the session from earlier')).toBe(true)
  expect(isShareSessionCommand('what a great session that was')).toBe(false)
})

test('isResumeSessionCommand: recognizes resume phrasing disjoint from share', () => {
  expect(isResumeSessionCommand('/resume-session')).toBe(true)
  expect(isResumeSessionCommand('please continue the session')).toBe(true)
  expect(isResumeSessionCommand('share the session')).toBe(false)
})

// ─── per-channel config overlay ──────────────────────────────────────────────

const rec = (delta: ConfigDeltaRecord['delta'], createdAt: string, hash: string): ConfigDeltaRecord => ({
  delta,
  createdAt,
  hash,
})

test('projectChannelConfig: empty → empty config', () => {
  expect(projectChannelConfig([])).toEqual({})
})

test('projectChannelConfig: later (by createdAt) write wins, regardless of array order', () => {
  const older = rec({ role: 'reviewer' }, '2026-06-20T10:00:00.000Z', 'aaaa')
  const newer = rec({ role: 'pair programmer' }, '2026-06-20T11:00:00.000Z', 'bbbb')
  // Same input in two orders must converge — the fold replay is order-independent.
  expect(projectChannelConfig([older, newer]).role).toBe('pair programmer')
  expect(projectChannelConfig([newer, older]).role).toBe('pair programmer')
})

test('projectChannelConfig: equal createdAt breaks the tie by hash deterministically', () => {
  const a = rec({ role: 'A' }, '2026-06-20T10:00:00.000Z', 'aaaa')
  const b = rec({ role: 'B' }, '2026-06-20T10:00:00.000Z', 'bbbb')
  // Higher hash sorts last → wins, in either array order.
  expect(projectChannelConfig([a, b]).role).toBe('B')
  expect(projectChannelConfig([b, a]).role).toBe('B')
})

test('projectChannelConfig: _clear removes a key back to the base', () => {
  const set = rec({ role: 'reviewer' }, '2026-06-20T10:00:00.000Z', 'aaaa')
  const clear = rec({ _clear: ['role'] }, '2026-06-20T11:00:00.000Z', 'bbbb')
  expect(projectChannelConfig([set, clear])).toEqual({})
})

test('projectChannelConfig: drops a non-string/blank role (defensive against junk in the log)', () => {
  const blank = rec({ role: '   ' }, '2026-06-20T10:00:00.000Z', 'aaaa')
  expect(projectChannelConfig([blank])).toEqual({})
})

test('parseConfigCommand: returns null for non-config text', () => {
  expect(parseConfigCommand('hello there')).toBeNull()
  expect(parseConfigCommand('!configure something')).toBeNull()
})

test('parseConfigCommand: bare / help → help', () => {
  expect(parseConfigCommand('!config')).toEqual({ action: 'help' })
  expect(parseConfigCommand('!config help')).toEqual({ action: 'help' })
})

test('parseConfigCommand: set role keeps the full text (spaces preserved)', () => {
  expect(parseConfigCommand('!config role you are a terse reviewer; no edits')).toEqual({
    action: 'set',
    delta: { role: 'you are a terse reviewer; no edits' },
  })
})

test('parseConfigCommand: role with no text is an error, not an empty set', () => {
  const r = parseConfigCommand('!config role')
  expect(r?.action).toBe('error')
})

test('parseConfigCommand: an over-long role is rejected', () => {
  const r = parseConfigCommand(`!config role ${'x'.repeat(ROLE_MAX_LEN + 1)}`)
  expect(r?.action).toBe('error')
})

test('parseConfigCommand: get with and without a key', () => {
  expect(parseConfigCommand('!config get')).toEqual({ action: 'get', key: undefined })
  expect(parseConfigCommand('!config get role')).toEqual({ action: 'get', key: 'role' })
})

test('parseConfigCommand: reset requires a settable key', () => {
  expect(parseConfigCommand('!config reset role')).toEqual({ action: 'reset', keys: ['role'] })
  expect(parseConfigCommand('!config reset')?.action).toBe('error')
  expect(parseConfigCommand('!config reset humans')?.action).toBe('error')
})

test('parseConfigCommand: a terminal-only key is refused by name (the trust surface)', () => {
  for (const key of ['humans', 'token', 'sandbox', 'deny', 'preset', 'runtime']) {
    const r = parseConfigCommand(`!config ${key} whatever`)
    expect(r?.action).toBe('error')
    if (r?.action === 'error') expect(r.message.toLowerCase()).toContain('terminal')
  }
})

test('parseConfigCommand: only `role` is settable from chat in Phase 1', () => {
  expect(CHAT_SETTABLE_KEYS).toEqual(['role'])
})

test('wrapChannelRole: frames the brief as persona, not authority, and includes the text', () => {
  const wrapped = wrapChannelRole('you are a reviewer')
  expect(wrapped).toContain('<channel-role>')
  expect(wrapped).toContain('</channel-role>')
  expect(wrapped).toContain('you are a reviewer')
  expect(wrapped.toLowerCase()).toContain('no authority')
})
