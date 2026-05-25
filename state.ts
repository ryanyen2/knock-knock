/**
 * Shared state I/O for knock-knock — path constants, readAccessFile, saveAccess,
 * and room settings. Imported by relay.ts (and server.ts could use it too).
 * No top-level side effects; safe to import without triggering Discord/MCP init.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { type Access, defaultAccess } from './lib.ts'

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

export function readRoomSettings(channelId: string): PermissionProfile {
  try {
    const raw = readFileSync(roomSettingsPath(channelId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PermissionProfile>
    return {
      allow: parsed.allow ?? [],
      ask: parsed.ask ?? [],
      deny: parsed.deny ?? [],
    }
  } catch {
    return { allow: [], ask: [], deny: [] }
  }
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

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}
