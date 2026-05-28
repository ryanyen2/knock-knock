/**
 * Synchronizer engine: matching, firing, wave-cap, error isolation.
 *
 * The engine is what makes rubric #2 (Independence) concrete — adding a
 * new behavior is one new synchronization registered here, zero edits to
 * existing concepts. These tests describe the contract.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { FoldEngine } from './fold.ts'
import { Synchronizer, type Synchronization } from './sync.ts'
import { admit } from './admit.ts'
import type { ProposedInteraction } from './interaction.ts'

function setup() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  return { store, engine }
}

function proposal(overrides: Partial<ProposedInteraction> = {}): ProposedInteraction {
  return {
    actor: 'a',
    role: 'agent',
    channel: 'c',
    target: { artifactId: 'extp:x', anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [],
    ...overrides,
  }
}

test('sync: matches=true → fire is called with the new interaction', async () => {
  const { store, engine } = setup()
  const seen: string[] = []
  const sync = new Synchronizer(store, engine)
  sync.register({
    name: 'see-channel-messages',
    matches: i => i.verb === 'channel.message',
    fire: async i => {
      seen.push(i.hash)
    },
  })
  sync.start()

  const r = await admit(store, proposal({ actor: 'a' }))
  // Synchronizations are async; let the microtask queue drain.
  await new Promise(r => setTimeout(r, 10))
  expect(seen).toEqual([r.interaction.hash])
  sync.stop()
  engine.close()
  store.close()
})

test('sync: matches=false → fire is never called', async () => {
  const { store, engine } = setup()
  let fired = false
  const sync = new Synchronizer(store, engine)
  sync.register({
    name: 'never',
    matches: () => false,
    fire: async () => {
      fired = true
    },
  })
  sync.start()
  await admit(store, proposal())
  await new Promise(r => setTimeout(r, 10))
  expect(fired).toBe(false)
  sync.stop()
  engine.close()
  store.close()
})

test('sync: a synchronization that admits triggers further synchronization waves', async () => {
  const { store, engine } = setup()
  const sync = new Synchronizer(store, engine)
  const seen: string[] = []
  // First sync: on tool.requested, admit a tool.classified.
  sync.register({
    name: 'classify',
    matches: i => i.verb === 'tool.requested',
    fire: async (i, ctx) => {
      await ctx.admit({
        actor: 'policy',
        role: 'owner',
        channel: i.channel,
        target: { artifactId: 'extp:tool/x', anchor: { kind: 'none' } },
        verb: 'tool.classified',
        patch: {
          kind: 'external',
          intent: { channel: 'tool', op: 'classified', args: { verdict: 'allow' } },
        },
        effect: 'pure',
        caused_by: [i.hash],
      })
    },
  })
  // Second sync: observe the produced classification.
  sync.register({
    name: 'see-classifications',
    matches: i => i.verb === 'tool.classified',
    fire: async i => {
      seen.push(i.hash)
    },
  })
  sync.start()

  await admit(store, proposal({ verb: 'tool.requested', target: { artifactId: 'extp:tool/x', anchor: { kind: 'proxy', proxyId: 'x' } } }))
  await new Promise(r => setTimeout(r, 20))
  expect(seen).toHaveLength(1)
  sync.stop()
  engine.close()
  store.close()
})

test('sync: errors in one synchronization do not block others for the same interaction', async () => {
  const { store, engine } = setup()
  const seen: string[] = []
  const sync = new Synchronizer(store, engine)
  sync.register({
    name: 'angry',
    matches: () => true,
    fire: async () => {
      throw new Error('boom')
    },
  })
  sync.register({
    name: 'observer',
    matches: () => true,
    fire: async i => {
      seen.push(i.hash)
    },
  })
  sync.start()
  const r = await admit(store, proposal())
  await new Promise(r => setTimeout(r, 10))
  expect(seen).toEqual([r.interaction.hash])
  sync.stop()
  engine.close()
  store.close()
})

test('sync: wave cap stops runaway cascades (infinite-recursion safety net)', async () => {
  const { store, engine } = setup()
  // Use a small cap so the test runs fast.
  const sync = new Synchronizer(store, engine, { waveCap: 3 })
  let cascadeDepth = 0
  sync.register({
    name: 'recursive-fire',
    matches: i => i.verb === 'channel.message',
    fire: async (i, ctx) => {
      cascadeDepth++
      // Each fire produces another channel.message — would recurse forever
      // without the cap.
      await ctx.admit({
        actor: `bot-${cascadeDepth}`,
        role: 'agent',
        channel: i.channel,
        target: { artifactId: 'extp:x', anchor: { kind: 'none' } },
        verb: 'channel.message',
        patch: {
          kind: 'external',
          intent: { channel: 'discord', op: 'received', args: { text: 'x', messageId: `m-${cascadeDepth}` } },
        },
        effect: 'external',
        caused_by: [i.hash],
      })
    },
  })
  sync.start()
  await admit(store, proposal())
  await new Promise(r => setTimeout(r, 30))
  // Initial admit (outside wave) + 3 cap'd admits = 4 fires. The 4th admit
  // is dropped; the 4th fire never happens.
  expect(cascadeDepth).toBeLessThanOrEqual(4)
  sync.stop()
  engine.close()
  store.close()
})

test('sync: registering the same name twice throws', () => {
  const { store, engine } = setup()
  const sync = new Synchronizer(store, engine)
  const s: Synchronization = {
    name: 'duplicate',
    matches: () => true,
    fire: async () => {},
  }
  sync.register(s)
  expect(() => sync.register(s)).toThrow()
  sync.stop()
  engine.close()
  store.close()
})

test('sync: stop() halts future firings', async () => {
  const { store, engine } = setup()
  const seen: string[] = []
  const sync = new Synchronizer(store, engine)
  sync.register({
    name: 'observer',
    matches: () => true,
    fire: async i => {
      seen.push(i.hash)
    },
  })
  sync.start()
  await admit(store, proposal({ actor: 'a' }))
  await new Promise(r => setTimeout(r, 10))
  sync.stop()
  await admit(store, proposal({ actor: 'b' }))
  await new Promise(r => setTimeout(r, 10))
  expect(seen).toHaveLength(1) // only the pre-stop admit
  engine.close()
  store.close()
})
