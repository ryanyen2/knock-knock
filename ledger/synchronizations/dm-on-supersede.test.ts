/**
 * dm-on-supersede (§4.4): a merge-gate inbox note triggers a DM to the losing
 * agent's owner.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { dmOnSupersede } from './dm-on-supersede.ts'
import type { ProposedInteraction } from '../interaction.ts'

function inboxNote(agentKey: string, body: string): ProposedInteraction {
  return {
    actor: 'system:merge-gate',
    role: 'owner',
    channel: 'chan-A',
    target: { artifactId: `know:actor/${agentKey}/inbox`, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: 'n1', body } },
    effect: 'pure',
    caused_by: [],
  }
}

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

test('dm-on-supersede: DMs the owner of the superseded agent', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const dms: Array<{ to: string; text: string }> = []
  sync.register(
    dmOnSupersede({
      getOwnerForAgent: key => (key === 'bob-bot' ? 'u-bob-owner' : undefined),
      dmSend: async (to, text) => {
        dms.push({ to, text })
        return 'dm-1'
      },
      channelLabel: id => (id === 'chan-A' ? '#project-x' : `#${id}`),
    }),
  )
  sync.start()

  await admit(store, inboxNote('bob-bot', 'Your proposal ab12cd34 was superseded by ef56gh78.'))
  await settle()

  expect(dms).toHaveLength(1)
  expect(dms[0]!.to).toBe('u-bob-owner')
  expect(dms[0]!.text).toContain('overridden** in #project-x')
  expect(dms[0]!.text).toContain('Your proposal ab12cd34 was superseded')
  sync.stop()
  engine.close()
  store.close()
})

test('dm-on-supersede: unknown agent (no owner) → no DM', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const dms: unknown[] = []
  sync.register(
    dmOnSupersede({
      getOwnerForAgent: () => undefined,
      dmSend: async () => {
        dms.push(1)
        return 'x'
      },
    }),
  )
  sync.start()
  await admit(store, inboxNote('ghost', 'superseded'))
  await settle()
  expect(dms).toEqual([])
  sync.stop()
  engine.close()
  store.close()
})

test('dm-on-supersede: ignores non-inbox knowledge and non-gate authors', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  const dms: unknown[] = []
  sync.register(
    dmOnSupersede({
      getOwnerForAgent: () => 'u-owner',
      dmSend: async () => {
        dms.push(1)
        return 'x'
      },
    }),
  )
  sync.start()
  // agent's own note, not a gate supersession → ignored
  await admit(store, {
    actor: 'bob-bot',
    role: 'agent',
    channel: 'chan-A',
    target: { artifactId: 'know:actor/bob-bot/notes', anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: 'x', body: 'a note' } },
    effect: 'pure',
    caused_by: [],
  })
  await settle()
  expect(dms).toEqual([])
  sync.stop()
  engine.close()
  store.close()
})
