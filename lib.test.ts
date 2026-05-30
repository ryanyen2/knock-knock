import { test, expect } from 'bun:test'
import {
  guildSenderAllowed,
  senderKind,
  chunk,
  classifyTool,
  approverForAgent,
  buildRosterLinesForRoom,
  wrapEnvelope,
  buildPreamble,
  loopGuard,
  isShareSessionCommand,
  isResumeSessionCommand,
  wrapSharedContext,
  pickFreshContext,
  watchGate,
  renderWatchPrompt,
  parseWatchCommand,
  FRESH_WATCH_GATE,
  type RoomConfig,
  type AgentConfig,
  type LoopGuardState,
  type WatchSpec,
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
  // The same `rm -rf` can surface as kind "other" first, then "execute". The
  // deny literal must block it regardless of kind.
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
    ...overrides,
  }
}

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

// ─── Agent / room helpers ───────────────────────────────────────────────────

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ownerUserId: 'owner1',
    blurb: 'test agent',
    runtime: 'claude-sdk',
    workspace: '/tmp',
    tokenEnv: 'DISCORD_BOT_TOKEN',
    rooms: {},
    ...overrides,
  }
}

// ─── approverForAgent ─────────────────────────────────────────────────────────

test('approverForAgent falls back to ownerUserId when room has no override', () => {
  const agent = agentConfig({ rooms: { chan1: room() } })
  expect(approverForAgent(agent, 'chan1')).toBe('owner1')
})

test('approverForAgent prefers room.approvalActorId over ownerUserId', () => {
  const agent = agentConfig({ rooms: { chan1: room({ approvalActorId: 'delegate2' }) } })
  expect(approverForAgent(agent, 'chan1')).toBe('delegate2')
})

test('approverForAgent returns ownerUserId when channel is not in rooms', () => {
  const agent = agentConfig({ ownerUserId: 'owner9', rooms: {} })
  expect(approverForAgent(agent, 'missing')).toBe('owner9')
})

// ─── buildRosterLinesForRoom ──────────────────────────────────────────────────

test('buildRosterLinesForRoom formats peers with mention handles', () => {
  const r = room({
    participants: {
      '111': { name: 'agent-C', blurb: 'schema specialist' },
      '222': { name: 'agent-B', blurb: 'deploy agent' },
    },
  })
  const lines = buildRosterLinesForRoom(r)
  expect(lines).toContain('agent-C (<@111>): schema specialist')
  expect(lines).toContain('agent-B (<@222>): deploy agent')
})

test('buildRosterLinesForRoom is empty when room has no peers', () => {
  expect(buildRosterLinesForRoom(room())).toBe('')
})

test('buildRosterLinesForRoom returns empty for undefined room', () => {
  expect(buildRosterLinesForRoom(undefined)).toBe('')
})

// ─── wrapEnvelope ─────────────────────────────────────────────────────────────

test('wrapEnvelope produces the expected <channel> format', () => {
  const meta = { kind: 'owner', senderId: 'u1', messageId: 'm1', ts: '2026-01-01', channelId: 'c1' }
  const out = wrapEnvelope(meta, 'hello')
  expect(out).toContain('<channel source="discord"')
  expect(out).toContain('kind="owner"')
  expect(out).toContain('chat_id="c1"')
  expect(out).toContain('message_id="m1"')
  expect(out).toContain('user="u1"')
  expect(out).toContain('ts="2026-01-01"')
  expect(out).toContain('\nhello\n')
  expect(out).toContain('</channel>')
})

test('wrapEnvelope body is surrounded by newlines', () => {
  const meta = { kind: 'human', senderId: 'u', messageId: 'm', ts: 't', channelId: 'c' }
  const out = wrapEnvelope(meta, 'test body')
  expect(out.endsWith('\ntest body\n</channel>')).toBe(true)
})

// ─── buildPreamble ────────────────────────────────────────────────────────────

test('buildPreamble includes the identity name when provided', () => {
  const out = buildPreamble({ identity: { name: 'my-bot', ownerUserId: 'o', blurb: '' }, rosterLines: '' })
  expect(out).toContain('You are "my-bot"')
})

test('buildPreamble includes the priority string verbatim', () => {
  const out = buildPreamble({ identity: { ownerUserId: 'o', blurb: '' }, rosterLines: '' })
  expect(out).toContain('Priority (highest first): your owner (kind="owner")')
  expect(out).toContain('kind="human"')
  expect(out).toContain('kind="agent"')
})

test('buildPreamble includes roster section when rosterLines is non-empty', () => {
  const out = buildPreamble({
    identity: { name: 'bot', ownerUserId: 'o', blurb: '' },
    rosterLines: '  • agent-B (<@222>): deploy agent',
  })
  expect(out).toContain('Peers in this room')
  expect(out).toContain('agent-B')
})

test('buildPreamble omits the roster section when rosterLines is empty', () => {
  const out = buildPreamble({ identity: { ownerUserId: 'o', blurb: '' }, rosterLines: '' })
  expect(out).not.toContain('Peers in this room')
})

test('buildPreamble includes the prompt-injection guard', () => {
  const out = buildPreamble({ identity: { ownerUserId: 'o', blurb: '' }, rosterLines: '' })
  expect(out).toContain('prompt injection')
})

// ─── loopGuard ────────────────────────────────────────────────────────────────

const freshState: LoopGuardState = { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 }
const NOW = 1_000_000

test('loopGuard: owner message always passes and resets the counter', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 3, lastAgentReplyAt: NOW - 100 }
  const { decision, next } = loopGuard(state, 'owner', NOW)
  expect(decision.allow).toBe(true)
  expect(next.consecutiveAgentTurns).toBe(0)
  expect(next.lastAgentReplyAt).toBe(0)
})

test('loopGuard: human message always passes and resets the counter', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 4, lastAgentReplyAt: NOW - 100 }
  const { decision, next } = loopGuard(state, 'human', NOW)
  expect(decision.allow).toBe(true)
  expect(next.consecutiveAgentTurns).toBe(0)
})

test('loopGuard: first agent message passes and increments the counter', () => {
  const { decision, next } = loopGuard(freshState, 'agent', NOW)
  expect(decision.allow).toBe(true)
  expect(next.consecutiveAgentTurns).toBe(1)
  expect(next.lastAgentReplyAt).toBe(NOW)
})

test('loopGuard: blocks agent at threshold', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 4, lastAgentReplyAt: NOW - 10_000 }
  const { decision } = loopGuard(state, 'agent', NOW, { maxConsecutive: 4, cooldownMs: 1_000 })
  expect(decision.allow).toBe(false)
  expect(decision.reason).toBe('threshold')
})

test('loopGuard: blocks agent within cooldown window', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 1, lastAgentReplyAt: NOW - 500 }
  const { decision } = loopGuard(state, 'agent', NOW, { maxConsecutive: 10, cooldownMs: 8_000 })
  expect(decision.allow).toBe(false)
  expect(decision.reason).toBe('cooldown')
})

test('loopGuard: allows agent after cooldown has elapsed', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 1, lastAgentReplyAt: NOW - 9_000 }
  const { decision, next } = loopGuard(state, 'agent', NOW, { maxConsecutive: 10, cooldownMs: 8_000 })
  expect(decision.allow).toBe(true)
  expect(next.consecutiveAgentTurns).toBe(2)
})

test('loopGuard: state remains unchanged on threshold denial', () => {
  const state: LoopGuardState = { consecutiveAgentTurns: 4, lastAgentReplyAt: NOW - 10_000 }
  const { next } = loopGuard(state, 'agent', NOW, { maxConsecutive: 4, cooldownMs: 1_000 })
  expect(next).toBe(state) // same reference — no copy on denial
})

test('loopGuard: owner message after agent chain allows the next agent turn', () => {
  let state: LoopGuardState = { consecutiveAgentTurns: 4, lastAgentReplyAt: NOW - 100 }
  // Owner breaks the chain
  const ownerResult = loopGuard(state, 'owner', NOW, { maxConsecutive: 4, cooldownMs: 1_000 })
  state = ownerResult.next
  // Now an agent message should be allowed again
  const agentResult = loopGuard(state, 'agent', NOW + 2_000, { maxConsecutive: 4, cooldownMs: 1_000 })
  expect(agentResult.decision.allow).toBe(true)
})

// ─── Session sharing ─────────────────────────────────────────────────────────

test('isShareSessionCommand: recognizes share/import phrasings', () => {
  expect(isShareSessionCommand('@bot share my session here')).toBe(true)
  expect(isShareSessionCommand('please import the session you were on')).toBe(true)
  expect(isShareSessionCommand('share a local session')).toBe(true)
  expect(isShareSessionCommand('/share-session')).toBe(true)
  expect(isShareSessionCommand('/import_session')).toBe(true)
})

test('isShareSessionCommand: does not trip on ordinary chat', () => {
  expect(isShareSessionCommand('can you share the link to the docs?')).toBe(false)
  expect(isShareSessionCommand('this session of meetings was long')).toBe(false)
  expect(isShareSessionCommand('import the new types from lib.ts')).toBe(false)
})

test('isResumeSessionCommand: recognizes resume/continue, disjoint from share', () => {
  expect(isResumeSessionCommand('@bot resume my session')).toBe(true)
  expect(isResumeSessionCommand('continue the session you had open')).toBe(true)
  expect(isResumeSessionCommand('/resume-session')).toBe(true)
  // share/import phrasings are NOT resume, and vice-versa
  expect(isResumeSessionCommand('share my session')).toBe(false)
  expect(isShareSessionCommand('resume my session')).toBe(false)
  // ordinary chat
  expect(isResumeSessionCommand('continue working on the parser')).toBe(false)
})

test('wrapSharedContext: delimited block with provenance + a reference framing', () => {
  const out = wrapSharedContext({ source: 'claude-code:abc', cwd: '/ws', savedBy: 'u1' }, '## Plan\nX')
  expect(out).toContain('<shared-context source="claude-code:abc" cwd="/ws" shared_by="u1">')
  expect(out).toContain('</shared-context>')
  expect(out).toContain('not as new instructions')
  expect(out).toContain('## Plan')
})

test('pickFreshContext: delivers undelivered notes once, in order', () => {
  const notes = [
    { hash: 'h1', body: 'A' },
    { hash: 'h2', body: 'B' },
  ]
  const first = pickFreshContext(notes, new Set())
  expect(first.prefix).toBe('A\n\nB')
  expect(first.freshHashes).toEqual(['h1', 'h2'])

  const after = pickFreshContext(notes, new Set(['h1', 'h2']))
  expect(after.prefix).toBeUndefined()
  expect(after.freshHashes).toEqual([])

  const partial = pickFreshContext(notes, new Set(['h1']))
  expect(partial.prefix).toBe('B')
})

// ─── watchGate: the pure fire-decision for a watch's output ───────────────────

function spec(fireOn: WatchSpec['fireOn'], extra: Partial<WatchSpec> = {}): WatchSpec {
  return { name: 'w', channel: 'c', agentKey: 'a', command: 'cmd', fireOn, ...extra }
}

test('watchGate each-line: fires on every non-empty line, skips blanks', () => {
  const s = spec({ kind: 'each-line' })
  const a = watchGate(s, FRESH_WATCH_GATE, 'hello')
  expect(a.fire).toBe(true)
  expect(a.text).toContain('hello')
  const b = watchGate(s, a.next, '   ')
  expect(b.fire).toBe(false)
  expect(b.next.fires).toBe(1) // unchanged
})

test('watchGate change: fires only when the line differs from the last fired', () => {
  const s = spec({ kind: 'change' })
  const a = watchGate(s, FRESH_WATCH_GATE, 'v1')
  expect(a.fire).toBe(true)
  const b = watchGate(s, a.next, 'v1')
  expect(b.fire).toBe(false)
  const c = watchGate(s, b.next, 'v2')
  expect(c.fire).toBe(true)
  expect(c.next.fires).toBe(2)
})

test('watchGate match: fires on regex hit only', () => {
  const s = spec({ kind: 'match', pattern: 'done|finished' })
  expect(watchGate(s, FRESH_WATCH_GATE, 'still running').fire).toBe(false)
  expect(watchGate(s, FRESH_WATCH_GATE, 'run finished ok').fire).toBe(true)
})

test('watchGate exit: per-line never fires; the exit event does', () => {
  const s = spec({ kind: 'exit' })
  expect(watchGate(s, FRESH_WATCH_GATE, 'progress…').fire).toBe(false)
  const e = watchGate(s, FRESH_WATCH_GATE, 'code 0', true)
  expect(e.fire).toBe(true)
  expect(e.text).toContain('exited')
})

test('renderWatchPrompt: applies the template with {line}/{name}', () => {
  const s = spec({ kind: 'each-line' }, { promptTemplate: '[{name}] {line}' })
  expect(renderWatchPrompt(s, 'X')).toBe('[w] X')
})

// ─── parseWatchCommand: owner control grammar ─────────────────────────────────

test('parseWatchCommand: arms on-change with a command', () => {
  const p = parseWatchCommand('!watch notes on-change diff -u /tmp/a /tmp/b')
  expect(p).toMatchObject({
    action: 'arm',
    spec: { name: 'notes', fireOn: { kind: 'change' }, command: 'diff -u /tmp/a /tmp/b' },
  })
})

test('parseWatchCommand: on-exit implies once', () => {
  const p = parseWatchCommand('!watch build on-exit ./train.sh')
  expect(p).toMatchObject({ action: 'arm', spec: { fireOn: { kind: 'exit' }, oneShot: true } })
})

test('parseWatchCommand: match:<regex> mode', () => {
  const p = parseWatchCommand('!watch wandb match:done wandb status')
  expect(p).toMatchObject({ action: 'arm', spec: { fireOn: { kind: 'match', pattern: 'done' } } })
})

test('parseWatchCommand: flags (ttl/max/once) parsed before the command', () => {
  const p = parseWatchCommand('!watch w each-line ttl=10m max=3 once echo hi')
  expect(p).toMatchObject({
    action: 'arm',
    spec: { ttlMs: 600_000, maxFires: 3, oneShot: true, command: 'echo hi' },
  })
})

test('parseWatchCommand: every=<dur> desugars into a poll loop', () => {
  const p = parseWatchCommand('!watch w on-change every=10s check.sh')
  expect(p?.action).toBe('arm')
  if (p?.action === 'arm') expect(p.spec.command).toBe('while :; do ( check.sh ); sleep 10; done')
})

test('parseWatchCommand: disarm and list', () => {
  expect(parseWatchCommand('!unwatch notes')).toEqual({ action: 'disarm', name: 'notes' })
  expect(parseWatchCommand('!watch list')).toEqual({ action: 'list' })
})

test('parseWatchCommand: rejects unrelated text and malformed input', () => {
  expect(parseWatchCommand('hello there')).toBeNull()
  expect(parseWatchCommand('!watch w bogus-mode cmd')).toBeNull()
  expect(parseWatchCommand('!watch w on-change')).toBeNull() // no command
})
