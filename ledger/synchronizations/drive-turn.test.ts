/**
 * drive-turn: fires on admitted turn.prompted, looks up the drive handle,
 * runs the adapter, records turn.replied.
 *
 * No real Driver/adapter here — the test injects a stub handle and asserts
 * the synchronization invokes it with the right context derived from the
 * causal chain (turn.prompted ← channel.message).
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { driveTurn, type DriveTurnHandle } from './drive-turn.ts'
import type { ProposedInteraction } from '../interaction.ts'

const CHANNEL = 'chan-A'

function inbound(): ProposedInteraction {
  return {
    actor: 'owner1',
    role: 'owner',
    channel: CHANNEL,
    target: { artifactId: `extp:discord/${CHANNEL}`, anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'received', args: { text: 'do a thing', messageId: 'm-1' } },
    },
    effect: 'external',
    caused_by: [],
  }
}

function prompted(inboundHash: string): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CHANNEL,
    target: { artifactId: `extp:discord/${CHANNEL}`, anchor: { kind: 'none' } },
    verb: 'turn.prompted',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [inboundHash],
  }
}

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

test('drive-turn: fires the handle with prompt text + sender from the inbound', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const calls: Parameters<DriveTurnHandle['run']>[0][] = []
  sync.register(
    driveTurn({
      getDriveHandle: ch =>
        ch === CHANNEL
          ? {
              run: async opts => {
                calls.push(opts)
                return { chunks: ['ok'] }
              },
            }
          : undefined,
      getByHash: hash => store.getByHash(hash),
    }),
  )
  sync.start()
  const i = await admit(store, inbound())
  const p = await admit(store, prompted(i.interaction.hash))
  await settle()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.promptHash).toBe(p.interaction.hash)
  expect(calls[0]!.inboundHash).toBe(i.interaction.hash)
  expect(calls[0]!.promptText).toBe('do a thing')
  expect(calls[0]!.senderId).toBe('owner1')
  expect(calls[0]!.senderKindKind).toBe('owner')
  sync.stop()
  engine.close()
  store.close()
})

test('drive-turn: no handle for the channel → no-op', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  let called = false
  sync.register(
    driveTurn({
      getDriveHandle: () => undefined,
      getByHash: hash => store.getByHash(hash),
    }),
  )
  sync.start()
  const i = await admit(store, inbound())
  await admit(store, prompted(i.interaction.hash))
  await settle()
  expect(called).toBe(false)
  sync.stop()
  engine.close()
  store.close()
})

test('drive-turn: ill-formed turn.prompted (no caused_by) is skipped', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  let called = false
  sync.register(
    driveTurn({
      getDriveHandle: () => ({
        run: async () => {
          called = true
          return { chunks: [] }
        },
      }),
      getByHash: hash => store.getByHash(hash),
    }),
  )
  sync.start()
  // Construct an "orphan" turn.prompted with no caused_by.
  await admit(store, {
    actor: 'bot1',
    role: 'agent',
    channel: CHANNEL,
    target: { artifactId: `extp:discord/${CHANNEL}`, anchor: { kind: 'none' } },
    verb: 'turn.prompted',
    patch: { kind: 'none' },
    effect: 'pure',
    caused_by: [],
  })
  await settle()
  expect(called).toBe(false)
  sync.stop()
  engine.close()
  store.close()
})
