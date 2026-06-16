/**
 * The workspace-boundary decision behind session privacy (U11). list() filters
 * on it, and importSession re-checks read()'s transcript against it (read() is
 * not workspace-filtered, so a stem collision could otherwise leak a foreign
 * session). Pure, so it's tested directly.
 */

import { test, expect } from 'bun:test'
import { cwdMatchesWorkspace, normalizeWorkspace } from './session-store.ts'

test('cwdMatchesWorkspace: exact match and descendant match', () => {
  expect(cwdMatchesWorkspace('/a/b', '/a/b')).toBe(true)
  expect(cwdMatchesWorkspace('/a/b/sub/dir', '/a/b')).toBe(true)
})

test('cwdMatchesWorkspace: a sibling prefix does NOT match', () => {
  // The trailing-slash guard prevents /a/b matching /a/bc.
  expect(cwdMatchesWorkspace('/a/bc', '/a/b')).toBe(false)
  expect(cwdMatchesWorkspace('/a/b-sibling', '/a/b')).toBe(false)
})

test('cwdMatchesWorkspace: undefined cwd never matches (degrade, never over-share)', () => {
  expect(cwdMatchesWorkspace(undefined, '/a/b')).toBe(false)
})

test('cwdMatchesWorkspace: tolerant of a trailing slash on either side', () => {
  expect(cwdMatchesWorkspace('/a/b/', '/a/b')).toBe(true)
  expect(cwdMatchesWorkspace('/a/b', '/a/b/')).toBe(true)
})

test('normalizeWorkspace: strips trailing slashes', () => {
  expect(normalizeWorkspace('/x/y/')).toBe('/x/y')
  expect(normalizeWorkspace('/x/y')).toBe('/x/y')
})
