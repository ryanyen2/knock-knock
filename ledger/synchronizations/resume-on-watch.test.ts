/**
 * resume-on-watch: a watch.fired synthesizes a turn.prompted pointing at it, so
 * drive-turn can run a normal turn from the fire's external/text patch.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { resumeOnWatch } from './resume-on-watch.ts'
import type { ProposedInteraction } from '../interaction.ts'

const CH = 'chan-A'
const ART = `extp:discord/${CH}`

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

function firedProposal(args: Record<string, unknown>): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: CH,
    target: { artifactId: ART, anchor: { kind: 'none' } },
    verb: 'watch.fired',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.fire', args } },
    effect: 'external',
    caused_by: [],
  }
}

test('resume-on-watch: fired → turn.prompted caused_by the fire', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(resumeOnWatch())
  sync.start()

  const fired = await admit(
    store,
    firedProposal({ name: 'notes', agentKey: 'bot1', text: 'Watch «notes» fired:\n+ a line' }),
  )
  await settle()

  const prompts = await store.listByVerb('turn.prompted')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!.caused_by).toEqual([fired.interaction.hash])
  expect(prompts[0]!.actor).toBe('bot1')

  sync.stop()
  engine.close()
  store.close()
})

test('resume-on-watch: ignores a fire with no agentKey', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(resumeOnWatch())
  sync.start()

  await admit(store, firedProposal({ name: 'orphan', text: 'no agent' }))
  await settle()
  expect(await store.listByVerb('turn.prompted')).toHaveLength(0)

  sync.stop()
  engine.close()
  store.close()
})
