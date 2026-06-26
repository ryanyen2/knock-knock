/**
 * Coordination layer — store-backed sync tests (no Discord, no real hosts).
 * U2 reply-claim: exactly one agent replies, drive-once across relays, policy bias.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { loopGuardFold } from '../../src/ledger/concepts/loop-guard.ts'
import { replyClaim, type ReplyCoordContext } from '../../src/ledger/synchronizations/reply-claim.ts'
import { discordArtifact, type ChannelId, type Role } from '../../src/ledger/interaction.ts'
import type { ChannelConfig } from '../../src/lib.ts'

const flush = () => new Promise(r => setTimeout(r, 10))

function channelMessage(
  channel: ChannelId,
  role: Role,
  authorId: string,
  messageId: string,
  targetAgent: string,
) {
  return {
    actor: authorId,
    role,
    channel,
    target: { artifactId: discordArtifact(channel), anchor: { kind: 'none' as const } },
    verb: 'channel.message' as const,
    patch: {
      kind: 'external' as const,
      intent: { channel: 'discord', op: 'received', args: { text: 'hi', messageId, targetAgent } },
    },
    effect: 'external' as const,
    caused_by: [] as string[],
  }
}

type AgentSpec = { isOwnerBot?: boolean; cfg?: ChannelConfig; relayId?: string }

/** A resolveCoord that knows a fixed set of locally-served agents, keyed by agentKey. */
function coordResolver(agents: Record<string, AgentSpec>, relayId = 'relayA') {
  return (_channel: ChannelId, targetAgent: string | undefined): ReplyCoordContext | undefined => {
    const a = targetAgent ? agents[targetAgent] : undefined
    if (!targetAgent || !a) return undefined
    return {
      agentKey: targetAgent,
      isOwnerBot: a.isOwnerBot ?? true,
      cfg: a.cfg ?? {},
      relayId: a.relayId ?? relayId,
    }
  }
}

async function promptedActors(store: SqliteStore): Promise<string[]> {
  const rows = await store.listByVerb('turn.prompted')
  return rows.map(r => r.actor)
}

test('reply-claim: a single eligible agent gets exactly one turn.prompted', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }) }))
  sync.start()

  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  expect(await promptedActors(store)).toEqual(['bot002'])
  store.close()
})

test('reply-claim: two eligible agents → exactly one turn.prompted (reply election)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  const sync = new Synchronizer(store, engine)
  sync.register(replyClaim({ resolveCoord: coordResolver({ bot002: {}, bot101: {} }) }))
  sync.start()

  // Two hosts each admit their own channel.message for the SAME platform message id.
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot101'))
  await flush()

  const actors = await promptedActors(store)
  expect(actors.length).toBe(1) // exactly one agent answered — no duplicate "Got it"
  store.close()
})

test('reply-claim: designated policy → only the front-door agent replies', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)

  // Controllable defer: a non-preferred agent's attempt is queued, run on demand.
  const deferred: Array<() => void> = []
  const cfg: ChannelConfig = { responder: 'designated', responderAgent: 'bot002' }
  const sync = new Synchronizer(store, engine)
  sync.register(
    replyClaim({
      resolveCoord: coordResolver({ bot002: { cfg }, bot101: { cfg } }),
      defer: fn => deferred.push(fn),
    }),
  )
  sync.start()

  // Non-designate arrives FIRST but must defer; designate arrives and wins inline.
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot101'))
  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  expect(await promptedActors(store)).toEqual(['bot002']) // designate won before the defer

  // The deferred non-designate attempt now runs and finds the claim already held.
  for (const fn of deferred.splice(0)) fn()
  await flush()
  expect(await promptedActors(store)).toEqual(['bot002']) // still exactly one
  store.close()
})

test('reply-claim: same agent on two relays is driven exactly once (drive election)', async () => {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)

  // Two relays share one store (mirrors cross-machine Postgres): two synchronizers,
  // each running reply-claim for the SAME agent under a distinct relayId.
  const syncA = new Synchronizer(store, engine)
  const syncB = new Synchronizer(store, engine)
  syncA.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }, 'relayA') }))
  syncB.register(replyClaim({ resolveCoord: coordResolver({ bot002: {} }, 'relayB') }))
  syncA.start()
  syncB.start()

  await admit(store, channelMessage('chan1', 'human', 'human1', 'msgM', 'bot002'))
  await flush()

  // Both relays pass the reply election (same agentKey holder renews), but only
  // one wins the drive claim → exactly one turn.prompted.
  expect(await promptedActors(store)).toEqual(['bot002'])
  store.close()
})
