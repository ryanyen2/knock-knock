/**
 * Telegram has no `allowedMentions`-style suppression: it parses `@handle` mentions
 * straight from message text. A bot-authored status surface echoes the prompt verbatim,
 * so without neutralization those `@handle`s stay live and re-ping the named bots (the
 * cross-machine status cascade). `defangMentions` is how the adapter honors
 * `SendOpts.suppressMentions` — it breaks the mention so it no longer pings or matches a
 * peer's inbound `text.includes('@handle')` check, while staying visually identical.
 */

import { test, expect } from 'bun:test'
import { defangMentions } from '../../src/adapters-msg/telegram.ts'

const JOINER = /⁠/g

test('defangMentions: a handle no longer matches a literal text.includes check', () => {
  const out = defangMentions('<@KnockKnockTestBot> — go ahead, then @tele_35_bot refine')
  expect(out.includes('@tele_35_bot')).toBe(false)
  expect(out.includes('@KnockKnockTestBot')).toBe(false)
})

test('defangMentions: the inserted joiner is zero-width, so the text reads the same', () => {
  const out = defangMentions('@tele_35_bot refine')
  expect(out.replace(JOINER, '')).toBe('@tele_35_bot refine')
})

test('defangMentions: text with no mentions is returned unchanged', () => {
  expect(defangMentions('knock-knock is a Claude Code plugin')).toBe(
    'knock-knock is a Claude Code plugin',
  )
})
