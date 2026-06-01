/**
 * parseProfile: a room permission profile must be honored whether it's written
 * flat or wrapped in a Claude-Code-style `{ "permissions": {…} }` block. A
 * silently-empty profile drops the deny floor, so both shapes must parse.
 */

import { test, expect } from 'bun:test'
import { parseProfile } from './state.ts'

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
