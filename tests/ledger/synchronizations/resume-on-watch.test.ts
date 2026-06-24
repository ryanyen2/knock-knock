/**
 * resume-on-watch cross-relay dedup (U12). With relayId set, exactly one relay
 * resumes a given watch.fired — gated on an external_claim keyed by the fire's
 * (cross-relay-identical) hash. Tested against a fake ctx; the sync only touches
 * store.acquireClaim and ctx.admit.
 */

import { test, expect } from 'bun:test'
import { resumeOnWatch } from '../../../src/ledger/synchronizations/resume-on-watch.ts'
import type { Interaction } from '../../../src/ledger/interaction.ts'

function firedInteraction(): Interaction {
  return {
    hash: 'FIRE1',
    verb: 'watch.fired',
    lifecycle: 'applied',
    channel: 'chan',
    target: { artifactId: 'extp:discord/chan', anchor: { kind: 'none' } },
    patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.fire', args: { agentKey: 'bot1', text: 'fired' } } },
  } as Interaction
}

function fakeCtx(opts: { acquired?: boolean }) {
  const admits: any[] = []
  return {
    admits,
    ctx: {
      store: {
        async acquireClaim(_key: string, _holder: string, _ttl: number) {
          return { acquired: opts.acquired ?? true }
        },
      },
      admit: async (p: any) => {
        admits.push(p)
        return { kind: 'admitted', interaction: { ...p, hash: 'TP' }, superseded: [] } as any
      },
    },
  }
}

test('resume-on-watch: with relayId and the claim won, admits one turn.prompted', async () => {
  const sync = resumeOnWatch({ relayId: 'relay-A' })
  const f = fakeCtx({ acquired: true })
  await sync.fire(firedInteraction(), f.ctx as any)
  expect(f.admits.length).toBe(1)
  expect(f.admits[0]).toMatchObject({ verb: 'turn.prompted', actor: 'bot1', caused_by: ['FIRE1'] })
})

test('resume-on-watch: with relayId and the claim lost, admits nothing (dedup)', async () => {
  const sync = resumeOnWatch({ relayId: 'relay-B' })
  const f = fakeCtx({ acquired: false })
  await sync.fire(firedInteraction(), f.ctx as any)
  expect(f.admits.length).toBe(0)
})

test('resume-on-watch: without relayId (single relay), admits without claiming', async () => {
  const sync = resumeOnWatch()
  const f = fakeCtx({ acquired: false }) // would block if it claimed — proves it doesn't
  await sync.fire(firedInteraction(), f.ctx as any)
  expect(f.admits.length).toBe(1)
})

test('resume-on-watch: an ill-formed fire (no agentKey) admits nothing', async () => {
  const sync = resumeOnWatch({ relayId: 'relay-A' })
  const f = fakeCtx({ acquired: true })
  const bad = { ...firedInteraction(), patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.fire', args: {} } } } as Interaction
  await sync.fire(bad, f.ctx as any)
  expect(f.admits.length).toBe(0)
})
