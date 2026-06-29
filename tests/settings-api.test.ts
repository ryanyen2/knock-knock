/**
 * settings-server read/write API integration tests. Boots a real server on an ephemeral
 * loopback port against a throwaway KNOCK_KNOCK_STATE_DIR (set before importing state.ts,
 * mirroring tests/state.test.ts) and drives it over HTTP — so the guard, version-check,
 * sanitization, and persistence paths are all exercised end to end.
 */

import { test as _test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'kk-settings-'))
process.env.KNOCK_KNOCK_STATE_DIR = dir

const { startSettingsServer } = await import('../src/settings-server.ts')
const { ACCESS_FILE, SETTINGS_FILE, saveAuthoringAccess } = await import('../src/state.ts')
import type { AuthoringAccess } from '../src/lib.ts'

// SAFETY GUARD: state.ts binds ACCESS_FILE from KNOCK_KNOCK_STATE_DIR at its FIRST import, and Bun
// shares one module instance across the run. If another suite imports state.ts before this file
// sets the env above, ACCESS_FILE points at the real ~/.knock-knock/access.json — and this suite's
// beforeEach rmSync + write path clobbers the operator's live config (it deleted it once). Since the
// tests write to ACCESS_FILE, guarding beforeEach alone is not enough, so SKIP the whole suite when
// the binding didn't land on our throwaway dir. It still runs in isolation
// (`bun test tests/settings-api.test.ts`); the proper fix is lazy path resolution in state.ts.
const SAFE = ACCESS_FILE.startsWith(dir)
const test = SAFE ? _test : _test.skip
if (!SAFE) {
  console.warn(
    `settings-api.test: SKIPPED — ACCESS_FILE (${ACCESS_FILE}) is not under the throwaway STATE_DIR; ` +
      'state.ts was imported before this file set KNOCK_KNOCK_STATE_DIR. Run this suite in isolation.',
  )
}

const TOKEN = 'test-token-abcdef'
const srv = startSettingsServer({ token: TOKEN })
const BASE = 'http://127.0.0.1:' + srv.port
const ORIGIN = BASE

// Only stop the server. Do NOT rmSync the temp dir: Bun shares one process and state.ts's
// module-level STATE_DIR binds to whichever test file imports it first — deleting the dir here
// would pull it out from under other state-touching suites. The OS reaps the /tmp dir.
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

beforeEach(() => { if (!SAFE) return; try { rmSync(ACCESS_FILE) } catch {} try { rmSync(SETTINGS_FILE) } catch {} })

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
