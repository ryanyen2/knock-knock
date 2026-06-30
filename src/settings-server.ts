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
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Server } from 'bun'
import {
  accessFile,
  stateDir,
  parseAuthoringAccess,
  saveAuthoringAccess,
  serializeAuthoringAccess,
  readSettings,
  saveSettings,
} from './state.ts'
import {
  defaultAuthoringAccess,
  sanitizeAuthoringInput,
  validateAuthoringConfig,
  resolveRoomProfile,
  expandPreset,
  PLATFORM_GUIDE,
  RUNTIMES,
  PRESET_HINTS,
  DEFAULT_PRESET,
  type AuthoringAccess,
} from './lib.ts'
import type { PermissionProfile } from './agent-adapter.ts'
import { guardRequest, MAX_BODY_BYTES } from './settings-guard.ts'
import { SETTINGS_HTML } from './settings-ui.ts'

/** A request from the web UI for the launching terminal to run a sensitive wizard flow
 *  (entering a token, editing a channel's permissions) that the web surface deliberately
 *  won't do itself. `bot`/`channel` are validated against the live config before dispatch. */
export type HandoffRequest =
  | { action: 'set-token'; bot: string }
  | { action: 'edit-permissions'; bot: string }
  | { action: 'start-relay' }

/** Provided by setup.ts's `--ui` runner: runs the terminal flow for a handoff request and
 *  resolves when it completes (or rejects on failure/cancel). Absent ⇒ handoff is unsupported
 *  (e.g. the server booted outside an interactive terminal) and the API answers 503. */
export type HandoffRunner = (req: HandoffRequest) => Promise<void>

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
  /** Runs terminal-side handoff flows (token entry, permission editing). Absent ⇒ /api/handoff
   *  answers 503 (the web UI then just shows "do this in the terminal" without a button). */
  requestHandoff?: HandoffRunner
}): SettingsServerHandle {
  const hostname = opts.hostname ?? '127.0.0.1'
  const envPort = process.env.KNOCK_KNOCK_SETTINGS_PORT
  // Ephemeral (port 0) by default: an unguessable port is cheap defense-in-depth.
  const port = opts.port ?? (envPort ? Number(envPort) : 0)
  const log = opts.log ?? (() => {})
  // Single-flight handoff state for THIS server instance (no module globals).
  const handoff: HandoffState = { state: 'idle', runner: opts.requestHandoff }

  const server: Server<undefined> = Bun.serve({
    port,
    hostname,
    fetch: (req) => handleRequest(req, { token: opts.token, hostname, boundPort: server.port ?? port, handoff }),
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
function versionOf(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

function readConfigWithVersion(): { access: AuthoringAccess; version: string } {
  let buf: Buffer
  try {
    buf = readFileSync(accessFile())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { access: defaultAuthoringAccess(), version: ABSENT_VERSION }
    }
    throw err
  }
  const access = parseAuthoringAccess(JSON.parse(buf.toString('utf8')) as Record<string, unknown>)
  return { access, version: versionOf(buf) }
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
  ctx: { token: string; hostname: string; boundPort: number; handoff: HandoffState },
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
    if (req.method === 'GET' && url.pathname === '/api/handoff') return handleHandoffStatus(ctx.handoff)
    if (req.method === 'POST' && url.pathname === '/api/handoff') return handleHandoffRequest(req, ctx.handoff)
    return errorResponse(404, 'not_found')
  } catch {
    return errorResponse(500, 'internal_error')
  }
}

/** GET /api/config → the current config plus everything the web UI needs to render without
 *  ever holding a secret: per-platform guidance, boolean token presence, the resolved
 *  (read-only) permission profile per channel-member, the ledger backend, and a version. */
function handleReadConfig(): Response {
  const { access, version } = readConfigWithVersion()
  return jsonResponse({
    access,
    platforms: PLATFORM_GUIDE,
    runtimes: RUNTIMES,
    presets: PRESET_HINTS,
    defaultPreset: DEFAULT_PRESET,
    cwd: process.cwd(),
    tokens: tokenStatus(access),
    resolvedPermissions: resolvedPermissionsFor(access),
    ledger: readSettings().ledger ?? null,
    version,
  })
}

/** Names of env vars currently set (non-empty) in the state-dir `.env` OR the process env.
 *  Returns PRESENCE ONLY — the values never leave this function (R: never expose secrets).
 *  Read fresh each call so a token the user just added shows as present immediately. */
function envNamesSet(): Set<string> {
  const set = new Set<string>()
  try {
    for (const line of readFileSync(join(stateDir(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[2] !== '') set.add(m[1]!)
    }
  } catch {}
  for (const [k, v] of Object.entries(process.env)) if (v) set.add(k)
  return set
}

/** `{ [envVar]: boolean }` for every bot's primary token + extra secrets. Boolean only. */
function tokenStatus(access: AuthoringAccess): Record<string, boolean> {
  const present = envNamesSet()
  const out: Record<string, boolean> = {}
  for (const bot of Object.values(access.bots)) {
    out[bot.tokenEnv] = present.has(bot.tokenEnv)
    for (const env of Object.values(bot.secretEnv ?? {})) out[env] = present.has(env)
  }
  return out
}

/** The effective (read-only) allow/ask/deny per channel→bot, resolved exactly as the runtime
 *  would (preset expansion + deny floor) so the web shows the real enforced profile. */
function resolvedPermissionsFor(
  access: AuthoringAccess,
): Record<string, Record<string, { preset?: string } & PermissionProfile>> {
  const out: Record<string, Record<string, { preset?: string } & PermissionProfile>> = {}
  for (const [ck, ch] of Object.entries(access.channels)) {
    const byBot: Record<string, { preset?: string } & PermissionProfile> = {}
    for (const m of ch.members) {
      const eff: PermissionProfile = m.profile
        ? resolveRoomProfile(m.profile)
        : m.preset
          ? expandPreset(m.preset)
          : resolveRoomProfile(undefined)
      byBot[m.bot] = { ...(m.preset ? { preset: m.preset } : {}), allow: eff.allow, ask: eff.ask, deny: eff.deny }
    }
    out[ck] = byBot
  }
  return out
}

// ─── Handoff bridge (web asks the launching terminal to run a sensitive flow) ──────
type HandoffState = {
  state: 'idle' | 'running' | 'done' | 'error'
  action?: string
  error?: string
  runner?: HandoffRunner
}

/** GET /api/handoff → current single-flight state (so the page can poll for completion). */
function handleHandoffStatus(handoff: HandoffState): Response {
  return jsonResponse({
    state: handoff.state,
    action: handoff.action ?? null,
    error: handoff.error ?? null,
    supported: !!handoff.runner,
  })
}

/** POST /api/handoff → validate the request against the live config, then run it in the
 *  terminal. No secret/permission data crosses the wire — only WHICH flow to open. */
async function handleHandoffRequest(req: Request, handoff: HandoffState): Promise<Response> {
  if (!handoff.runner) return errorResponse(503, 'handoff_unavailable')
  if (handoff.state === 'running') return errorResponse(409, 'handoff_busy')
  let body: { action?: unknown; bot?: unknown }
  try {
    body = (await readJsonBody(req)) as { action?: unknown; bot?: unknown }
  } catch (e) {
    return errorResponse((e as Error).message === 'BODY_TOO_LARGE' ? 413 : 400, 'bad_request')
  }
  let request: HandoffRequest
  if (body.action === 'start-relay') {
    request = { action: 'start-relay' }
  } else if (body.action === 'set-token' || body.action === 'edit-permissions') {
    const { access } = readConfigWithVersion()
    const bot = typeof body.bot === 'string' ? body.bot : ''
    if (!access.bots[bot]) return errorResponse(400, 'bad_request')
    request = { action: body.action, bot }
  } else {
    return errorResponse(400, 'bad_request')
  }
  handoff.state = 'running'
  handoff.action = request.action
  delete handoff.error
  // Run in the background; the page polls GET /api/handoff for the outcome. Capture the
  // rejection reason so the page can show why a handoff failed instead of a bare "error".
  handoff
    .runner(request)
    .then(() => { handoff.state = 'done' })
    .catch(e => { handoff.state = 'error'; handoff.error = String((e as Error)?.message ?? e) })
  return jsonResponse({ state: 'running', action: request.action })
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
  // Version is the content hash of the bytes we just wrote — identical to what a re-read would
  // produce, so we skip the second disk read.
  return jsonResponse({ version: versionOf(serializeAuthoringAccess(next)) })
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
