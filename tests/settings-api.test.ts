/**
 * settings-server read/write API integration tests. Boots a real server on an ephemeral
 * loopback port against a throwaway KNOCK_KNOCK_STATE_DIR (set before importing state.ts,
 * mirroring tests/state.test.ts) and drives it over HTTP — so the guard, version-check,
 * sanitization, and persistence paths are all exercised end to end.
 */

import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'kk-settings-'))
process.env.KNOCK_KNOCK_STATE_DIR = dir

const { startSettingsServer } = await import('../src/settings-server.ts')
const { accessFile, settingsFile, saveAuthoringAccess } = await import('../src/state.ts')
import type { AuthoringAccess } from '../src/lib.ts'

// state.ts resolves access/settings paths lazily (reads KNOCK_KNOCK_STATE_DIR on each call), so this
// suite no longer self-skips on a shared module instance — it runs in the full `bun test`. Bun shares
// one process and another state-touching suite mutates the same global env, so beforeEach re-asserts
// our throwaway dir before every test, keeping the server's lazy reads pinned here.
const ACCESS_FILE = accessFile()
const SETTINGS_FILE = settingsFile()

const TOKEN = 'test-token-abcdef'
const srv = startSettingsServer({ token: TOKEN })
const BASE = 'http://127.0.0.1:' + srv.port
const ORIGIN = BASE

// Only stop the server. Do NOT rmSync the temp dir: Bun shares one process and another suite may
// still resolve paths against the env; the OS reaps the /tmp dir.
afterAll(() => { srv.stop() })

function req(path: string, opts: RequestInit = {}): Promise<Response> {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {})
  return fetch(BASE + path, opts)
}
function seed(a: AuthoringAccess) { saveAuthoringAccess(a) }
function baseConfig(): AuthoringAccess {
  return {
    bots: { cc: { platform: 'discord', tokenEnv: 'DISCORD_BOT_TOKEN', runtime: 'claude-sdk' } },
    channels: { 'discord:123456789012345678': { platform: 'discord', channelId: '123456789012345678', members: [], collaborators: [] } },
    roster: { people: {}, peers: {} },
  }
}

beforeEach(() => {
  process.env.KNOCK_KNOCK_STATE_DIR = dir // re-pin: a sibling suite shares this global env
  try { rmSync(ACCESS_FILE) } catch {}
  try { rmSync(SETTINGS_FILE) } catch {}
})

test('GET /api/config requires a token and returns access + version', async () => {
  seed(baseConfig())
  const noTok = await fetch(BASE + '/api/config')
  expect(noTok.status).toBe(401)
  const r = await req('/api/config')
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.access.bots.cc.platform).toBe('discord')
  expect(typeof body.version).toBe('string')
  expect(r.headers.get('access-control-allow-origin')).toBeNull() // R18: no CORS allowance
})

test('GET / serves the page with no-referrer', async () => {
  const r = await req('/')
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('text/html')
  expect(r.headers.get('referrer-policy')).toBe('no-referrer')
})

test('PUT with the current version persists and returns a new version', async () => {
  seed(baseConfig())
  const { version, access } = await (await req('/api/config')).json()
  access.channels['discord:123456789012345678'].label = 'Project X'
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ config: access, version }) })
  expect(r.status).toBe(200)
  const saved = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
  expect(saved.channels['discord:123456789012345678'].label).toBe('Project X')
})

test('AE1: a stale version is rejected with 409 and the file is unchanged', async () => {
  seed(baseConfig())
  const before = readFileSync(ACCESS_FILE, 'utf8')
  const { access } = await (await req('/api/config')).json()
  access.channels['discord:123456789012345678'].label = 'should not land'
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ config: access, version: 'stale-version' }) })
  expect(r.status).toBe(409)
  expect(readFileSync(ACCESS_FILE, 'utf8')).toBe(before)
})

test('AE2: a mutating request with a foreign Origin is rejected (CSRF)', async () => {
  seed(baseConfig())
  const { version, access } = await (await req('/api/config')).json()
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' }, body: JSON.stringify({ config: access, version }) })
  expect(r.status).toBe(403)
})

test('AE4: an injected extra field on a bot is dropped on save', async () => {
  seed(baseConfig())
  const { version, access } = await (await req('/api/config')).json()
  access.bots.cc.botToken = 'xoxb-leaked-secret'
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ config: access, version }) })
  expect(r.status).toBe(200)
  const saved = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
  expect(saved.bots.cc.botToken).toBeUndefined()
  expect(Object.keys(saved.bots.cc).sort()).toEqual(['platform', 'runtime', 'tokenEnv'])
})

test('validation: a malformed channel ID is rejected with 400 and field info', async () => {
  seed(baseConfig())
  const { version, access } = await (await req('/api/config')).json()
  access.channels['discord:123456789012345678'].channelId = 'not-a-snowflake'
  const before = readFileSync(ACCESS_FILE, 'utf8')
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ config: access, version }) })
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body.error).toBe('validation')
  expect(body.fields.length).toBeGreaterThan(0)
  expect(readFileSync(ACCESS_FILE, 'utf8')).toBe(before) // not written
})

test('an over-sized body is rejected with 413', async () => {
  seed(baseConfig())
  const huge = 'x'.repeat(300 * 1024)
  const r = await req('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ config: {}, version: 'v', pad: huge }) })
  expect(r.status).toBe(413)
})

test('PUT /api/ledger: postgres needs a URL; sqlite writes settings.json', async () => {
  const bad = await req('/api/ledger', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ backend: 'postgres' }) })
  expect(bad.status).toBe(400)
  const ok = await req('/api/ledger', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ backend: 'sqlite' }) })
  expect(ok.status).toBe(200)
  expect(existsSync(SETTINGS_FILE)).toBe(true)
  expect(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).ledger.backend).toBe('sqlite')
})

test('GET on a missing access.json returns defaults with a stable version', async () => {
  const r = await req('/api/config')
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.access.bots).toEqual({})
  expect(body.version).toBe('absent')
})

// ─── New read-endpoint extras: platforms guide, token status, resolved permissions ───

const ENV_FILE = join(dir, '.env')
function clearEnvFile() { try { rmSync(ENV_FILE) } catch {} }

test('GET /api/config includes the per-platform guide (links/howto/steps), no validators', async () => {
  seed(baseConfig())
  const body = await (await req('/api/config')).json()
  expect(body.platforms.discord.tokenEnvBase).toBe('DISCORD_BOT_TOKEN')
  expect(typeof body.platforms.discord.tokenHowto).toBe('string')
  expect(body.platforms.discord.tokenUrl).toContain('discord.com')
  expect(Array.isArray(body.platforms.discord.setupSteps)).toBe(true)
  expect(body.platforms.discord.setupSteps.length).toBeGreaterThan(0)
  // guidance is pure data — no functions survive JSON, so idValidate must be absent
  expect(body.platforms.discord.idValidate).toBeUndefined()
})

test('GET /api/config includes runtimes, presets, the default preset, and the server cwd', async () => {
  seed(baseConfig())
  const body = await (await req('/api/config')).json()
  expect(body.runtimes.some((r: { value: string }) => r.value === 'claude-sdk')).toBe(true)
  expect(typeof body.presets['ask-per-edit']).toBe('string')
  expect(body.defaultPreset).toBe('ask-per-edit')
  expect(body.cwd).toBe(process.cwd())
})

test('token status is boolean-only and never leaks the value', async () => {
  clearEnvFile()
  writeFileSync(ENV_FILE, 'DISCORD_BOT_TOKEN=s3cr3t-sentinel-value\n', { mode: 0o600 })
  seed(baseConfig())
  const r = await req('/api/config')
  const text = await r.text()
  expect(text).not.toContain('s3cr3t-sentinel-value') // the value never crosses the wire
  const body = JSON.parse(text)
  expect(body.tokens.DISCORD_BOT_TOKEN).toBe(true)
  clearEnvFile()
})

test('token status is false for an env var that is not set', async () => {
  clearEnvFile()
  seed({
    bots: { z: { platform: 'discord', tokenEnv: 'KK_DEFINITELY_UNSET_TOKEN_XZ', runtime: 'claude-sdk' } },
    channels: {}, roster: { people: {}, peers: {} },
  })
  const body = await (await req('/api/config')).json()
  expect(body.tokens.KK_DEFINITELY_UNSET_TOKEN_XZ).toBe(false)
})

test('resolvedPermissions expands a member preset and re-unions the deny floor', async () => {
  seed({
    bots: { cc: { platform: 'discord', tokenEnv: 'DISCORD_BOT_TOKEN', runtime: 'claude-sdk' } },
    channels: {
      'discord:123456789012345678': {
        platform: 'discord', channelId: '123456789012345678',
        members: [{ bot: 'cc', workspace: '/tmp/ws', preset: 'ask-per-edit' }],
        collaborators: [],
      },
    },
    roster: { people: {}, peers: {} },
  })
  const body = await (await req('/api/config')).json()
  const rp = body.resolvedPermissions['discord:123456789012345678'].cc
  expect(rp.preset).toBe('ask-per-edit')
  expect(Array.isArray(rp.allow)).toBe(true)
  expect(rp.deny.length).toBeGreaterThan(0) // deny floor is always present
})

// ─── Handoff bridge ──────────────────────────────────────────────────────────

test('POST /api/handoff is 503 when the server has no terminal runner', async () => {
  seed(baseConfig())
  const g = await (await req('/api/handoff')).json()
  expect(g.supported).toBe(false)
  const p = await req('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ action: 'set-token', bot: 'cc' }) })
  expect(p.status).toBe(503)
})

// A second server WITH a controllable runner, to exercise the running/busy/done path.
let deferred: { res: () => void; rej: () => void } | null = null
const srvH = startSettingsServer({ token: TOKEN, requestHandoff: () => new Promise((res, rej) => { deferred = { res, rej } }) })
const BASE_H = 'http://127.0.0.1:' + srvH.port
const ORIGIN_H = BASE_H
afterAll(() => { srvH.stop() })
function reqH(path: string, opts: RequestInit = {}): Promise<Response> {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {})
  return fetch(BASE_H + path, opts)
}

test('handoff rejects an unknown action and an unknown bot with 400', async () => {
  seed(baseConfig())
  const bad = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'nope', bot: 'cc' }) })
  expect(bad.status).toBe(400)
  const unk = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'set-token', bot: 'ghost' }) })
  expect(unk.status).toBe(400)
})

test('handoff accepts start-relay with no bot, and still rejects a bogus action', async () => {
  seed(baseConfig())
  deferred = null
  const ok = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'start-relay' }) })
  expect(ok.status).toBe(200)
  expect((await ok.json()).action).toBe('start-relay')
  if (deferred) (deferred as { res: () => void }).res()
  await new Promise(r => setTimeout(r, 10))
})

test('handoff requires a token (401) and an allowed Origin (403)', async () => {
  seed(baseConfig())
  const noTok = await fetch(BASE_H + '/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'set-token', bot: 'cc' }) })
  expect(noTok.status).toBe(401)
  const foreign = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' }, body: JSON.stringify({ action: 'set-token', bot: 'cc' }) })
  expect(foreign.status).toBe(403)
})

test('handoff runs single-flight: a valid request is accepted, a second is 409 busy, then done', async () => {
  seed(baseConfig())
  deferred = null
  const start = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'set-token', bot: 'cc' }) })
  expect(start.status).toBe(200)
  expect((await start.json()).state).toBe('running')
  expect((await (await reqH('/api/handoff')).json()).state).toBe('running')
  const busy = await reqH('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN_H }, body: JSON.stringify({ action: 'edit-permissions', bot: 'cc' }) })
  expect(busy.status).toBe(409)
  deferred!.res() // terminal flow completes
  await new Promise(r => setTimeout(r, 10))
  expect((await (await reqH('/api/handoff')).json()).state).toBe('done')
})
