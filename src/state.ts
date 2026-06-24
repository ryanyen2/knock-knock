/**
 * State I/O for knock-knock — the only module that reads/writes the access/settings files.
 * access.json is authored only in the channel-centric `AuthoringAccess` shape; the relay consumes the agent-keyed `Access` projected from it.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import {
  type Access,
  type AuthoringAccess,
  type KnockSettings,
  type RoomProfile,
  defaultAccess,
  defaultAuthoringAccess,
  defaultSettings,
  projectToRuntime,
} from './lib.ts'
import type { PermissionProfile } from './agent-adapter.ts'

export type { PermissionProfile, RoomProfile }

export const STATE_DIR =
  process.env.KNOCK_KNOCK_STATE_DIR ?? join(homedir(), '.knock-knock')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

/** Read access.json as the agent-keyed runtime `Access`. Missing → defaults; corrupt → moved aside, then defaults. */
export function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Record<string, unknown>
    return projectToRuntime(parseAuthoringAccess(parsed))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('knock-knock: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

/** Coerce raw JSON into a well-formed `AuthoringAccess`, dropping malformed parts. */
export function parseAuthoringAccess(parsed: Record<string, unknown>): AuthoringAccess {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const roster = obj(parsed.roster)
  return {
    ...(parsed.me && typeof parsed.me === 'object' ? { me: parsed.me as AuthoringAccess['me'] } : {}),
    bots: obj(parsed.bots) as AuthoringAccess['bots'],
    channels: obj(parsed.channels) as AuthoringAccess['channels'],
    roster: {
      people: obj(roster.people) as AuthoringAccess['roster']['people'],
      peers: obj(roster.peers) as AuthoringAccess['roster']['peers'],
    },
    ...(Array.isArray(parsed.mentionPatterns) ? { mentionPatterns: parsed.mentionPatterns as string[] } : {}),
    ...(typeof parsed.ackReaction === 'string' ? { ackReaction: parsed.ackReaction } : {}),
  }
}

/** Read access.json as the channel-centric authoring shape (what setup.ts edits). */
export function readAuthoringAccess(): AuthoringAccess {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Record<string, unknown>
    return parseAuthoringAccess(parsed)
  } catch {
    return defaultAuthoringAccess()
  }
}

/** Persist the channel-centric authoring config (atomic, 0600). */
export function saveAuthoringAccess(a: AuthoringAccess): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// ─── Machine-global settings (settings.json) ───────────────────────────────────

/** Pull a well-typed KnockSettings out of raw JSON, dropping anything malformed. Pure (testable without disk). */
export function parseSettings(raw: string): KnockSettings {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const out: KnockSettings = {}
  const ledger = parsed.ledger
  if (ledger && typeof ledger === 'object') {
    const l = ledger as Record<string, unknown>
    if (l.backend === 'sqlite' || l.backend === 'postgres') {
      out.ledger = {
        backend: l.backend,
        ...(typeof l.url === 'string' && l.url ? { url: l.url } : {}),
      }
    }
  }
  const presets = parsed.presets
  if (presets && typeof presets === 'object' && !Array.isArray(presets)) {
    out.presets = presets as KnockSettings['presets']
  }
  return out
}

/** Read settings.json. Missing → defaults; corrupt → moved aside, then defaults. */
export function readSettings(): KnockSettings {
  let raw: string
  try {
    raw = readFileSync(SETTINGS_FILE, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings()
    return defaultSettings()
  }
  try {
    return parseSettings(raw)
  } catch {
    try {
      renameSync(SETTINGS_FILE, `${SETTINGS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('knock-knock: settings.json is corrupt, moved aside. Using defaults.\n')
    return defaultSettings()
  }
}

export function saveSettings(s: KnockSettings): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = SETTINGS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, SETTINGS_FILE)
}

// ─── Resume bindings ─────────────────────────────────────────────────────────
// Local file (not a ledger note): a runtime session lives on one machine, so the binding must not sync to peers who can't load it.

/** A channel bound to an existing runtime session, to resume on next start. */
export type SessionBinding = { runtime: string; sessionId: string; workspace?: string }

/** rooms/<agentKey>/<channelId>.session.json */
export function sessionBindingPath(agentKey: string, channelId: string): string {
  return join(STATE_DIR, 'rooms', agentKey, `${channelId}.session.json`)
}

/** Read a channel's resume binding, or undefined if none / unreadable. */
export function readSessionBinding(agentKey: string, channelId: string): SessionBinding | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionBindingPath(agentKey, channelId), 'utf8')) as Partial<SessionBinding>
    if (typeof parsed.runtime === 'string' && typeof parsed.sessionId === 'string') {
      return {
        runtime: parsed.runtime,
        sessionId: parsed.sessionId,
        ...(typeof parsed.workspace === 'string' ? { workspace: parsed.workspace } : {}),
      }
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
  } catch {}
}
