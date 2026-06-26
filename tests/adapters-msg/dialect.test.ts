/**
 * Pure tests for the Discord→platform dialect translators. The render layer speaks
 * one (Discord-flavored) dialect; each adapter translates every gap so the
 * Workbench, cards, and replies render natively instead of leaking `**`/`-#`.
 */

import { test, expect } from 'bun:test'
import {
  toSlackMrkdwn,
  toTelegramText,
  toGitHubMarkdown,
  toNotionRichText,
} from '../../src/adapters-msg/dialect.ts'

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

// ─── Telegram (clean plaintext) ───────────────────────────────────────────────

test('telegram: all emphasis markers are unwrapped to bare text', () => {
  expect(toTelegramText('**bold** and *italic* and ~~gone~~ and _u_')).toBe(
    'bold and italic and gone and u',
  )
  expect(toTelegramText('__also bold__')).toBe('also bold')
})

test('telegram: -# subtext and headings strip to plain, links become text (url)', () => {
  expect(toTelegramText('-# updated 03:43')).toBe('updated 03:43')
  expect(toTelegramText('## Heading')).toBe('Heading')
  expect(toTelegramText('see [docs](https://x.io/a)')).toBe('see docs (https://x.io/a)')
})

test('telegram: <@id> mention becomes @id, code keeps inner content only', () => {
  expect(toTelegramText('hi <@U123ABC>')).toBe('hi @U123ABC')
  expect(toTelegramText('run `rm -rf **x**`')).toBe('run rm -rf **x**')
})

test('telegram: arithmetic asterisks survive', () => {
  expect(toTelegramText('2 * 3 * 4')).toBe('2 * 3 * 4')
})

// ─── GitHub (GitHub-flavored markdown) ────────────────────────────────────────

test('github: keeps bold/headings/links, strips only -# and angle mentions', () => {
  expect(toGitHubMarkdown('**bold** stays')).toBe('**bold** stays')
  expect(toGitHubMarkdown('## Heading stays')).toBe('## Heading stays')
  expect(toGitHubMarkdown('-# traced from @octocat')).toBe('traced from @octocat')
  expect(toGitHubMarkdown('owner <@octocat> decides')).toBe('owner @octocat decides')
})

test('github: code spans are untouched', () => {
  expect(toGitHubMarkdown('use `-# literal` here')).toBe('use `-# literal` here')
})

// ─── Notion (structured rich_text nodes) ──────────────────────────────────────

test('notion: bold/italic/code become annotated nodes', () => {
  const nodes = toNotionRichText('a **b** c `d` e')
  expect(nodes).toEqual([
    { type: 'text', text: { content: 'a ' } },
    { type: 'text', text: { content: 'b' }, annotations: { bold: true } },
    { type: 'text', text: { content: ' c ' } },
    { type: 'text', text: { content: 'd' }, annotations: { code: true } },
    { type: 'text', text: { content: ' e' } },
  ])
})

test('notion: links become a link node, headings bold, -# stripped', () => {
  expect(toNotionRichText('[docs](https://x.io)')).toEqual([
    { type: 'text', text: { content: 'docs', link: { url: 'https://x.io' } } },
  ])
  expect(toNotionRichText('# Title')).toEqual([
    { type: 'text', text: { content: 'Title' }, annotations: { bold: true } },
  ])
  expect(toNotionRichText('-# small')).toEqual([{ type: 'text', text: { content: 'small' } }])
})

test('notion: plain text yields a single node; empty yields one empty node', () => {
  expect(toNotionRichText('just text')).toEqual([{ type: 'text', text: { content: 'just text' } }])
  expect(toNotionRichText('')).toEqual([{ type: 'text', text: { content: '' } }])
})

test('notion: a long plain run splits at the 2000-char node ceiling', () => {
  const nodes = toNotionRichText('x'.repeat(4500))
  expect(nodes.map(n => n.text.content.length)).toEqual([2000, 2000, 500])
})
