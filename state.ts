/**
 * State I/O for knock-knock — path constants, the access file, and per-room
 * permission profiles. This is the only module that reads or writes these files.
 * No top-level side effects; safe to import without touching Discord.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { type Access, type AgentConfig, defaultAccess } from './lib.ts'
import type { PermissionProfile } from './agent-adapter.ts'

export type { PermissionProfile }

export const STATE_DIR =
  process.env.KNOCK_KNOCK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'knock-knock')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')

/** The permission profile for a room: rooms/<agentKey>/<channelId>.settings.json. */
export function roomSettingsPath(agentKey: string, channelId: string): string {
  return join(STATE_DIR, 'rooms', agentKey, `${channelId}.settings.json`)
}

/** Read a room's allow/ask/deny profile. Missing or unreadable → empty profile. */
export function readRoomSettings(agentKey: string, channelId: string): PermissionProfile {
  try {
    const parsed = JSON.parse(readFileSync(roomSettingsPath(agentKey, channelId), 'utf8')) as Partial<PermissionProfile>
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      ask: Array.isArray(parsed.ask) ? parsed.ask : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny : [],
    }
  } catch {
    return { allow: [], ask: [], deny: [] }
  }
}

/** Read the access file. Missing → defaults; corrupt → moved aside, then defaults. */
export function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      agents: parsed.agents && typeof parsed.agents === 'object'
        ? (parsed.agents as Record<string, AgentConfig>)
        : {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
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

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}
