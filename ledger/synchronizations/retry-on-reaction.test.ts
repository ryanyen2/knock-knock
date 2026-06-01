/**
 * retry-on-reaction (§4.5): a turn.retry re-admits a distinct turn.prompted
 * pointing at the same inbound message.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { retryOnReaction } from './retry-on-reaction.ts'
import type { ProposedInteraction, Hash } from '../interaction.ts'

const CH = 'chan-A'
const ART = `extp:discord/${CH}`

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

function base(verb: ProposedInteraction['verb'], causedBy: Hash[], actor = 'bot1'): ProposedInteraction {
  return {
    actor,
    role: 'agent',
    channel: CH,
    target: { artifactId: ART, anchor: { kind: 'none' } },
    verb,
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: causedBy,
  }
}

test('retry-on-reaction: re-admits a fresh turn.prompted for the same inbound', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(retryOnReaction())
  sync.start()

  // Original turn: inbound channel.message → turn.prompted.
  const inbound = await admit(store, {
    ...base('channel.message', []),
    actor: 'u-alice',
    role: 'owner',
    patch: { kind: 'external', intent: { channel: 'discord', op: 'received', args: { text: 'do it' } } },
    effect: 'external',
  })
  const prompt = await admit(store, base('turn.prompted', [inbound.interaction.hash]))

  // Owner reacts 🔁 → AgentHost admits a turn.retry caused_by the prompt.
  const retry = await admit(store, {
    ...base('turn.retry', [prompt.interaction.hash]),
    actor: 'u-alice',
    role: 'owner',
  })
  await settle()

  const prompts = await store.listByVerb('turn.prompted')
  expect(prompts).toHaveLength(2)
  const fresh = prompts.find(p => p.hash !== prompt.interaction.hash)!
  expect(fresh.caused_by).toEqual([inbound.interaction.hash, retry.interaction.hash])
  // Drive-turn reads caused_by[0] as the inbound — preserved.
  expect(fresh.caused_by[0]).toBe(inbound.interaction.hash)
  sync.stop()
  engine.close()
  store.close()
})

test('retry-on-reaction: ignores a retry with no resolvable prompt', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(retryOnReaction())
  sync.start()
  await admit(store, { ...base('turn.retry', ['deadbeef']), actor: 'u', role: 'owner' })
  await settle()
  expect(await store.listByVerb('turn.prompted')).toHaveLength(0)
  sync.stop()
  engine.close()
  store.close()
})
