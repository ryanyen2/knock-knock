/**
 * Telegram `mentionUser` → a `text_mention` entity that pings a numeric id without a
 * @username (Telegram has no `<@id>` markup and we send without parse_mode). The retry
 * path matters: a send that returns undefined would auto-DENY an approval, so a mention
 * Telegram can't resolve must fall back to posting the prompt without the ping.
 */

import { test, expect } from 'bun:test'
import { TelegramMessagingAdapter } from '../src/adapters-msg/telegram.ts'

type SendCall = { chatId: string; text: string; other: any }

function adapterWith(sendMessage: (...a: any[]) => Promise<any>) {
  const calls: SendCall[] = []
  const adapter = new TelegramMessagingAdapter()
  ;(adapter as any).bot = {
    api: {
      sendMessage: async (chatId: string, text: string, other: any) => {
        calls.push({ chatId, text, other })
        return sendMessage(chatId, text, other)
      },
    },
  }
  return { adapter, calls }
}

test('send with mentionUser attaches a text_mention entity for that id', async () => {
  const { adapter, calls } = adapterWith(async () => ({ message_id: 7 }))
  const ref = await adapter.send('123', 'Permission request', { mentionUser: '456' })

  expect(ref).toMatchObject({ id: '7', scope: '123' })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.text.startsWith('owner ')).toBe(true)
  expect(calls[0]!.other.entities).toEqual([
    { type: 'text_mention', offset: 0, length: 5, user: { id: 456, is_bot: false, first_name: 'owner' } },
  ])
})

test('send retries without the entity when the mention send throws (never auto-denies)', async () => {
  let n = 0
  const { adapter, calls } = adapterWith(async (_c, _t, other) => {
    n++
    if (other?.entities) throw new Error('Bad Request: user not found')
    return { message_id: 9 }
  })
  const ref = await adapter.send('123', 'Permission request', { mentionUser: '456' })

  expect(ref).toMatchObject({ id: '9', scope: '123' })
  expect(n).toBe(2)
  expect(calls[1]!.other.entities).toBeUndefined()
})

test('send without mentionUser carries no entities', async () => {
  const { adapter, calls } = adapterWith(async () => ({ message_id: 1 }))
  await adapter.send('123', 'hello')
  expect(calls[0]!.other.entities).toBeUndefined()
  expect(calls[0]!.text).toBe('hello')
})
