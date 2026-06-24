/**
 * State I/O for knock-knock — path constants, the access file, and per-room
 * permission profiles. This is the only module that reads or writes these files.
 * No top-level side effects; safe to import without touching Discord.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import {
  type Access,
  type AgentConfig,
  type AuthoringAccess,
  type KnockSettings,
  type RoomProfile,
  type ActorTiers,
  defaultAccess,
  defaultAuthoringAccess,
  defaultSettings,
  DENY_FLOOR,
  projectToRuntime,
} from './lib.ts'
import type { PermissionProfile } from './agent-adapter.ts'

export type { PermissionProfile, RoomProfile }

export const STATE_DIR =
  process.env.KNOCK_KNOCK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'knock-knock')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

/** The permission profile for a room: rooms/<agentKey>/<channelId>.settings.json. */
export function roomSettingsPath(agentKey: string, channelId: string): string {
  return join(STATE_DIR, 'rooms', agentKey, `${channelId}.settings.json`)
}

/** Pull allow/ask/deny out of either the flat shape or a Claude-Code-style
 *  `{ "permissions": { … } }` wrapper, so a profile written in either form is
 *  honored rather than silently ignored. Exported for unit testing. */
export function parseProfile(raw: string): RoomProfile {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const src = (
    parsed && typeof parsed.permissions === 'object' && parsed.permissions
      ? parsed.permissions
      : parsed
  ) as Partial<RoomProfile> & Record<string, unknown>
  const profile: RoomProfile = {
    allow: Array.isArray(src.allow) ? src.allow : [],
    ask: Array.isArray(src.ask) ? src.ask : [],
    deny: Array.isArray(src.deny) ? src.deny : [],
  }
  const tiers = parseTiers(src.tiers)
  if (tiers) profile.tiers = tiers
  return profile
}

/** Parse the optional per-actor `tiers` map, keeping only well-formed entries
 *  (a tier is a partial allow/ask/deny). Unknown/malformed entries are dropped. */
function parseTiers(raw: unknown): ActorTiers | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: ActorTiers = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue
    const v = val as Record<string, unknown>
    const tier: Partial<PermissionProfile> = {}
    if (Array.isArray(v.allow)) tier.allow = v.allow as string[]
    if (Array.isArray(v.ask)) tier.ask = v.ask as string[]
    if (Array.isArray(v.deny)) tier.deny = v.deny as string[]
    if (tier.allow || tier.ask || tier.deny) out[key] = tier
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Read a room's allow/ask/deny profile. Missing or unreadable → empty profile.
 *
 * A profile written in the `{ "permissions": {…} }` wrapper is unwrapped (so a
 * Claude-Code-style settings.json is honored). An empty-but-present file warns
 * loudly rather than silently degrading to "everything asks" — that also drops
 * the deny floor, which is almost never what an empty file is meant to do.
 */
export function readRoomSettings(agentKey: string, channelId: string): RoomProfile {
  const path = roomSettingsPath(agentKey, channelId)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { allow: [], ask: [], deny: [] } // no profile at this path
  }
  let profile: RoomProfile
  try {
    profile = parseProfile(raw)
  } catch {
    process.stderr.write(`knock-knock: room profile at ${path} is not valid JSON — ignoring it.\n`)
    return { allow: [], ask: [], deny: [] }
  }
  if (profile.allow.length + profile.ask.length + profile.deny.length === 0) {
    process.stderr.write(
      `knock-knock: room profile at ${path} parsed to an EMPTY profile — every tool will ` +
        `default to 'ask'. Use top-level allow/ask/deny ` +
        `(a { "permissions": { … } } wrapper is also accepted).\n`,
    )
  }
  // Re-union the current DENY_FLOOR at READ time, not just write time. Presets
  // expand the floor when a room file is written, but a profile written by an
  // OLDER build (or hand-authored) would otherwise miss floor entries added
  // since — including the credential Read/FileShare floor. Unioning here makes
  // the floor hold for every room on upgrade, and `deny` only ever tightens.
  // Done after the empty-check so a genuinely empty file still warns.
  profile.deny = [...new Set([...profile.deny, ...DENY_FLOOR])]
  return profile
}

/**
 * Read the access file as the agent-keyed RUNTIME shape the relay/hosts consume.
 *
 * access.json is authored in the normalized, channel-centric `AuthoringAccess`
 * shape (a `bots` table + `channels` + `roster`); this projects it down via
 * `projectToRuntime`. A legacy file written in the agent-keyed shape (top-level
 * `agents`, no `bots`) is still honored as-is, so an existing config keeps working
 * without a migration step.
 *
 * Missing → defaults; corrupt → moved aside, then defaults.
 */
export function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Record<string, unknown>
    if (isAuthoringShape(parsed)) return projectToRuntime(parseAuthoringAccess(parsed))
    // Legacy agent-keyed shape — honor as-is.
    return {
      agents: parsed.agents && typeof parsed.agents === 'object'
        ? (parsed.agents as Record<string, AgentConfig>)
        : {},
      mentionPatterns: parsed.mentionPatterns as string[] | undefined,
      ackReaction: parsed.ackReaction as string | undefined,
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

/** A parsed access.json is in the new authoring shape iff it has a `bots` table. */
function isAuthoringShape(parsed: Record<string, unknown>): boolean {
  return !!parsed.bots && typeof parsed.bots === 'object' && !Array.isArray(parsed.bots)
}

/** Coerce raw JSON into a well-formed `AuthoringAccess`, dropping malformed parts.
 *  Lenient like `parseProfile`/`parseSettings`: a missing table becomes empty. */
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

/** Read access.json as the channel-centric AUTHORING shape (what setup.ts edits).
 *  A missing file or a legacy agent-keyed file → a fresh empty authoring config. */
export function readAuthoringAccess(): AuthoringAccess {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Record<string, unknown>
    if (isAuthoringShape(parsed)) return parseAuthoringAccess(parsed)
    // A legacy agent-keyed file is not auto-migrated, and the next save would
    // overwrite it. Preserve it once (access.json.legacy) so no config is lost.
    const backup = ACCESS_FILE + '.legacy'
    if (!existsSync(backup)) {
      try {
        copyFileSync(ACCESS_FILE, backup)
        process.stderr.write(
          `knock-knock: legacy access.json detected — backed up to ${backup}. ` +
            `Setup now uses the channel-centric shape; re-add your bots/channels.\n`,
        )
      } catch {}
    }
    return defaultAuthoringAccess()
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

/** Persist a legacy agent-keyed runtime Access (retained for transitional callers). */
export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// ─── Machine-global settings (settings.json) ───────────────────────────────────
//
// Ledger backend + named permission presets. Written only by the setup CLI, so
// it carries the same prompt-injection invariant as access.json. Sibling file,
// kept separate because this config is machine-global, not agent-identity keyed.

/** Pull a well-typed KnockSettings out of raw JSON, dropping anything malformed.
 *  Pure (like parseProfile) so it can be unit-tested without touching disk. */
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
//
// When an owner resumes a local session into a channel, we persist the binding
// so it survives a relay restart. This is deliberately a LOCAL file (not a
// ledger note): a runtime session lives on one machine, so the binding must not
// sync to peers who can't load it. Sibling of the room settings file.

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
  } catch {
    // already absent — fine
  }
}
