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
import { knowledgeFold } from '../artifacts/knowledge.ts'
import { postOnReply } from './post-on-reply.ts'
import type { ProposedInteraction, Hash } from '../interaction.ts'

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

test('post-on-reply: splits an over-long reply under Discord 2000-char limit', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'm'
      },
    }),
  )
  sync.start()
  const long = 'x'.repeat(4500)
  await admit(store, reply(long))
  await settle()

  expect(sent.length).toBeGreaterThan(1)
  for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(2000)
  expect(sent.map(s => s.text).join('')).toBe(long) // no content lost
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

// ─── §4.3 attribution line ────────────────────────────────────────────────

function channelMessage(actor: string, text: string): ProposedInteraction {
  return {
    actor,
    role: 'human',
    channel: CHANNEL,
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'external', intent: { channel: 'discord', op: 'received', args: { text } } },
    effect: 'external',
    caused_by: [],
  }
}

function prompted(causedBy: Hash[]): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CHANNEL,
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'turn.prompted',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: causedBy,
  }
}

function repliedWith(text: string, causedBy: Hash[]): ProposedInteraction {
  return { ...reply(text), caused_by: causedBy }
}

test('post-on-reply: appends the §4.3 attribution line from caused_by', async () => {
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
      resolveActorName: id => (id === 'u-alice' ? 'alice' : id),
    }),
  )
  sync.start()

  // Build the causal chain the way turn-recorder does:
  // channel.message → turn.prompted → turn.replied (+ 2 executed tools).
  const inbound = await admit(store, channelMessage('u-alice', 'fix the parser'))
  const prompt = await admit(store, prompted([inbound.interaction.hash]))
  await admit(
    store,
    repliedWith('here is the fix', [prompt.interaction.hash, 'tool-x', 'tool-y']),
  )
  await settle()

  expect(sent).toHaveLength(1)
  const text = sent[0]!.text
  expect(text).toStartWith('here is the fix')
  expect(text).toContain("-# — traced from @alice's message at")
  expect(text).toContain('· 2 tools')
  sync.stop()
  engine.close()
  store.close()
})

test('post-on-reply: no attribution when the reply has no causal parent', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'm'
      },
    }),
  )
  sync.start()
  await admit(store, reply('bare reply'))
  await settle()
  expect(sent).toEqual([{ channel: CHANNEL, text: 'bare reply' }])
  sync.stop()
  engine.close()
  store.close()
})

// ─── §4.6 stale-note flag ──────────────────────────────────────────────────

test('post-on-reply: flags a reply that rests on invalidated knowledge', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold) // production registers this in relay.ts
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'm'
      },
    }),
  )
  sync.start()

  const KNOW = 'know:actor/bot1/notes'
  const append = (id: string, body: string, causedBy: Hash[]): ProposedInteraction => ({
    actor: 'bot1',
    role: 'agent',
    channel: CHANNEL,
    target: { artifactId: KNOW, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id, body } },
    effect: 'pure',
    caused_by: causedBy,
  })

  // source note → derived note that cites it → invalidate the source.
  const source = await admit(store, append('src', 'the parser supports 8 levels', []))
  await admit(store, append('derived', 'therefore deep nesting is fine', [source.interaction.hash]))
  await admit(store, {
    actor: 'u-alice',
    role: 'owner',
    channel: CHANNEL,
    target: { artifactId: KNOW, anchor: { kind: 'none' } },
    verb: 'knowledge.invalidate',
    patch: { kind: 'knowledge', invalidate: { hash: source.interaction.hash } },
    effect: 'pure',
    caused_by: [source.interaction.hash],
  })

  await admit(store, reply('the nesting limit is 8 levels'))
  await settle()

  expect(sent).toHaveLength(1)
  const text = sent[0]!.text
  expect(text).toStartWith('the nesting limit is 8 levels')
  expect(text).toContain('⚠️')
  expect(text).toContain('invalidated')
  // both the tombstoned source and its downstream note are surfaced
  expect(text).toContain('2 invalidated notes')
  sync.stop()
  engine.close()
  store.close()
})

test('post-on-reply: no flag when the agent holds no stale knowledge', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(knowledgeFold)
  const sync = new Synchronizer(store, engine)
  const sent: Array<{ channel: string; text: string }> = []
  sync.register(
    postOnReply({
      discordSend: async (channel, text) => {
        sent.push({ channel, text })
        return 'm'
      },
    }),
  )
  sync.start()
  await admit(store, reply('all good here'))
  await settle()
  expect(sent).toEqual([{ channel: CHANNEL, text: 'all good here' }])
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
