/**
 * Pure tests for the Discord→Slack mrkdwn translator. The render layer speaks one
 * (Discord-flavored) dialect; the Slack adapter must translate every gap so the
 * Workbench, cards, and replies render natively instead of leaking `**`/`-#`.
 */

import { test, expect } from 'bun:test'
import { toSlackMrkdwn } from '../../src/adapters-msg/slack-format.ts'

test('bold: **x** and __x__ become a single-asterisk Slack bold', () => {
  expect(toSlackMrkdwn('**Workbench**')).toBe('*Workbench*')
  expect(toSlackMrkdwn('__loud__')).toBe('*loud*')
  expect(toSlackMrkdwn('a **b c** d')).toBe('a *b c* d')
})

test('italic: single *x* becomes _x_, leaving bold alone', () => {
  expect(toSlackMrkdwn('*soft*')).toBe('_soft_')
  expect(toSlackMrkdwn('**bold** and *italic*')).toBe('*bold* and _italic_')
  // already-Slack italic is preserved
  expect(toSlackMrkdwn('_keep_')).toBe('_keep_')
})

test('italic guard: arithmetic and glob asterisks are left untouched', () => {
  expect(toSlackMrkdwn('2 * 3 * 4')).toBe('2 * 3 * 4')
  expect(toSlackMrkdwn('use src/*.ts globs')).toBe('use src/*.ts globs')
})

test('strike: ~~x~~ becomes ~x~', () => {
  expect(toSlackMrkdwn('~~gone~~')).toBe('~gone~')
})

test('links: [text](url) becomes <url|text>', () => {
  expect(toSlackMrkdwn('see [docs](https://example.com/x)')).toBe(
    'see <https://example.com/x|docs>',
  )
})

test('subtext: a leading -# marker is stripped, content kept', () => {
  expect(toSlackMrkdwn('-# updated 03:43')).toBe('updated 03:43')
  expect(toSlackMrkdwn('-#   → Read file ✓')).toBe('  → Read file ✓')
})

test('headings: # / ## / ### collapse to bold', () => {
  expect(toSlackMrkdwn('# Title')).toBe('*Title*')
  expect(toSlackMrkdwn('### Deep')).toBe('*Deep*')
})

test('bullets: "- " / "* " become "• "', () => {
  expect(toSlackMrkdwn('- one\n- two')).toBe('• one\n• two')
  expect(toSlackMrkdwn('* star')).toBe('• star')
})

test('mentions: a bare Slack user id becomes a real mention', () => {
  expect(toSlackMrkdwn("traced from @U0B7EF3NBSP's message")).toBe(
    "traced from <@U0B7EF3NBSP>'s message",
  )
  // an already-formatted mention is not double-wrapped
  expect(toSlackMrkdwn('hi <@U0B7EF3NBSP>')).toBe('hi <@U0B7EF3NBSP>')
})

test('code spans are protected from every transform', () => {
  expect(toSlackMrkdwn('run `rm -rf **x**` now')).toBe('run `rm -rf **x**` now')
  expect(toSlackMrkdwn('```\n# not a heading\n- not a bullet\n```')).toBe(
    '```\n# not a heading\n- not a bullet\n```',
  )
})

test('a realistic Workbench block translates wholesale', () => {
  const discord = [
    '**Workbench**',
    '-# ✓ assistant — codebase summary',
    '-#   → Read surface.ts ✓',
    '-# updated 03:43',
  ].join('\n')
  const slack = toSlackMrkdwn(discord)
  expect(slack).toBe(
    [
      '*Workbench*',
      '✓ assistant — codebase summary',
      '  → Read surface.ts ✓',
      'updated 03:43',
    ].join('\n'),
  )
})

test('empty input is returned untouched', () => {
  expect(toSlackMrkdwn('')).toBe('')
})
