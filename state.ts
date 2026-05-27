/**
 * Shared state I/O for knock-knock — path constants, readAccessFile, saveAccess,
 * and room settings. Imported by relay.ts (and server.ts could use it too).
 * No top-level side effects; safe to import without triggering Discord/MCP init.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  type Access,
  type AccessV2,
  type AgentConfig,
  defaultAccess,
  defaultAccessV2,
} from './lib.ts'

export const STATE_DIR =
  process.env.KNOCK_KNOCK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'knock-knock')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')

export type PermissionProfile = {
  allow: string[]
  ask: string[]
  deny: string[]
}

export function roomSettingsPath(channelId: string): string {
  return join(STATE_DIR, 'rooms', `${channelId}.settings.json`)
}

export function readRoomSettings(channelId: string): PermissionProfile
export function readRoomSettings(agentKey: string, channelId: string): PermissionProfile
export function readRoomSettings(agentKeyOrChannelId: string, channelId?: string): PermissionProfile {
  // Build candidate paths: new per-agent path first, then legacy flat path.
  const candidates: string[] = []
  if (channelId !== undefined) {
    // Called as readRoomSettings(agentKey, channelId)
    candidates.push(join(STATE_DIR, 'rooms', agentKeyOrChannelId, `${channelId}.settings.json`))
    candidates.push(roomSettingsPath(channelId))
  } else {
    // Called as readRoomSettings(channelId) — legacy single-agent form
    candidates.push(roomSettingsPath(agentKeyOrChannelId))
  }
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw)
      // Accept both Claude Code settings format ({permissions:{allow,ask,deny}}) and
      // the flat format ({allow,ask,deny}) — the skill writes nested, the CLI writes
      // flat. This is the key fix: the deny floor was silently not loading for skill-
      // generated files.
      const prof = (parsed.permissions ?? parsed) as Partial<PermissionProfile>
      return {
        allow: Array.isArray(prof.allow) ? prof.allow : [],
        ask: Array.isArray(prof.ask) ? prof.ask : [],
        deny: Array.isArray(prof.deny) ? prof.deny : [],
      }
    } catch {
      continue
    }
  }
  return { allow: [], ask: [], deny: [] }
}

export function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      self: parsed.self,
      rooms: parsed.rooms ?? {},
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('knock-knock: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

function writeAccessAtomic(a: Access | AccessV2): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

export function saveAccess(a: Access): void {
  writeAccessAtomic(a)
}

// ─── v2 multi-agent state ──────────────────────────────────────────────────

/**
 * Read and migrate the access file to the v2 multi-agent shape.
 * Migration is READ-ONLY: the file is not rewritten automatically, so existing
 * installs keep working even if the user never runs the setup CLI. The
 * prompt-injection invariant is preserved: access.json is only written from the
 * terminal (CLI or skills), never as a result of channel messages.
 */
export function readAccessFileV2(): AccessV2 {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return migrateToV2(parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccessV2()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('knock-knock: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccessV2()
  }
}

export function saveAccessV2(a: AccessV2): void {
  writeAccessAtomic(a)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateToV2(parsed: any): AccessV2 {
  const globals: Omit<AccessV2, 'version' | 'agents'> = {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
  }

  // Already v2: has an `agents` map.
  if (parsed.agents && typeof parsed.agents === 'object') {
    return { version: 2, agents: parsed.agents as Record<string, AgentConfig>, ...globals }
  }

  // Legacy v1: has a `self` object and top-level `rooms` map.
  // Synthesize a single-entry agents map whose runtime/workspace fall back to
  // the env vars the install already sets (KNOCK_KNOCK_AGENT / _WORKSPACE).
  const self = parsed.self
  const legacyRooms = (parsed.rooms ?? {}) as Record<string, AgentConfig['rooms'][string]>
  const agents: Record<string, AgentConfig> = {}
  if (self?.ownerUserId) {
    const key = slugify(self.name ?? 'default')
    const rooms = { ...legacyRooms }
    // Ensure the primary room is present so routing works.
    if (self.roomChannelId && !rooms[self.roomChannelId]) {
      rooms[self.roomChannelId] = {
        requireMention: true,
        participants: {},
        humans: [],
        sendableRoots: [],
      }
    }
    agents[key] = {
      name: self.name,
      ownerUserId: self.ownerUserId,
      blurb: self.blurb ?? '',
      runtime: process.env.KNOCK_KNOCK_AGENT ?? 'claude-sdk',
      workspace: process.env.KNOCK_KNOCK_WORKSPACE ?? '',
      tokenEnv: 'DISCORD_BOT_TOKEN',
      rooms,
    }
  }

  return { version: 2, agents, ...globals }
}
