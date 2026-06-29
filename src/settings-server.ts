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

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Server } from 'bun'
import {
  ACCESS_FILE,
  parseAuthoringAccess,
  saveAuthoringAccess,
  readSettings,
  saveSettings,
} from './state.ts'
import {
  defaultAuthoringAccess,
  sanitizeAuthoringInput,
  validateAuthoringConfig,
  type AuthoringAccess,
} from './lib.ts'
import { guardRequest, MAX_BODY_BYTES } from './settings-guard.ts'
import { SETTINGS_HTML } from './settings-ui.ts'

export type SettingsServerHandle = {
  readonly url: string
  readonly port: number
  stop(): void
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

/** Version token for the on-disk config when no file exists yet. A file appearing
 *  underneath the editor changes the version away from this sentinel → 409. */
const ABSENT_VERSION = 'absent'

/** Read access.json once and derive both the parsed config and a content-hash version from
 *  the SAME bytes (closes the read-side TOCTOU mtime+size would hide). ENOENT ⇒ defaults +
 *  the absent sentinel. A corrupt/garbage file throws (the caller answers 500) rather than
 *  silently editing defaults over a recoverable file. */
function readConfigWithVersion(): { access: AuthoringAccess; version: string } {
  let buf: Buffer
  try {
    buf = readFileSync(ACCESS_FILE)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { access: defaultAuthoringAccess(), version: ABSENT_VERSION }
    }
    throw err
  }
  const version = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const access = parseAuthoringAccess(JSON.parse(buf.toString('utf8')) as Record<string, unknown>)
  return { access, version }
}

/** Read and JSON-parse a request body, enforcing the size cap. Throws `BODY_TOO_LARGE` /
 *  `BAD_JSON` sentinels the caller maps to 413 / 400. */
async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('BAD_JSON')
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

    if (req.method === 'GET' && url.pathname === '/') {
      return secured(new Response(SETTINGS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return jsonResponse({ ok: true })
    if (req.method === 'GET' && url.pathname === '/api/config') return handleReadConfig()
    if (req.method === 'PUT' && url.pathname === '/api/config') return handleWriteConfig(req)
    if (req.method === 'PUT' && url.pathname === '/api/ledger') return handleWriteLedger(req)
    return errorResponse(404, 'not_found')
  } catch {
    return errorResponse(500, 'internal_error')
  }
}

/** GET /api/config → the current config, ledger backend, and a content-hash version. */
function handleReadConfig(): Response {
  const { access, version } = readConfigWithVersion()
  return jsonResponse({ access, ledger: readSettings().ledger ?? null, version })
}

/** PUT /api/config → sanitize, version-check (409), validate (400), persist via state.ts. */
async function handleWriteConfig(req: Request): Promise<Response> {
  let body: { config?: unknown; version?: unknown }
  try {
    body = (await readJsonBody(req)) as { config?: unknown; version?: unknown }
  } catch (e) {
    return errorResponse((e as Error).message === 'BODY_TOO_LARGE' ? 413 : 400, 'bad_request')
  }
  const { access: current, version: currentVersion } = readConfigWithVersion()
  if (typeof body.version !== 'string' || body.version !== currentVersion) {
    return errorResponse(409, 'conflict')
  }
  const next = sanitizeAuthoringInput(body.config, current)
  const errors = validateAuthoringConfig(next)
  if (errors.length) return jsonResponse({ error: 'validation', fields: errors }, 400)
  saveAuthoringAccess(next)
  return jsonResponse({ version: readConfigWithVersion().version })
}

/** PUT /api/ledger → set the ledger backend in settings.json (independent of access.json). */
async function handleWriteLedger(req: Request): Promise<Response> {
  let body: { backend?: unknown; url?: unknown }
  try {
    body = (await readJsonBody(req)) as { backend?: unknown; url?: unknown }
  } catch (e) {
    return errorResponse((e as Error).message === 'BODY_TOO_LARGE' ? 413 : 400, 'bad_request')
  }
  if (body.backend !== 'sqlite' && body.backend !== 'postgres') {
    return jsonResponse({ error: 'validation', fields: [{ field: 'backend', message: 'Choose sqlite or postgres.' }] }, 400)
  }
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (body.backend === 'postgres' && !url) {
    return jsonResponse({ error: 'validation', fields: [{ field: 'url', message: 'Postgres needs a connection URL.' }] }, 400)
  }
  saveSettings({ ...readSettings(), ledger: { backend: body.backend, ...(url ? { url } : {}) } })
  return jsonResponse({ ok: true })
}
