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
  resolveChannelForScope,
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
  pickAnthropicEnv,
  projectChannelConfig,
  parseConfigCommand,
  wrapChannelRole,
  wrapChannelGoal,
  resolveTwoLayerConfig,
  toThinkingConfig,
  THINKING_HIGH_BUDGET,
  applyModeToProfile,
  parseContextCommand,
  CONTEXT_NOTE_MAX_LEN,
  CHAT_SETTABLE_KEYS,
  ROLE_MAX_LEN,
  channelKey,
  projectToRuntime,
  type ConfigDeltaRecord,
  type WatchSpec,
  type RoomConfig,
  type AuthoringAccess,
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

// ─── resolveChannelForScope ─────────────────────────────────────────────────────

const ROOMS: Record<string, RoomConfig> = {
  ROOM1: { requireMention: true, participants: {}, humans: [] },
}

test('resolveChannelForScope: a served room id resolves to itself', () => {
  expect(resolveChannelForScope('ROOM1', ROOMS, new Map(), () => undefined)).toBe('ROOM1')
})

test('resolveChannelForScope: a thread resolves to its parent via the memo', () => {
  const memo = new Map([['THREAD1', 'ROOM1']])
  expect(resolveChannelForScope('THREAD1', ROOMS, memo, () => undefined)).toBe('ROOM1')
})

test('resolveChannelForScope: a thread resolves to its parent via the parentOf probe', () => {
  expect(resolveChannelForScope('THREAD1', ROOMS, new Map(), id => (id === 'THREAD1' ? 'ROOM1' : undefined))).toBe('ROOM1')
})

test('resolveChannelForScope: an unresolved scope returns undefined (fail-restrictive)', () => {
  expect(resolveChannelForScope('UNKNOWN', ROOMS, new Map(), () => undefined)).toBeUndefined()
})

// ─── projectToRuntime (channel-centric authoring → agent-keyed runtime) ───────

const AUTHORING: AuthoringAccess = {
  me: { discord: 'OWNER_D', slack: 'OWNER_S' },
  bots: {
    reviewer: { platform: 'discord', tokenEnv: 'REVIEWER_TOKEN', runtime: 'claude-sdk', blurb: 'reviews code' },
    builder: { platform: 'slack', tokenEnv: 'BUILDER_TOKEN', appTokenEnv: 'BUILDER_APP', runtime: 'acp' },
  },
  channels: {
    'discord:C_INFRA': {
      platform: 'discord',
      channelId: 'C_INFRA',
      members: [{ bot: 'reviewer', workspace: '/repos/infra', profile: { allow: ['Read(**)'], ask: [], deny: ['Bash(*)'] } }],
      collaborators: [{ kind: 'human', id: 'alice' }, { kind: 'peer', id: 'carol' }],
      requireMention: true,
    },
    'discord:C_WEB': {
      platform: 'discord',
      channelId: 'C_WEB',
      members: [{ bot: 'reviewer', workspace: '/repos/web' }],
      collaborators: [{ kind: 'human', id: 'alice' }],
    },
    'slack:C_Z': {
      platform: 'slack',
      channelId: 'C_Z',
      members: [{ bot: 'builder', workspace: '/repos/z' }],
      collaborators: [{ kind: 'human', id: 'bob' }],
    },
  },
  roster: {
    people: {
      alice: { platform: 'discord', userId: 'U_ALICE' },
      bob: { platform: 'slack', userId: 'U_BOB' },
    },
    peers: { carol: { platform: 'discord', userId: 'U_CAROL', blurb: 'docs writer', label: 'carol-bot' } },
  },
}

test('projectToRuntime: each bot becomes one runtime agent with platform + token + owner', () => {
  const rt = projectToRuntime(AUTHORING)
  expect(Object.keys(rt.agents).sort()).toEqual(['builder', 'reviewer'])
  expect(rt.agents.reviewer!.platform).toBe('discord')
  expect(rt.agents.reviewer!.ownerUserId).toBe('OWNER_D') // from me[platform], not re-typed
  expect(rt.agents.builder!.ownerUserId).toBe('OWNER_S')
  expect(rt.agents.builder!.appTokenEnv).toBe('BUILDER_APP')
})

test('projectToRuntime: a bot is a member only of its own-platform channels (per-channel workspace)', () => {
  const rt = projectToRuntime(AUTHORING)
  // reviewer is in both discord channels, not the slack one.
  expect(Object.keys(rt.agents.reviewer!.rooms).sort()).toEqual(['C_INFRA', 'C_WEB'])
  expect(rt.agents.reviewer!.rooms.C_INFRA!.workspace).toBe('/repos/infra')
  expect(rt.agents.reviewer!.rooms.C_WEB!.workspace).toBe('/repos/web')
  // builder only sees its slack channel.
  expect(Object.keys(rt.agents.builder!.rooms)).toEqual(['C_Z'])
})

test('projectToRuntime: collaborators resolve from the roster into participants/humans', () => {
  const rt = projectToRuntime(AUTHORING)
  const infra = rt.agents.reviewer!.rooms.C_INFRA!
  expect(infra.humans).toEqual(['U_ALICE']) // person id → platform userId
  expect(infra.participants.U_CAROL).toEqual({ blurb: 'docs writer', name: 'carol-bot' })
  expect(infra.requireMention).toBe(true)
})

test('projectToRuntime: inline membership profile is carried onto the room', () => {
  const rt = projectToRuntime(AUTHORING)
  expect(rt.agents.reviewer!.rooms.C_INFRA!.profile).toEqual({ allow: ['Read(**)'], ask: [], deny: ['Bash(*)'] })
  expect(rt.agents.reviewer!.rooms.C_WEB!.profile).toBeUndefined() // no inline profile set
})

test('channelKey: namespaces a channel id by platform', () => {
  expect(channelKey('discord', 'C1')).toBe('discord:C1')
  expect(channelKey('slack', 'C1')).not.toBe(channelKey('discord', 'C1'))
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

// ─── pickAnthropicEnv ──────────────────────────────────────────────────────────

test('pickAnthropicEnv: forwards recognized gateway/auth keys, drops the rest', () => {
  // A LiteLLM-style settings.json env block: gateway creds plus unrelated config.
  const picked = pickAnthropicEnv({
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'sk-abc',
    ANTHROPIC_API_KEY: 'key-123',
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: relay',
    // Not auth — must not leak into the subprocess env.
    SOME_OTHER_VAR: 'nope',
    CLAUDE_CODE_USE_BEDROCK: '1',
  })
  expect(picked).toEqual({
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'sk-abc',
    ANTHROPIC_API_KEY: 'key-123',
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: relay',
  })
})

test('pickAnthropicEnv: ignores missing/empty/non-string values', () => {
  expect(pickAnthropicEnv(undefined)).toEqual({})
  expect(pickAnthropicEnv({})).toEqual({})
  expect(
    pickAnthropicEnv({ ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 42 as unknown as string }),
  ).toEqual({})
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

test('parseConfigCommand: role plus the safety/limit knobs are settable from chat', () => {
  expect(CHAT_SETTABLE_KEYS).toContain('role')
  expect(CHAT_SETTABLE_KEYS).toContain('loop-max')
  expect(CHAT_SETTABLE_KEYS).toContain('rate')
  expect(CHAT_SETTABLE_KEYS).toContain('approval-timeout')
})

test('parseConfigCommand: an int knob parses to its canonical field', () => {
  expect(parseConfigCommand('!config rate 30')).toEqual({ action: 'set', delta: { rateCapPerMin: 30 } })
  expect(parseConfigCommand('!config loop-max 8')).toEqual({ action: 'set', delta: { loopMaxConsecutive: 8 } })
})

test('parseConfigCommand: a numeric knob is CLAMPED to its safe range (can\'t disable a guard)', () => {
  // rate min is 1 — 0 would disable the spam guard.
  expect(parseConfigCommand('!config rate 0')).toEqual({ action: 'set', delta: { rateCapPerMin: 1 } })
  // rate max is 120.
  expect(parseConfigCommand('!config rate 9999')).toEqual({ action: 'set', delta: { rateCapPerMin: 120 } })
  // loop-max max is 50.
  expect(parseConfigCommand('!config loop-max 1000')).toEqual({ action: 'set', delta: { loopMaxConsecutive: 50 } })
})

test('parseConfigCommand: a duration knob accepts 8s / 5m and stores ms', () => {
  expect(parseConfigCommand('!config loop-cooldown 8s')).toEqual({ action: 'set', delta: { loopCooldownMs: 8000 } })
  expect(parseConfigCommand('!config approval-timeout 5m')).toEqual({ action: 'set', delta: { approvalTimeoutMs: 300000 } })
  // a bare integer is treated as ms.
  expect(parseConfigCommand('!config loop-cooldown 4000')).toEqual({ action: 'set', delta: { loopCooldownMs: 4000 } })
})

test('parseConfigCommand: a non-numeric value for a numeric knob is an error', () => {
  expect(parseConfigCommand('!config rate abc')?.action).toBe('error')
  expect(parseConfigCommand('!config loop-max')?.action).toBe('error')
})

test('parseConfigCommand: reset maps the chat key to its canonical field', () => {
  expect(parseConfigCommand('!config reset rate')).toEqual({ action: 'reset', keys: ['rateCapPerMin'] })
})

test('projectChannelConfig: numeric knobs project and are clamped against junk in the log', () => {
  const good = rec({ rateCapPerMin: 30 }, '2026-06-20T10:00:00.000Z', 'aaaa')
  expect(projectChannelConfig([good]).rateCapPerMin).toBe(30)
  // an out-of-range value somehow in the log is clamped at projection (defense in depth).
  const junk = rec({ loopMaxConsecutive: 9999 } as any, '2026-06-20T10:00:00.000Z', 'bbbb')
  expect(projectChannelConfig([junk]).loopMaxConsecutive).toBe(50)
})

// ─── Phase 3: routing & surface/UX knobs ─────────────────────────────────────

test('parseConfigCommand: require-mention is a boolean knob', () => {
  expect(parseConfigCommand('!config require-mention off')).toEqual({ action: 'set', delta: { requireMention: false } })
  expect(parseConfigCommand('!config require-mention on')).toEqual({ action: 'set', delta: { requireMention: true } })
  expect(parseConfigCommand('!config require-mention yes')).toEqual({ action: 'set', delta: { requireMention: true } })
  expect(parseConfigCommand('!config require-mention maybe')?.action).toBe('error')
})

test('parseConfigCommand: workbench is an enum knob', () => {
  expect(parseConfigCommand('!config workbench quiet')).toEqual({ action: 'set', delta: { workbenchVerbosity: 'quiet' } })
  expect(parseConfigCommand('!config workbench loud')?.action).toBe('error')
})

test('parseConfigCommand: ack is a short text knob', () => {
  expect(parseConfigCommand('!config ack 🔄')).toEqual({ action: 'set', delta: { ackReaction: '🔄' } })
  expect(parseConfigCommand('!config ack')?.action).toBe('error')
})

test('parseConfigCommand: mention is a comma-separated regex list, validated', () => {
  expect(parseConfigCommand('!config mention alice, hey alice')).toEqual({
    action: 'set',
    delta: { mentionPatterns: ['alice', 'hey alice'] },
  })
  // an invalid regex is rejected, not stored.
  expect(parseConfigCommand('!config mention [unclosed')?.action).toBe('error')
})

test('projectChannelConfig: bool/enum/list project, with junk filtered out', () => {
  expect(projectChannelConfig([rec({ requireMention: false }, '2026-06-20T10:00:00.000Z', 'a')]).requireMention).toBe(false)
  expect(projectChannelConfig([rec({ workbenchVerbosity: 'verbose' } as any, '2026-06-20T10:00:00.000Z', 'b')]).workbenchVerbosity).toBe('verbose')
  // an invalid enum value in the log is dropped.
  expect(projectChannelConfig([rec({ workbenchVerbosity: 'loud' } as any, '2026-06-20T10:00:00.000Z', 'c')]).workbenchVerbosity).toBeUndefined()
  // a list keeps only valid regexes.
  const list = projectChannelConfig([rec({ mentionPatterns: ['ok', '[bad'] } as any, '2026-06-20T10:00:00.000Z', 'd')])
  expect(list.mentionPatterns).toEqual(['ok'])
})

test('wrapChannelRole: frames the brief as persona, not authority, and includes the text', () => {
  const wrapped = wrapChannelRole('you are a reviewer')
  expect(wrapped).toContain('<channel-role>')
  expect(wrapped).toContain('</channel-role>')
  expect(wrapped).toContain('you are a reviewer')
  expect(wrapped.toLowerCase()).toContain('no authority')
})

// ─── per-thread config: new fields, two-layer resolve, mappers (U1) ────────────

test('wrapChannelGoal: frames the objective, not authority, and includes the text', () => {
  const wrapped = wrapChannelGoal('ship the auth refactor')
  expect(wrapped).toContain('<objective>')
  expect(wrapped).toContain('</objective>')
  expect(wrapped).toContain('ship the auth refactor')
})

test('resolveTwoLayerConfig: scope overrides room; absent scope inherits room', () => {
  const room = { role: 'room persona', model: 'claude-room', loopMaxConsecutive: 4 }
  const scope = { role: 'thread persona', effort: 'max' as const }
  const merged = resolveTwoLayerConfig(room, scope)
  expect(merged.role).toBe('thread persona') // scope wins
  expect(merged.model).toBe('claude-room')   // inherited from room
  expect(merged.effort).toBe('max')          // scope-only
  expect(merged.loopMaxConsecutive).toBe(4)  // inherited
})

test('resolveTwoLayerConfig: identical layers (scope==room) is a no-op', () => {
  const cfg = { role: 'x', thinking: 'high' as const }
  expect(resolveTwoLayerConfig(cfg, cfg)).toEqual(cfg)
})

test('parseConfigCommand: a leading `room` modifier targets the room overlay', () => {
  expect(parseConfigCommand('!config room role X')).toEqual({
    action: 'set', delta: { role: 'X' }, target: 'room',
  })
  // bare set has no target (host decides by scope)
  expect(parseConfigCommand('!config role X')).toEqual({ action: 'set', delta: { role: 'X' } })
  expect(parseConfigCommand('!config get room')).toEqual({ action: 'get', key: undefined, target: 'room' })
  expect(parseConfigCommand('!config reset room role')).toEqual({
    action: 'reset', keys: ['role'], target: 'room',
  })
  // `room` is only a modifier, never a settable key on its own
  expect(parseConfigCommand('!config room')?.action).toBe('error')
})

test('parseConfigCommand: model is a single token; thinking/effort/mode are enums', () => {
  expect(parseConfigCommand('!config model claude-opus-4-8')).toEqual({
    action: 'set', delta: { model: 'claude-opus-4-8' },
  })
  // model rejects whitespace / empty
  expect(parseConfigCommand('!config model claude opus')?.action).toBe('error')
  expect(parseConfigCommand('!config model')?.action).toBe('error')
  // thinking / effort / mode accept their enum values and reject others
  expect(parseConfigCommand('!config thinking high')).toEqual({ action: 'set', delta: { thinking: 'high' } })
  expect(parseConfigCommand('!config thinking turbo')?.action).toBe('error')
  expect(parseConfigCommand('!config effort max')).toEqual({ action: 'set', delta: { effort: 'max' } })
  expect(parseConfigCommand('!config mode bypass')).toEqual({ action: 'set', delta: { permissionPreset: 'bypass' } })
  expect(parseConfigCommand('!config mode yolo')?.action).toBe('error')
  // end-goal clamps like a text field
  expect(parseConfigCommand('!config end-goal ship it')).toEqual({ action: 'set', delta: { endGoal: 'ship it' } })
})

test('parseConfigCommand: raw permission keys stay terminal-only; mode is allowed', () => {
  for (const key of ['preset', 'allow', 'deny', 'tiers']) {
    expect(parseConfigCommand(`!config ${key} whatever`)?.action).toBe('error')
  }
  expect(parseConfigCommand('!config mode strict')?.action).toBe('set')
  expect(CHAT_SETTABLE_KEYS).toContain('mode')
  expect(CHAT_SETTABLE_KEYS).not.toContain('preset')
})

test('toThinkingConfig: off→disabled, auto→adaptive, high→enabled+budget, unknown→undefined', () => {
  expect(toThinkingConfig('off')).toEqual({ type: 'disabled' })
  expect(toThinkingConfig('auto')).toEqual({ type: 'adaptive' })
  expect(toThinkingConfig('high')).toEqual({ type: 'enabled', budgetTokens: THINKING_HIGH_BUDGET })
  expect(toThinkingConfig(undefined)).toBeUndefined()
  expect(toThinkingConfig('bogus')).toBeUndefined()
})

test('applyModeToProfile: loosens allow/ask but deny = union(base, preset floor)', () => {
  const base = { allow: ['Read(**)'], ask: [], deny: ['Bash(curl *)', ...DENY_FLOOR] }
  const bypassed = applyModeToProfile(base, 'bypass')
  // bypass loosens allow (edits/writes/bash auto-allowed)
  expect(bypassed.allow).toContain('Edit(**)')
  // a room-set deny survives bypass, and the floor is always present
  expect(bypassed.deny).toContain('Bash(curl *)')
  expect(bypassed.deny).toContain('Bash(rm -rf *)')
  // strict tightens: edits/writes/bash denied
  const strict = applyModeToProfile(base, 'strict')
  expect(strict.deny).toContain('Edit(**)')
  expect(strict.deny).toContain('Bash(curl *)') // base deny still unioned in
})

test('applyModeToProfile: the deny-union invariant holds for EVERY vetted preset', () => {
  // The security claim is that ANY chat-settable mode unions the room deny + floor;
  // proving it for all four presets (not just bypass/strict) guards the invariant.
  const base = { allow: ['Read(**)'], ask: [], deny: ['Bash(curl *)', ...DENY_FLOOR] }
  for (const preset of ['strict', 'ask-per-edit', 'auto', 'bypass'] as const) {
    const out = applyModeToProfile(base, preset)
    expect(out.deny).toContain('Bash(curl *)')   // room-set deny survives every mode
    expect(out.deny).toContain('Bash(rm -rf *)') // DENY_FLOOR always present
    expect(out.deny).toContain('Bash(sudo *)')
  }
  // ask-per-edit routes edits to ask (not auto-allow); auto auto-allows edits.
  expect(applyModeToProfile(base, 'ask-per-edit').ask).toContain('Edit(**)')
  expect(applyModeToProfile(base, 'auto').allow).toContain('Edit(**)')
})

test('parseContextCommand: list / remove / add / help / error', () => {
  expect(parseContextCommand('!context')).toEqual({ action: 'list' })
  expect(parseContextCommand('!context list')).toEqual({ action: 'list' })
  expect(parseContextCommand('!context remove 2')).toEqual({ action: 'remove', index: 2 })
  expect(parseContextCommand('!context rm 1')).toEqual({ action: 'remove', index: 1 })
  expect(parseContextCommand('!context remove x')?.action).toBe('error')
  expect(parseContextCommand('!context add remember the changelog')).toEqual({
    action: 'add', text: 'remember the changelog',
  })
  expect(parseContextCommand('!context add')?.action).toBe('error')
  expect(parseContextCommand(`!context add ${'x'.repeat(CONTEXT_NOTE_MAX_LEN + 1)}`)?.action).toBe('error')
  expect(parseContextCommand('!context help')).toEqual({ action: 'help' })
  expect(parseContextCommand('hello')).toBeNull()
})
