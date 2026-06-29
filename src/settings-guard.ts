/**
 * settings-guard.ts — the pure request-guard layer for the settings server.
 *
 * Deliberately imports NO state/I/O module: the guard is a pure function of a request's
 * headers, so it (and its tests) never trigger state.ts's module-load, which binds
 * KNOCK_KNOCK_STATE_DIR once. Keeping it state-free is what lets settings-server.test.ts
 * exercise the guard without accidentally binding (and writing to) the real ~/.knock-knock.
 */

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

/** Default port when `KNOCK_KNOCK_SETTINGS_PORT` is unset and no ephemeral port is forced. */
export const DEFAULT_SETTINGS_PORT = 8788
/** Max accepted request body (a config file is a few KB; this is generous headroom). */
export const MAX_BODY_BYTES = 256 * 1024

export type GuardContext = {
  allowedHosts: Set<string>
  allowedOrigins: Set<string>
  token: string
}

export type GuardInput = {
  method: string
  host: string | null
  origin: string | null
  authorization: string | null
  /** Whether the request targets the JSON API (`/api/…`) vs. the static page shell. */
  isApi: boolean
}

export type GuardResult = { ok: true } | { ok: false; status: number }

/** Constant-time bearer-token check. Accepts `Authorization: Bearer <t>` or the raw token.
 *  Length is compared first so `timingSafeEqual` never throws on a mismatched-length input. */
export function tokenMatches(authorization: string | null, token: string): boolean {
  if (!authorization) return false
  const m = /^Bearer\s+(.+)$/i.exec(authorization)
  const provided = (m ? m[1]! : authorization).trim()
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Decide whether a request is allowed, as a pure function of its headers. The static page
 * shell (`isApi: false`) is Host-checked only — it carries no secrets and the data lives
 * behind the token-gated API. Every API request needs a valid Host and token; mutating API
 * requests additionally need an allowed Origin.
 */
export function guardRequest(g: GuardInput, ctx: GuardContext): GuardResult {
  if (!g.host || !ctx.allowedHosts.has(g.host)) return { ok: false, status: 403 }
  if (!g.isApi) return { ok: true }
  if (!tokenMatches(g.authorization, ctx.token)) return { ok: false, status: 401 }
  const mutating = g.method !== 'GET' && g.method !== 'HEAD'
  if (mutating && (!g.origin || !ctx.allowedOrigins.has(g.origin))) return { ok: false, status: 403 }
  return { ok: true }
}
