/**
 * post-on-reply: takes the turn.replied text under a claim, sends to Discord
 * via the injected callback, releases the claim. A held claim blocks; failures
 * release.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { postOnReply } from './post-on-reply.ts'
import type { ProposedInteraction } from '../interaction.ts'

const CHANNEL = 'chan-A'
const ARTIFACT = `extp:discord/${CHANNEL}`

function reply(text: string): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CHANNEL,
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'turn.replied',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'reply', args: { text } },
    },
    effect: 'external',
    caused_by: [],
  }
}

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

test('post-on-reply: sends the turn.replied text to Discord', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'msg-1'
      },
    }),
  )
  sync.start()
  await admit(store, reply('hello world'))
  await settle()
  expect(sent).toEqual([{ channel: CHANNEL, text: 'hello world' }])
  // Claim released after send.
  expect(await store.getClaim(ARTIFACT)).toBeUndefined()
  sync.stop()
  engine.close()
  store.close()
})

test('post-on-reply: empty reply text is skipped', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'msg-1'
      },
    }),
  )
  sync.start()
  await admit(store, reply('   '))
  await settle()
  expect(sent).toEqual([])
  sync.stop()
  engine.close()
  store.close()
})

test('post-on-reply: a pre-existing claim blocks the post (logs, no throw)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  await store.acquireClaim(ARTIFACT, 'someone-else', 60_000)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'msg-1'
      },
    }),
  )
  sync.start()
  await admit(store, reply('hello'))
  await settle()
  expect(sent).toEqual([]) // never called — claim is held
  // The original claim is still there (not stolen).
  const claim = await store.getClaim(ARTIFACT)
  expect(claim?.holder).toBe('someone-else')
  sync.stop()
  engine.close()
  store.close()
})

test('post-on-reply: send-failure releases the claim (no stuck lock)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(
    postOnReply({
      discordSend: async () => {
        throw new Error('discord down')
      },
    }),
  )
  sync.start()
  await admit(store, reply('hello'))
  await settle()
  // Claim must NOT be held after the failure.
  expect(await store.getClaim(ARTIFACT)).toBeUndefined()
  sync.stop()
  engine.close()
  store.close()
})
