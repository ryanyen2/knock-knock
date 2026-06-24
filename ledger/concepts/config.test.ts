/**
 * Config fold — per-channel overlay convergence. Mirrors cross-machine.test.ts:
 * two FoldEngines share one SqliteStore (the same in-process subscribe both
 * receive on each insert, standing in for Postgres LISTEN/NOTIFY). config.set
 * carries a `none` anchor, so admit applies it immediately and it never
 * undergoes a lifecycle change — convergence comes purely from the INSERT-only
 * deltas projected by the fold.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import {
  CONFIG_FOLD,
  configFold,
  configFor,
  resolveConfigFor,
  configArtifact,
  latestConfigHash,
  type ConfigFoldState,
} from './config.ts'
import type { ChannelConfigDelta } from '../../lib.ts'
import type { ProposedInteraction } from '../interaction.ts'

const ROOM = 'room-1'

function configSet(delta: ChannelConfigDelta, caused_by: string[] = []): ProposedInteraction {
  return configSetFor(ROOM, delta, caused_by)
}

function configSetFor(id: string, delta: ChannelConfigDelta, caused_by: string[] = []): ProposedInteraction {
  return {
    actor: 'OWNER',
    role: 'owner',
    channel: id,
    target: { artifactId: configArtifact(id), anchor: { kind: 'none' } },
    verb: 'config.set',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'config.set', args: delta } },
    effect: 'pure',
    caused_by,
  }
}

async function setupTwoMachines() {
  const store = new SqliteStore(':memory:')
  const engineA = new FoldEngine(store)
  const engineB = new FoldEngine(store)
  await engineA.register(configFold)
  await engineB.register(configFold)
  return { store, engineA, engineB }
}

const tick = () => new Promise(r => setTimeout(r, 2))

test('config fold: a config.set on one machine is visible to the other', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  const r = await admit(store, configSet({ role: 'a terse reviewer' }))
  expect(r.kind).toBe('admitted')

  expect(configFor(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM).role).toBe('a terse reviewer')
  expect(configFor(engineB.get<ConfigFoldState>(CONFIG_FOLD), ROOM).role).toBe('a terse reviewer')

  engineA.close()
  engineB.close()
  store.close()
})

test('config fold: a later set overwrites an earlier one, and both machines agree', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  await admit(store, configSet({ role: 'first' }))
  await tick() // guarantee a distinct createdAt so ordering is unambiguous
  await admit(store, configSet({ role: 'second' }))

  const a = configFor(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)
  const b = configFor(engineB.get<ConfigFoldState>(CONFIG_FOLD), ROOM)
  expect(a.role).toBe('second')
  expect(a).toEqual(b)

  engineA.close()
  engineB.close()
  store.close()
})

test('config fold: reset (_clear) removes a key back to the base on both machines', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  await admit(store, configSet({ role: 'reviewer' }))
  await tick()
  const latest = latestConfigHash(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)
  await admit(store, configSet({ _clear: ['role'] }, latest ? [latest] : []))

  expect(configFor(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)).toEqual({})
  expect(configFor(engineB.get<ConfigFoldState>(CONFIG_FOLD), ROOM)).toEqual({})

  engineA.close()
  engineB.close()
  store.close()
})

test('config fold: re-affirming a prior value is not deduped when chained, and wins', async () => {
  // A → B → A. The third edit has the same delta as the first; chaining its
  // caused_by onto the latest gives it a distinct hash so admit does not dedup
  // it to the older interaction, and it folds as the current value.
  const { store, engineA } = await setupTwoMachines()
  await admit(store, configSet({ role: 'A' }))
  await tick()
  let latest = latestConfigHash(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)
  await admit(store, configSet({ role: 'B' }, latest ? [latest] : []))
  await tick()
  latest = latestConfigHash(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)
  const third = await admit(store, configSet({ role: 'A' }, latest ? [latest] : []))
  expect(third.kind).toBe('admitted')

  expect(configFor(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM).role).toBe('A')

  engineA.close()
  store.close()
})

test('resolveConfigFor: thread overlay wins per key, room is the inherited default', async () => {
  const { store, engineA } = await setupTwoMachines()
  const THREAD = 'thread-1'
  await admit(store, configSetFor(ROOM, { role: 'room persona', model: 'claude-room' }))
  await admit(store, configSetFor(THREAD, { role: 'thread persona' }))

  const state = engineA.get<ConfigFoldState>(CONFIG_FOLD)
  const resolved = resolveConfigFor(state, ROOM, THREAD)
  expect(resolved.role).toBe('thread persona') // thread overrides
  expect(resolved.model).toBe('claude-room')   // inherited from room

  engineA.close()
  store.close()
})

test('resolveConfigFor: scope==room collapses to the room config (no thread)', async () => {
  const { store, engineA } = await setupTwoMachines()
  await admit(store, configSetFor(ROOM, { role: 'room persona' }))
  const state = engineA.get<ConfigFoldState>(CONFIG_FOLD)
  expect(resolveConfigFor(state, ROOM, ROOM)).toEqual(configFor(state, ROOM))

  engineA.close()
  store.close()
})

test('config fold: a fresh engine bootstrapped from the store reproduces the view', async () => {
  const { store, engineA } = await setupTwoMachines()
  await admit(store, configSet({ role: 'persisted reviewer' }))
  const snapshotA = configFor(engineA.get<ConfigFoldState>(CONFIG_FOLD), ROOM)

  const engineC = new FoldEngine(store)
  await engineC.register(configFold)
  expect(configFor(engineC.get<ConfigFoldState>(CONFIG_FOLD), ROOM)).toEqual(snapshotA)
  expect(snapshotA.role).toBe('persisted reviewer')

  engineA.close()
  engineC.close()
  store.close()
})
