/**
 * settings-guard.ts tests. The guard layer is a pure function, exercised here without
 * binding a port. It imports from settings-guard.ts (not settings-server.ts) precisely so it
 * does NOT pull in state.ts — keeping this suite from binding KNOCK_KNOCK_STATE_DIR. The
 * read/write API tests live in settings-api.test.ts, which sets a temp STATE_DIR first.
 */

import { test, expect } from 'bun:test'
import { guardRequest, type GuardContext } from '../src/settings-guard.ts'

const PORT = 51234
const ctx: GuardContext = {
  allowedHosts: new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]),
  allowedOrigins: new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]),
  token: 'secret-token-value',
}
const goodHost = `127.0.0.1:${PORT}`
const goodOrigin = `http://127.0.0.1:${PORT}`
const auth = `Bearer ${ctx.token}`

test('valid GET to the API with host + token is allowed (reads are token-gated, AE2)', () => {
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: auth, isApi: true }, ctx)).toEqual({ ok: true })
})

test('valid mutating request with host + origin + token is allowed', () => {
  expect(guardRequest({ method: 'PUT', host: goodHost, origin: goodOrigin, authorization: auth, isApi: true }, ctx)).toEqual({ ok: true })
})

test('foreign Host is rejected on every request (DNS rebinding, R9)', () => {
  expect(guardRequest({ method: 'GET', host: 'evil.example.com', origin: null, authorization: auth, isApi: true }, ctx)).toEqual({ ok: false, status: 403 })
  // even the static shell is host-checked
  expect(guardRequest({ method: 'GET', host: 'evil.example.com', origin: null, authorization: null, isApi: false }, ctx)).toEqual({ ok: false, status: 403 })
})

test('GET API without a token is rejected — config body is sensitive (R11)', () => {
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: null, isApi: true }, ctx)).toEqual({ ok: false, status: 401 })
})

test('the static page shell needs no token (carries no secrets)', () => {
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: null, isApi: false }, ctx)).toEqual({ ok: true })
})

test('mutating request with a foreign Origin is rejected (CSRF, R10)', () => {
  expect(guardRequest({ method: 'PUT', host: goodHost, origin: 'http://evil.example.com', authorization: auth, isApi: true }, ctx)).toEqual({ ok: false, status: 403 })
})

test('mutating request with a missing Origin is rejected', () => {
  expect(guardRequest({ method: 'PUT', host: goodHost, origin: null, authorization: auth, isApi: true }, ctx)).toEqual({ ok: false, status: 403 })
})

test('wrong token and wrong-length token are both rejected without throwing', () => {
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: 'Bearer wrong', isApi: true }, ctx)).toEqual({ ok: false, status: 401 })
  // a much longer token must not throw in timingSafeEqual (length guarded first)
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: 'Bearer ' + 'x'.repeat(999), isApi: true }, ctx)).toEqual({ ok: false, status: 401 })
})

test('raw token (no Bearer prefix) is accepted', () => {
  expect(guardRequest({ method: 'GET', host: goodHost, origin: null, authorization: ctx.token, isApi: true }, ctx)).toEqual({ ok: true })
})
