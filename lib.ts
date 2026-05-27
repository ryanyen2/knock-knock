/**
 * Pure decision logic for knock-knock — no Discord/MCP/network dependencies.
 * Kept separate from server.ts so the security-critical decisions (who may
 * send, who may approve, what files cross the wire) are unit-testable in
 * isolation. server.ts owns the I/O; this module owns the rules.
 */

import { sep } from 'path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

/** A peer agent registered in a room. */
export type RoomParticipant = {
  name?: string // optional friendly label; the live Discord username is preferred
  blurb: string // one-line capability description
}

/** Per-room collaboration config. */
export type RoomConfig = {
  requireMention: boolean
  participants: Record<string, RoomParticipant> // peer botUserId → info
  humans: string[] // human user IDs also allowed to drive in this room
  sendableRoots: string[] // server-enforced: files must be under one of these
  approvalActorId?: string // who approves this agent's work; defaults to self.ownerUserId
}

/** This agent's own identity, written by /knock-knock:room setup. */
export type Self = {
  name?: string // the live Discord bot username; server refreshes it on connect
  ownerUserId: string // Discord user ID of the human who owns this agent
  blurb: string
  roomChannelId: string // primary room where approval prompts are posted
}

export type Access = {
  self?: Self
  rooms: Record<string, RoomConfig>
  // DM fields — kept for owner pairing/setup flow
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    rooms: {},
    dmPolicy: 'pairing',
    allowFrom: [],
    pending: {},
  }
}

/** Drop expired pairing codes. Returns true if anything was removed. */
export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/** Who may approve this agent's work: the room's approvalActorId, else the self owner. */
export function approverFor(access: Access): string | undefined {
  const roomId = access.self?.roomChannelId
  const room = roomId ? access.rooms[roomId] : undefined
  return room?.approvalActorId ?? access.self?.ownerUserId
}

/**
 * Whether a guild-channel sender may drive this agent: the agent's own owner, a
 * registered peer bot, or a listed human — and never the agent itself (loop
 * guard). The owner is always allowed in their own room even if not in `humans`,
 * so the operator can speak to their agent without extra setup.
 */
export function guildSenderAllowed(
  room: RoomConfig,
  senderId: string,
  selfUserId: string | undefined,
  ownerId?: string,
): boolean {
  if (senderId === selfUserId) return false
  if (ownerId && senderId === ownerId) return true
  return senderId in room.participants || room.humans.includes(senderId)
}

/**
 * Classify a room sender for priority/labelling. `owner` is the human operating
 * this agent (their word overrides peer chatter); `human` is another person in
 * the room; `agent` is a registered peer bot.
 */
export function senderKind(
  room: RoomConfig,
  senderId: string,
  ownerId?: string,
): 'owner' | 'human' | 'agent' | 'unknown' {
  if (ownerId && senderId === ownerId) return 'owner'
  if (room.humans.includes(senderId)) return 'human'
  if (senderId in room.participants) return 'agent'
  return 'unknown'
}

/** Whether a resolved path is one of, or nested under, the resolved roots. */
export function isWithinRoots(realPath: string, realRoots: string[]): boolean {
  return realRoots.some(root => realPath === root || realPath.startsWith(root + sep))
}

/** The roster lines injected into session instructions and returned by list_agents. */
export function buildRosterLines(access: Access): string {
  const self = access.self
  if (!self?.roomChannelId) return ''
  const room = access.rooms[self.roomChannelId]
  if (!room?.participants || Object.keys(room.participants).length === 0) return ''
  return Object.entries(room.participants)
    .map(([botId, p]) => `  • ${p.name ? `${p.name} ` : ''}(<@${botId}>): ${p.blurb}`)
    .join('\n')
}

// ─── Policy classification for adapters without native pattern matching ───────
//
// The ClaudeSdkAdapter hands allow/ask/deny patterns straight to the SDK, which
// does the matching. The ACP adapter can't: ACP surfaces one permission request
// per tool call and the *client* must decide. classifyTool maps such a request
// onto the room's allow/ask/deny profile using the same CC-style "Tool(arg)"
// pattern syntax, so one settings.json drives every runtime.
//
// Precedence: deny wins, then ask, then allow. Anything unmatched defaults to
// 'ask' — an unknown tool must never silently auto-run. The deny tier also does
// a command-boundary literal check so a dangerous command stays blocked even
// when chained (e.g. "cd /tmp && rm -rf x") — over-blocking is the safe failure.

/** A tool-call permission request, normalized across runtimes. */
export type ToolDescriptor = {
  /** Explicit tool name if the runtime provides one (e.g. "Bash"). */
  toolName?: string
  /** ACP ToolKind: read | edit | delete | move | search | execute | fetch | … */
  kind?: string
  /** Human-readable title, e.g. "Run `rm -rf /tmp`". Matched if no subject. */
  title?: string
  /** Primary argument when extractable: shell command, file path, or URL. */
  subject?: string
}

/** ACP ToolKind → the CC tool names a pattern might use for it. */
const KIND_TO_TOOLS: Record<string, string[]> = {
  read: ['Read', 'LS', 'Glob', 'NotebookRead'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  search: ['Grep', 'Glob', 'Search'],
  execute: ['Bash', 'Shell', 'Execute'],
  fetch: ['WebFetch', 'WebSearch', 'Fetch'],
  think: ['Think'],
}

function parsePattern(p: string): { tool: string; arg: string | null } {
  const m = p.match(/^([A-Za-z_][\w-]*)(?:\((.*)\))?$/)
  if (!m) return { tool: p, arg: null }
  return { tool: m[1]!, arg: m[2] ?? null }
}

function toolNamesFor(d: ToolDescriptor): string[] {
  const names: string[] = []
  if (d.toolName) names.push(d.toolName)
  if (d.kind) {
    names.push(...(KIND_TO_TOOLS[d.kind.toLowerCase()] ?? []))
    names.push(d.kind) // also let a pattern match the raw kind, e.g. "execute"
  }
  return names
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*')
  return new RegExp('^' + escaped + '$', 'i')
}

/** Does the deny literal appear at a command boundary (start or after a shell
 *  separator)? Catches chained dangerous commands the anchored glob would miss,
 *  without matching substrings inside unrelated words ("git" ≠ "digit"). */
function denyLiteralHit(arg: string, subject: string): boolean {
  const core = arg.replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!core) return false
  const esc = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  return new RegExp('(^|[\\s;&|()])' + esc, 'i').test(subject)
}

/**
 * Classify a tool-call permission request against the room profile.
 * Returns 'allow' (auto-approve, no prompt), 'ask' (route to the owner), or
 * 'deny' (hard floor — auto-reject, the owner never sees it).
 */
export function classifyTool(
  profile: { allow: string[]; ask: string[]; deny: string[] },
  descriptor: ToolDescriptor,
): 'allow' | 'ask' | 'deny' {
  const subject = (descriptor.subject ?? descriptor.title ?? '').trim()
  const tools = toolNamesFor(descriptor)

  const tierMatch = (patterns: string[], deny: boolean): boolean => {
    for (const p of patterns) {
      const { tool, arg } = parsePattern(p)
      // Deny is defense-in-depth: a concrete dangerous command literal is blocked
      // no matter which ToolKind the agent labels it. Runtimes disagree on kinds
      // (we saw the same `rm -rf` arrive as both `execute` and `other`), so the
      // floor must not hinge on the label. Wildcard-only args ("*") have no
      // literal and fall through to the tool-name check below.
      if (deny && arg && denyLiteralHit(arg, subject)) return true
      if (!tools.some(t => t.toLowerCase() === tool.toLowerCase())) continue
      if (arg === null || arg === '' || arg === '*' || arg === '**') return true
      if (globToRegExp(arg).test(subject)) return true
    }
    return false
  }

  if (tierMatch(profile.deny, true)) return 'deny'
  if (tierMatch(profile.ask, false)) return 'ask'
  if (tierMatch(profile.allow, false)) return 'allow'
  return 'ask'
}

/**
 * Discord caps messages at 2000 chars. Split long replies, preferring paragraph
 * boundaries when mode is 'newline'.
 */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      if (para > limit / 2) {
        cut = para
      } else if (line > limit / 2) {
        cut = line
      } else if (space > 0) {
        cut = space
      } else {
        cut = limit
      }
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
