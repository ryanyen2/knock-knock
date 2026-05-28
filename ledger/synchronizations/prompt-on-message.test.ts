/**
 * prompt-on-message: admits a turn.prompted whenever a channel.message lands
 * for a known agent and the loop guard is satisfied. Otherwise no-op.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { loopGuardFold } from '../concepts/loop-guard.ts'
import { promptOnMessage } from './prompt-on-message.ts'
import type { ProposedInteraction, Role } from '../interaction.ts'

const CHANNEL = 'chan-A'
const AGENT = 'bot1'

async function setup(opts?: { agentForChannel?: 'bot1' | undefined }) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(
    promptOnMessage({
      getAgentForChannel: ch =>
        ch === CHANNEL && opts?.agentForChannel !== undefined
          ? { agentKey: opts.agentForChannel }
          : undefined,
      now: () => 1_000_000,
    }),
  )
  sync.start()
  return { store, engine, sync }
}

function inbound(
  role: Role,
  actor: string,
  parents: string[] = [],
): ProposedInteraction {
  return {
    actor,
    role,
    channel: CHANNEL,
    target: { artifactId: `extp:discord/${CHANNEL}`, anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'received', args: { text: 'hi', messageId: `m-${actor}` } },
    },
    effect: 'external',
    caused_by: parents,
  }
}

async function settle() {
  await new Promise(r => setTimeout(r, 20))
}

test('prompt-on-message: owner inbound admits a turn.prompted', async () => {
  const { store, sync, engine } = await setup({ agentForChannel: 'bot1' })
  const m = await admit(store, inbound('owner', 'owner1'))
  await settle()
  const prompts = await store.listByVerb('turn.prompted')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!.actor).toBe(AGENT)
  expect(prompts[0]!.caused_by).toEqual([m.interaction.hash])
  sync.stop()
  engine.close()
  store.close()
})

test('prompt-on-message: no agent for channel → no turn.prompted', async () => {
  const { store, sync, engine } = await setup({ agentForChannel: undefined })
  await admit(store, inbound('owner', 'owner1'))
  await settle()
  expect(await store.listByVerb('turn.prompted')).toHaveLength(0)
  sync.stop()
  engine.close()
  store.close()
})

test('prompt-on-message: agent message past loop-guard threshold is skipped', async () => {
  const { store, sync, engine } = await setup({ agentForChannel: 'bot1' })
  // Five agent messages — default cap is 4 consecutive. Each is concurrent
  // (no caused_by chaining) so the loop guard counts them all.
  for (let n = 0; n < 4; n++) {
    await admit(store, inbound('agent', `peer-${n}`))
    await settle()
  }
  // Now the 5th: loop-guard says deny, prompt-on-message must no-op.
  const before = (await store.listByVerb('turn.prompted')).length
  await admit(store, inbound('agent', `peer-4`))
  await settle()
  const after = (await store.listByVerb('turn.prompted')).length
  expect(after).toBe(before) // no additional turn.prompted
  sync.stop()
  engine.close()
  store.close()
})

test('prompt-on-message: owner inbound resets the loop-guard counter', async () => {
  // Saturate the counter with agents; verify state goes up; owner inbound
  // brings it back to zero. (A subsequent agent message would still be
  // cooldown-blocked within 8s — that's `loopGuard`'s rule, not this
  // synchronization's concern.)
  const { store, sync, engine } = await setup({ agentForChannel: 'bot1' })
  for (let n = 0; n < 4; n++) {
    await admit(store, inbound('agent', `peer-${n}`))
    await settle()
  }
  const { LOOP_GUARD_FOLD, stateFor } = await import('../concepts/loop-guard.ts')
  const peak = stateFor(engine.get(LOOP_GUARD_FOLD), CHANNEL)
  expect(peak.consecutiveAgentTurns).toBeGreaterThan(0)

  await admit(store, inbound('owner', 'owner1'))
  await settle()
  const after = stateFor(engine.get(LOOP_GUARD_FOLD), CHANNEL)
  expect(after.consecutiveAgentTurns).toBe(0)
  expect(after.lastAgentReplyAt).toBe(0)
  sync.stop()
  engine.close()
  store.close()
})

test('prompt-on-message: each admitted turn.prompted has anchor=none + pure effect', async () => {
  const { store, sync, engine } = await setup({ agentForChannel: 'bot1' })
  await admit(store, inbound('owner', 'owner1'))
  await settle()
  const prompted = (await store.listByVerb('turn.prompted'))[0]!
  expect(prompted.target.anchor.kind).toBe('none')
  expect(prompted.effect).toBe('pure')
  sync.stop()
  engine.close()
  store.close()
})
