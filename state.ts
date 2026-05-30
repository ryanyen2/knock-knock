/**
 * State I/O for knock-knock — path constants, the access file, and per-room
 * permission profiles. This is the only module that reads or writes these files.
 * No top-level side effects; safe to import without touching Discord.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
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

// ─── Resume bindings ─────────────────────────────────────────────────────────
//
// When an owner resumes a local session into a channel, we persist the binding
// so it survives a relay restart. This is deliberately a LOCAL file (not a
// ledger note): a runtime session lives on one machine, so the binding must not
// sync to peers who can't load it. Sibling of the room settings file.

/** A channel bound to an existing runtime session, to resume on next start. */
export type SessionBinding = { runtime: string; sessionId: string }

/** rooms/<agentKey>/<channelId>.session.json */
export function sessionBindingPath(agentKey: string, channelId: string): string {
  return join(STATE_DIR, 'rooms', agentKey, `${channelId}.session.json`)
}

/** Read a channel's resume binding, or undefined if none / unreadable. */
export function readSessionBinding(agentKey: string, channelId: string): SessionBinding | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionBindingPath(agentKey, channelId), 'utf8')) as Partial<SessionBinding>
    if (typeof parsed.runtime === 'string' && typeof parsed.sessionId === 'string') {
      return { runtime: parsed.runtime, sessionId: parsed.sessionId }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Persist a channel's resume binding (atomic write). */
export function writeSessionBinding(agentKey: string, channelId: string, binding: SessionBinding): void {
  const path = sessionBindingPath(agentKey, channelId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(binding, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** Remove a channel's resume binding, if any. */
export function clearSessionBinding(agentKey: string, channelId: string): void {
  try {
    rmSync(sessionBindingPath(agentKey, channelId))
  } catch {
    // already absent — fine
  }
}
