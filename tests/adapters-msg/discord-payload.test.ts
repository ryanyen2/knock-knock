/**
 * buildPayload mention-suppression: bot-authored status surfaces (Workbench,
 * billboard) echo the prompt text verbatim, which contains live `<@id>` markup.
 * Without suppression Discord re-parses those as real pings, re-triggering the
 * mentioned bots — the cascade of threads + round-trips. The fix carries
 * allowedMentions:{parse:[]} on those sends so the echoed markup never pings.
 */

import { test, expect } from 'bun:test'
import { DiscordMessagingAdapter } from '../../src/adapters-msg/discord.ts'

// buildPayload uses only its args (no live client), so we can call it on a bare
// instance via a structural cast — no connect() / gateway needed.
const payloadOf = (text: string, opts?: object) =>
  (new DiscordMessagingAdapter() as unknown as {
    buildPayload(t: string, o?: object): { content: string; allowedMentions?: { parse: string[]; users?: string[] } }
  }).buildPayload(text, opts)

test('buildPayload: suppressMentions sets allowedMentions:{parse:[]} so echoed <@id> never pings', () => {
  const p = payloadOf('**Workbench**\n▸ cc — <@123456> summarize this', { suppressMentions: true })
  expect(p.content).toContain('<@123456>') // text is unchanged — only pinging is suppressed
  expect(p.allowedMentions).toEqual({ parse: [] })
})

test('buildPayload: a normal send still pings (directed handoff @next-bot must work)', () => {
  const p = payloadOf('over to you <@123456>')
  expect(p.allowedMentions).toBeUndefined()
})

test('buildPayload: mentionOnly pings just the approver, suppressing other <@id> in the body', () => {
  // An approval prompt's tool-input preview can contain <@id> markup; only the approver
  // should be pinged, never a peer bot named in the preview.
  const p = payloadOf('🔐 Permission request for <@999>', { mentionOnly: 'U_owner' })
  expect(p.allowedMentions).toEqual({ parse: [], users: ['U_owner'] })
})
