/**
 * apply-supersession (U13): a peer re-derives a supersession from the winner's
 * immutable `supersedes` op (which crosses Postgres NOTIFY), closing the
 * cross-machine gap where the loser's lifecycle UPDATE never replicated. Tested
 * against a minimal fake store — the sync only touches getByHash/updateLifecycle.
 */

import { test, expect } from 'bun:test'
import { applySupersession } from '../../../src/ledger/synchronizations/apply-supersession.ts'
import type { Interaction, Lifecycle } from '../../../src/ledger/interaction.ts'

function fakeStore(rows: Record<string, Lifecycle>) {
  const updates: Array<{ hash: string; lifecycle: Lifecycle }> = []
  return {
    updates,
    store: {
      async getByHash(hash: string) {
        return rows[hash] ? ({ hash, lifecycle: rows[hash] } as Interaction) : undefined
      },
      async updateLifecycle(hash: string, lifecycle: Lifecycle) {
        rows[hash] = lifecycle
        updates.push({ hash, lifecycle })
      },
    },
  }
}

function winner(supersedes: string[]): Interaction {
  return { hash: 'WIN', lifecycle: 'applied', supersedes } as Interaction
}

const sync = applySupersession()

test('matches an applied or admitted interaction that supersedes peers', () => {
  expect(sync.matches(winner(['L1']))).toBe(true)
  expect(sync.matches({ hash: 'y', lifecycle: 'admitted', supersedes: ['L1'] } as Interaction)).toBe(true)
  expect(sync.matches({ hash: 'x', lifecycle: 'applied' } as Interaction)).toBe(false)
  expect(sync.matches({ hash: 'x', lifecycle: 'proposed', supersedes: ['L1'] } as Interaction)).toBe(false)
})

test('supersedes each listed loser that is still live', async () => {
  const f = fakeStore({ L1: 'applied', L2: 'applied' })
  await sync.fire(winner(['L1', 'L2']), { store: f.store } as any)
  expect(f.updates).toEqual([
    { hash: 'L1', lifecycle: 'superseded' },
    { hash: 'L2', lifecycle: 'superseded' },
  ])
})

test('is idempotent — an already-superseded or denied loser is skipped', async () => {
  const f = fakeStore({ L1: 'superseded', L2: 'denied' })
  await sync.fire(winner(['L1', 'L2']), { store: f.store } as any)
  expect(f.updates).toEqual([]) // no redundant updates / refolds
})

test('skips a loser not yet present on this peer (out-of-order arrival)', async () => {
  const f = fakeStore({}) // loser hasn't replicated here yet
  await sync.fire(winner(['L1']), { store: f.store } as any)
  expect(f.updates).toEqual([])
})
