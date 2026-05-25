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
