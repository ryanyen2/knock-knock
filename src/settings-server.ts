/**
 * settings-server.ts — the localhost-only web settings surface (`knock-knock setup --ui`).
 *
 * A second front-end over the same config the terminal wizard and the relay use: it
 * serves a single embedded page plus a small JSON API that reads and writes
 * `~/.knock-knock/access.json` through state.ts's validated write path. It NEVER writes
 * the file itself, never exposes secret values, and never opens beyond loopback.
 *
 * Security posture (the file it edits gates which agents may act, so the bar is high):
 *   • binds 127.0.0.1 on an ephemeral port — an unguessable URL, off the LAN entirely
 *   • Host-allowlist on every request          (DNS-rebinding defense)
 *   • per-run bearer token on every /api request (other-local-process defense; gates reads
 *     too, since the config body maps who-may-drive)
 *   • Origin-allowlist on every mutating /api request (CSRF defense)
 *   • no CORS allowance, Referrer-Policy: no-referrer, X-Frame-Options: DENY
 *   • generic error bodies (no paths, hashes, or stack traces)
 *
 * The guard logic is a pure function (`guardRequest`) so it is unit-testable without
 * binding a port; the `Bun.serve` shell stays thin (mirrors webhook-receiver.ts).
 */

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'

export type SettingsServerHandle = {
  readonly url: string
  readonly port: number
  stop(): void
}

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
function tokenMatches(authorization: string | null, token: string): boolean {
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

/** Wrap a response with the standard security headers. Never sets any CORS header. */
export function secured(res: Response): Response {
  res.headers.set('Referrer-Policy', 'no-referrer')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  return res
}

/** A generic JSON error body — no filesystem paths, hashes, or stack traces leak out. */
export function errorResponse(status: number, code: string): Response {
  return secured(
    new Response(JSON.stringify({ error: code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

export function jsonResponse(body: unknown, status = 200): Response {
  return secured(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

/**
 * Start the settings server. Binds `127.0.0.1` on an ephemeral port by default (override
 * with `KNOCK_KNOCK_SETTINGS_PORT`). Returns a handle whose `stop()` closes it; the server's
 * lifetime is the foreground process.
 */
export function startSettingsServer(opts: {
  token: string
  port?: number
  hostname?: string
  log?: (msg: string) => void
}): SettingsServerHandle {
  const hostname = opts.hostname ?? '127.0.0.1'
  const envPort = process.env.KNOCK_KNOCK_SETTINGS_PORT
  // Ephemeral (port 0) by default: an unguessable port is cheap defense-in-depth.
  const port = opts.port ?? (envPort ? Number(envPort) : 0)
  const log = opts.log ?? (() => {})

  const server: Server<undefined> = Bun.serve({
    port,
    hostname,
    fetch: (req) => handleRequest(req, { token: opts.token, hostname, boundPort: server.port ?? port }),
  })

  const boundPort = server.port ?? port
  const url = `http://${hostname}:${boundPort}/?token=${opts.token}`
  log(`settings UI on http://${hostname}:${boundPort}`)
  return {
    url,
    port: boundPort,
    stop: () => server.stop(true),
  }
}

/** Build the Host/Origin allowlists for the bound port (both 127.0.0.1 and localhost forms). */
function allowlistsFor(boundPort: number): { allowedHosts: Set<string>; allowedOrigins: Set<string> } {
  const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]
  return {
    allowedHosts: new Set(hosts),
    allowedOrigins: new Set(hosts.map(h => `http://${h}`)),
  }
}

async function handleRequest(
  req: Request,
  ctx: { token: string; hostname: string; boundPort: number },
): Promise<Response> {
  try {
    const url = new URL(req.url)
    const isApi = url.pathname.startsWith('/api/')
    const { allowedHosts, allowedOrigins } = allowlistsFor(ctx.boundPort)
    const guard = guardRequest(
      {
        method: req.method,
        host: req.headers.get('host'),
        origin: req.headers.get('origin'),
        authorization: req.headers.get('authorization'),
        isApi,
      },
      { allowedHosts, allowedOrigins, token: ctx.token },
    )
    if (!guard.ok) return errorResponse(guard.status, guard.status === 401 ? 'unauthorized' : 'forbidden')

    // Routes are layered in by later units; the skeleton answers health + a 404 floor.
    if (req.method === 'GET' && url.pathname === '/api/health') return jsonResponse({ ok: true })
    return errorResponse(404, 'not_found')
  } catch {
    return errorResponse(500, 'internal_error')
  }
}
