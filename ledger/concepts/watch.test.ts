/**
 * watch fold — armed/disarmed interactions fold into the live watch set.
 * Re-arming the same name replaces; disarming removes; the set survives replay
 * (a fresh engine over the same store reconstructs it).
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { admit } from '../admit.ts'
import { WATCH_FOLD, watchFold, liveWatches, type WatchFoldState } from './watch.ts'
import type { ProposedInteraction } from '../interaction.ts'
import type { WatchSpec } from '../../lib.ts'

const CHAN = 'chan-1'

function armProposal(name: string, command: string): ProposedInteraction {
  const spec: WatchSpec = { name, channel: CHAN, agentKey: 'bot', command, fireOn: { kind: 'change' } }
  return {
    actor: 'bot',
    role: 'owner',
    channel: CHAN,
    target: { artifactId: `extp:discord/${CHAN}`, anchor: { kind: 'none' } },
    verb: 'watch.armed',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.arm', args: spec } },
    effect: 'pure',
    caused_by: [],
  }
}

function disarmProposal(name: string): ProposedInteraction {
  return {
    actor: 'bot',
    role: 'owner',
    channel: CHAN,
    target: { artifactId: `extp:discord/${CHAN}`, anchor: { kind: 'none' } },
    verb: 'watch.disarmed',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.disarm', args: { name } } },
    effect: 'pure',
    caused_by: [],
  }
}

test('watch fold: arm adds, disarm removes', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(watchFold)

  await admit(store, armProposal('notes', 'diff a b'))
  expect(liveWatches(engine.get<WatchFoldState>(WATCH_FOLD))).toHaveLength(1)
  expect(engine.get<WatchFoldState>(WATCH_FOLD).get(`${CHAN}:notes`)?.command).toBe('diff a b')

  await admit(store, disarmProposal('notes'))
  expect(liveWatches(engine.get<WatchFoldState>(WATCH_FOLD))).toHaveLength(0)
})

test('watch fold: re-arming the same name replaces (dedup by name)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(watchFold)

  await admit(store, armProposal('w', 'cmd-v1'))
  await admit(store, armProposal('w', 'cmd-v2'))
  const state = engine.get<WatchFoldState>(WATCH_FOLD)
  expect(liveWatches(state)).toHaveLength(1)
  expect(state.get(`${CHAN}:w`)?.command).toBe('cmd-v2')
})

test('watch fold: rebuilds on replay (fresh engine, same store)', async () => {
  const store = new SqliteStore(':memory:')
  const e1 = new FoldEngine(store)
  await e1.register(watchFold)
  await admit(store, armProposal('persisted', 'cmd'))

  const e2 = new FoldEngine(store)
  await e2.register(watchFold)
  expect(liveWatches(e2.get<WatchFoldState>(WATCH_FOLD))).toHaveLength(1)
})
