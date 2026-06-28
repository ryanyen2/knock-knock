/**
 * Slack peer-bot admission: the adapter must surface bot-authored messages that carry a
 * `user` id (a peer agent's handoff / mesh line) so other bots can hear them. It drops only
 * unattributable bot posts. Self-filtering + allowlisting stay the host's job.
 */

import { test, expect } from 'bun:test'
import { SlackMessagingAdapter } from '../../src/adapters-msg/slack.ts'
import type { IncomingMessage } from '../../src/messaging-adapter.ts'

/** Build an adapter with a stubbed Web client capturing files.uploadV2 / chat.postMessage. */
function sendHarness() {
  const calls: { uploadV2: any[]; postMessage: any[] } = { uploadV2: [], postMessage: [] }
  const adapter = new SlackMessagingAdapter() as any
  adapter.web = {
    files: {
      uploadV2: async (args: any) => {
        calls.uploadV2.push(args)
        return { ok: true, files: [{ ok: true, files: [{ id: 'F123' }] }] }
      },
    },
    chat: {
      postMessage: async (args: any) => {
        calls.postMessage.push(args)
        return { ts: '111.222' }
      },
    },
  }
  return { adapter: adapter as SlackMessagingAdapter, calls }
}

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

test('capabilities: outbound files are supported', () => {
  const adapter = new SlackMessagingAdapter()
  expect(adapter.capabilities().files?.outbound).toBe(true)
})

test('send with files: uploads via uploadV2 with the caption as initial_comment', async () => {
  const { adapter, calls } = sendHarness()
  const ref = await adapter.send('C1', '<@U_bench> updated solver.py — run the benchmark', {
    files: [{ name: 'solver.py', data: new Uint8Array([1, 2, 3]) }],
  })
  expect(calls.uploadV2).toHaveLength(1)
  expect(calls.postMessage).toHaveLength(0) // file path, not a plain post
  const up = calls.uploadV2[0]
  expect(up.channel_id).toBe('C1')
  expect(up.initial_comment).toContain('<@U_bench>') // the peer mention rides with the file
  expect(up.file_uploads[0].filename).toBe('solver.py')
  expect(Buffer.isBuffer(up.file_uploads[0].file)).toBe(true)
  expect(ref?.id).toBe('F123')
})

test('send into a thread scope: file upload carries thread_ts', async () => {
  const { adapter, calls } = sendHarness()
  await adapter.send('C1:1700.5', 'shared `report.pdf`', {
    files: [{ name: 'report.pdf', data: new Uint8Array([0x25, 0x50]) }],
  })
  expect(calls.uploadV2[0].thread_ts).toBe('1700.5')
})

test('send without files: still uses chat.postMessage', async () => {
  const { adapter, calls } = sendHarness()
  await adapter.send('C1', 'just text')
  expect(calls.postMessage).toHaveLength(1)
  expect(calls.uploadV2).toHaveLength(0)
})
