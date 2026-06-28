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
  type Proposal,
  type Tombstone,
  type TrustAnchors,
  type TrustedPair,
  defaultAccess,
  defaultAuthoringAccess,
  defaultSettings,
  projectToRuntime,
  addProposal,
  reconcilePendingAgainst,
} from './lib.ts'
import type { PermissionProfile } from './agent-adapter.ts'

export type { PermissionProfile, RoomProfile }

export const STATE_DIR =
  process.env.KNOCK_KNOCK_STATE_DIR ?? join(homedir(), '.knock-knock')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const SETTINGS_FILE = join(STATE_DIR, 'settings.json')
/** Relay-owned discovery proposals + scan heartbeat. Sibling of access.json, never folded
 *  into the runtime Access (see KTD3). */
export const PENDING_FILE = join(STATE_DIR, 'pending.json')

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
    ...(parsed.trust && typeof parsed.trust === 'object' && !Array.isArray(parsed.trust)
      ? { trust: parseTrustAnchors(parsed.trust as Record<string, unknown>) }
      : {}),
  }
}

/** Coerce raw JSON into well-formed TrustAnchors, dropping malformed entries. The relay never
 *  writes these (terminal-owned); a torn/garbage entry must not crash a relay read. */
function parseTrustAnchors(raw: Record<string, unknown>): TrustAnchors {
  const tombstones = Array.isArray(raw.tombstones)
    ? (raw.tombstones as unknown[]).filter(
        (t): t is Tombstone =>
          !!t && typeof t === 'object' &&
          typeof (t as Tombstone).agentKey === 'string' &&
          typeof (t as Tombstone).userId === 'string' &&
          typeof (t as Tombstone).declinedAt === 'string',
      )
    : []
  const trustedPairs = Array.isArray(raw.trustedPairs)
    ? (raw.trustedPairs as unknown[]).filter(
        (t): t is TrustedPair =>
          !!t && typeof t === 'object' &&
          typeof (t as TrustedPair).agentKey === 'string' &&
          typeof (t as TrustedPair).userId === 'string' &&
          typeof (t as TrustedPair).trustedAt === 'string',
      )
    : []
  return { tombstones, trustedPairs }
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

// ─── Terminal-owned trust anchors (decline tombstones + trusted pairs) ─────────
// Decisions live in access.json's base, written ONLY from the terminal (KTD3) — keeping
// trust anchors out of the relay-writable pending.json closes the tamper surface. The relay
// READS these to gate re-proposing and auto-adopt; it never writes them.

/** The terminal-owned trust anchors from access.json (empty when none). */
export function readTrustAnchors(): TrustAnchors {
  return readAuthoringAccess().trust ?? { tombstones: [], trustedPairs: [] }
}

/** Record a decline tombstone for an (agentKey,userId) pair (terminal-only writer; idempotent
 *  per pair). */
export function addTombstone(t: Tombstone): void {
  const a = readAuthoringAccess()
  const trust = a.trust ?? { tombstones: [], trustedPairs: [] }
  if (trust.tombstones.some(x => x.agentKey === t.agentKey && x.userId === t.userId)) return
  saveAuthoringAccess({ ...a, trust: { ...trust, tombstones: [...trust.tombstones, t] } })
}

/** Mark an (agentKey,userId) pair trusted for auto-adopt (terminal-only writer; idempotent). */
export function addTrustedPair(tp: TrustedPair): void {
  const a = readAuthoringAccess()
  const trust = a.trust ?? { tombstones: [], trustedPairs: [] }
  if (trust.trustedPairs.some(x => x.agentKey === tp.agentKey && x.userId === tp.userId)) return
  saveAuthoringAccess({ ...a, trust: { ...trust, trustedPairs: [...trust.trustedPairs, tp] } })
}

// ─── Relay-owned pending store (pending.json) ──────────────────────────────────
// The relay is the SOLE writer (no cross-process lock, KTD3). On each pass it appends
// newly-discovered proposals (honoring terminal-owned tombstones) and reconciles away ones
// now confirmed, stamping a `lastScanAt` heartbeat so `doctor` can tell "relay offline" from
// "no peers." `parseAuthoringAccess` never sees this file, so proposals stay inert.

/** pending.json: the relay's discovered proposals plus its last scan heartbeat. */
export type PendingStore = { proposals: Proposal[]; lastScanAt?: string }

function emptyPending(): PendingStore {
  return { proposals: [] }
}

/** Coerce raw JSON into a well-formed PendingStore, dropping malformed proposals. */
function parsePending(raw: Record<string, unknown>): PendingStore {
  const proposals = Array.isArray(raw.proposals)
    ? (raw.proposals as unknown[]).filter(
        (p): p is Proposal =>
          !!p && typeof p === 'object' &&
          typeof (p as Proposal).kind === 'string' &&
          typeof (p as Proposal).platform === 'string' &&
          typeof (p as Proposal).targetId === 'string' &&
          typeof (p as Proposal).discoveredAt === 'string' &&
          !!(p as Proposal).claimed && typeof (p as Proposal).claimed === 'object',
      )
    : []
  return {
    proposals,
    ...(typeof raw.lastScanAt === 'string' ? { lastScanAt: raw.lastScanAt } : {}),
  }
}

/** Read pending.json. Missing → empty; corrupt → moved aside, then empty (a concurrent
 *  `doctor` read never sees a torn file). */
export function readPending(): PendingStore {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_FILE, 'utf8')) as Record<string, unknown>
    return parsePending(parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyPending()
    try {
      renameSync(PENDING_FILE, `${PENDING_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('knock-knock: pending.json is corrupt, moved aside. Starting fresh.\n')
    return emptyPending()
  }
}

/** Persist the pending store (atomic 0600 temp-rename — same discipline as access.json).
 *  The relay is the only writer. */
export function writePending(s: PendingStore): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = PENDING_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, PENDING_FILE)
}

/** Append a discovered proposal to pending.json, honoring terminal-owned tombstones and the
 *  per-agentKey cap (claimed strings are sanitized on store). Reads access.json for the live
 *  tombstone set so a declined pair is never re-proposed. Returns the new store. Relay-only. */
export function appendPending(proposal: Proposal): PendingStore {
  const store = readPending()
  const tombstones = readTrustAnchors().tombstones
  const proposals = addProposal(store.proposals, proposal, tombstones)
  const next: PendingStore = { ...store, proposals }
  writePending(next)
  return next
}

/** Drop pending proposals now confirmed in access.json and stamp the scan heartbeat. Relay-only. */
export function reconcilePending(lastScanAt: string): PendingStore {
  const store = readPending()
  const proposals = reconcilePendingAgainst(store.proposals, readAuthoringAccess())
  const next: PendingStore = { proposals, lastScanAt }
  writePending(next)
  return next
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
