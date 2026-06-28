/**
 * Slack peer-bot admission: the adapter must surface bot-authored messages that carry a
 * `user` id (a peer agent's handoff / mesh line) so other bots can hear them. It drops only
 * unattributable bot posts. Self-filtering + allowlisting stay the host's job.
 */

import { test, expect } from 'bun:test'
import { SlackMessagingAdapter } from '../../src/adapters-msg/slack.ts'
import type { IncomingMessage } from '../../src/messaging-adapter.ts'

/** Build an adapter with a known bot user id, capturing whatever it emits. */
function harness() {
  const adapter = new SlackMessagingAdapter() as unknown as {
    _botUserId: string
    handleMessageEvent(event: unknown, isMention: boolean): void
    onMessage(h: (m: IncomingMessage) => void): void
  }
  adapter._botUserId = 'U_self'
  const seen: IncomingMessage[] = []
  adapter.onMessage(m => seen.push(m))
  return { adapter, seen }
}

test('handleMessageEvent: a peer bot message with a user id is admitted with that author', () => {
  const { adapter, seen } = harness()
  adapter.handleMessageEvent(
    { channel: 'C1', ts: '1', user: 'U_peer', bot_id: 'B_peer', text: '<@U_self> refine this' },
    false,
  )
  expect(seen).toHaveLength(1)
  expect(seen[0]!.authorId).toBe('U_peer')
  expect(seen[0]!.mentionsBot).toBe(true) // <@U_self> in the text
})

test('handleMessageEvent: a bot message with no user id is dropped (unattributable)', () => {
  const { adapter, seen } = harness()
  adapter.handleMessageEvent({ channel: 'C1', ts: '2', bot_id: 'B_x', text: 'hi' }, false)
  expect(seen).toHaveLength(0)
})

test('handleMessageEvent: a plain human message is still admitted', () => {
  const { adapter, seen } = harness()
  adapter.handleMessageEvent({ channel: 'C1', ts: '3', user: 'U_human', text: 'hello' }, false)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.authorId).toBe('U_human')
})

test('handleMessageEvent: a system subtype (channel_join) is dropped', () => {
  const { adapter, seen } = harness()
  adapter.handleMessageEvent(
    { channel: 'C1', ts: '4', user: 'U_human', subtype: 'channel_join', text: 'joined' },
    false,
  )
  expect(seen).toHaveLength(0)
})
