/**
 * parseProfile: a room permission profile must be honored whether it's written
 * flat or wrapped in a Claude-Code-style `{ "permissions": {…} }` block. A
 * silently-empty profile drops the deny floor, so both shapes must parse.
 */

import { test, expect } from 'bun:test'
import { parseProfile, parseSettings } from './state.ts'

test('parseProfile: flat shape', () => {
  expect(parseProfile('{"allow":["Read(**)"],"ask":["Bash(*)"],"deny":["Bash(sudo *)"]}')).toEqual({
    allow: ['Read(**)'],
    ask: ['Bash(*)'],
    deny: ['Bash(sudo *)'],
  })
})

test('parseProfile: { permissions: {…} } wrapper (Claude Code shape)', () => {
  const raw = JSON.stringify({ permissions: { allow: ['Edit(**)'], ask: ['Bash(*)'], deny: [] } })
  expect(parseProfile(raw)).toEqual({ allow: ['Edit(**)'], ask: ['Bash(*)'], deny: [] })
})

test('parseProfile: missing tiers default to empty arrays, not undefined', () => {
  expect(parseProfile('{"allow":["Read(**)"]}')).toEqual({ allow: ['Read(**)'], ask: [], deny: [] })
})

test('parseProfile: non-array tiers are ignored', () => {
  expect(parseProfile('{"allow":"Read(**)","deny":null}')).toEqual({ allow: [], ask: [], deny: [] })
})

test('parseProfile: no per-actor tiers key → tiers omitted entirely', () => {
  expect(parseProfile('{"allow":["Read(**)"]}')).not.toHaveProperty('tiers')
})

test('parseProfile: well-formed per-actor tiers are parsed', () => {
  const raw = JSON.stringify({
    allow: ['Read(**)'],
    ask: [],
    deny: ['Bash(sudo *)'],
    tiers: {
      agent: { allow: ['Read(**)'], deny: ['Edit(**)'] },
      'peer:bot1': { allow: ['Read(**)', 'Edit(**)'] },
    },
  })
  expect(parseProfile(raw).tiers).toEqual({
    agent: { allow: ['Read(**)'], deny: ['Edit(**)'] },
    'peer:bot1': { allow: ['Read(**)', 'Edit(**)'] },
  })
})

test('parseProfile: malformed tier entries are dropped', () => {
  const raw = JSON.stringify({ allow: [], tiers: { agent: 'nope', human: { allow: ['Read(**)'] }, peer: {} } })
  expect(parseProfile(raw).tiers).toEqual({ human: { allow: ['Read(**)'] } })
})

// ─── parseSettings ─────────────────────────────────────────────────────────────

test('parseSettings: empty object → empty settings', () => {
  expect(parseSettings('{}')).toEqual({})
})

test('parseSettings: postgres backend with url', () => {
  const raw = JSON.stringify({ ledger: { backend: 'postgres', url: 'postgres://x@y/db' } })
  expect(parseSettings(raw)).toEqual({ ledger: { backend: 'postgres', url: 'postgres://x@y/db' } })
})

test('parseSettings: sqlite backend, url dropped when absent', () => {
  expect(parseSettings('{"ledger":{"backend":"sqlite"}}')).toEqual({ ledger: { backend: 'sqlite' } })
})

test('parseSettings: unknown backend is dropped (no partial ledger)', () => {
  expect(parseSettings('{"ledger":{"backend":"mysql","url":"x"}}')).toEqual({})
})

test('parseSettings: empty url is not carried', () => {
  expect(parseSettings('{"ledger":{"backend":"postgres","url":""}}')).toEqual({
    ledger: { backend: 'postgres' },
  })
})

test('parseSettings: presets object passes through; array is rejected', () => {
  const presets = { strict: { allow: ['Read(**)'], ask: [], deny: ['Bash(*)'] } }
  expect(parseSettings(JSON.stringify({ presets }))).toEqual({ presets })
  expect(parseSettings('{"presets":[]}')).toEqual({})
})
