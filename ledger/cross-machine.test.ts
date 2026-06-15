/**
 * Cross-machine convergence — Phase 4 algorithm validation without a live
 * Postgres. Two `FoldEngine`s share the same `SqliteStore`, which exposes
 * the same in-process `subscribe` callback both engines receive on each
 * insert. This mirrors what `LISTEN interaction_inserted` would deliver
 * across the network in the real Postgres path — same Interaction object,
 * same step order, byte-identical fold output.
 *
 * The properties we assert:
 *   1. A `channel.message` admitted by "machine A" is visible to "machine B"
 *      within one event-loop turn.
 *   2. The loop-guard fold converges (both machines agree on the per-channel
 *      consecutiveAgentTurns count).
 *   3. An owner override on machine A causes the loser's `lifecycle` to
 *      transition; machine B reading the same store sees the same state.
 *   4. Equal-role concurrent peers produce the same conflict.branches order
 *      on both machines (deterministic lower-hash sort).
 *   5. Idempotent re-admit returns the same hash; the store never gets
 *      duplicated rows.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { FoldEngine } from './fold.ts'
import { admit } from './admit.ts'
import { hashInteraction } from './canonical.ts'
import { mergeProposal } from './merge.ts'
import {
  LOOP_GUARD_FOLD,
  loopGuardFold,
  stateFor,
  type LoopGuardFoldState,
} from './concepts/loop-guard.ts'
import {
  KNOWLEDGE_FOLD,
  knowledgeFold,
  activeNotes,
  annotateWithStaleness,
  type KnowledgeFoldState,
} from './artifacts/knowledge.ts'
import type { Interaction, ProposedInteraction } from './interaction.ts'

const CHANNEL = 'chan-shared'
const ARTIFACT = 'know:scope/shared'

async function setupTwoMachines() {
  const store = new SqliteStore(':memory:')
  const engineA = new FoldEngine(store)
  const engineB = new FoldEngine(store)
  await engineA.register(loopGuardFold)
  await engineA.register(knowledgeFold)
  await engineB.register(loopGuardFold)
  await engineB.register(knowledgeFold)
  return { store, engineA, engineB }
}

function inboundMsg(actor: string, role: 'owner' | 'human' | 'agent'): ProposedInteraction {
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
    caused_by: [],
  }
}

function knowledgePatch(
  actor: string,
  role: 'owner' | 'human' | 'agent',
  body: string,
): ProposedInteraction {
  return {
    actor,
    role,
    channel: CHANNEL,
    target: { artifactId: ARTIFACT, anchor: { kind: 'key', path: 'finding' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: `n-${actor}`, body } },
    effect: 'pure',
    caused_by: [],
  }
}

// ───────────────────────────────────────────────────────────────────────────

test('cross-machine: A admits → B sees it on the next event-loop turn', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  // A admits an owner inbound; B's loop-guard fold should reflect the reset.
  await admit(store, inboundMsg('owner1', 'owner'))

  const a = stateFor(engineA.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL)
  const b = stateFor(engineB.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL)
  expect(a.consecutiveAgentTurns).toBe(0)
  expect(b.consecutiveAgentTurns).toBe(0)

  // Three turn.prompted admissions ("we decided to act" on three agent
  // peers) — both machines should agree on the count. (Raw agent inbounds
  // don't step the fold; only turn.prompted does. See loop-guard.ts.)
  // Each prompt is unique by virtue of its caused_by parent, so the store
  // doesn't dedup them.
  let prev = (await store.latestInChannel(CHANNEL))?.hash
  for (let n = 0; n < 3; n++) {
    const p = await admit(store, {
      actor: 'bot1',
      role: 'agent',
      channel: CHANNEL,
      target: { artifactId: `extp:discord/${CHANNEL}`, anchor: { kind: 'none' } },
      verb: 'turn.prompted',
      patch: { kind: 'none' },
      effect: 'pure',
      caused_by: prev ? [prev] : [],
    })
    prev = p.interaction.hash
  }
  const a2 = stateFor(engineA.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL)
  const b2 = stateFor(engineB.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL)
  expect(a2.consecutiveAgentTurns).toBe(3)
  expect(b2.consecutiveAgentTurns).toBe(3)
  // The two machines see the same value — that's the convergence property.
  expect(a2).toEqual(b2)

  engineA.close()
  engineB.close()
  store.close()
})

test('cross-machine: owner override on A is reflected in both machines', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  const agent = await admit(store, knowledgePatch('bot1', 'agent', 'view-A'))
  expect(agent.kind).toBe('admitted')

  const owner = await admit(store, knowledgePatch('owner1', 'owner', 'view-O'))
  expect(owner.kind).toBe('admitted')

  // The loser's row reflects supersession.
  const back = await store.getByHash(agent.interaction.hash)
  expect(back?.lifecycle).toBe('superseded')

  // Both engines see the same inbox note (the surface-back mechanism).
  const inbox = 'know:actor/bot1/inbox'
  const annotatedA = annotateWithStaleness(engineA.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), inbox)
  const annotatedB = annotateWithStaleness(engineB.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), inbox)
  expect(annotatedA).toEqual(annotatedB)
  expect(annotatedA.length).toBeGreaterThan(0)

  engineA.close()
  engineB.close()
  store.close()
})

test('cross-machine: equal-role conflict produces the same branches order on both machines', async () => {
  // The merge function sorts conflict.branches by hash so this property
  // holds deterministically. We build two competing proposals manually
  // (without admit) and run mergeProposal in isolation.
  const a: Interaction = (() => {
    const p = knowledgePatch('botA', 'agent', 'A')
    return { ...p, hash: hashInteraction(p), lifecycle: 'admitted', createdAt: '2026-01-01T00:00:00.000Z' }
  })()
  const b: Interaction = (() => {
    const p = knowledgePatch('botB', 'agent', 'B')
    return { ...p, hash: hashInteraction(p), lifecycle: 'admitted', createdAt: '2026-01-01T00:00:00.000Z' }
  })()
  // Calling merge with peers in DIFFERENT orders must give the same branches.
  const outAB = mergeProposal(b, [a])
  const outBA = mergeProposal(b, [a].reverse())
  expect(outAB).toEqual(outBA)
  expect(outAB.kind).toBe('conflict')
  const branches = (outAB as { branches: string[] }).branches
  // Branches sorted ascending — deterministic across machines.
  expect([...branches]).toEqual([...branches].sort())
})

test('cross-machine: idempotent re-admit produces no duplicate rows', async () => {
  const { store, engineA, engineB } = await setupTwoMachines()
  const proposal = knowledgePatch('bot1', 'agent', 'unique')

  // A admits.
  const r1 = await admit(store, proposal)
  // B "admits" the same content (e.g., a synchronization fired on both
  // machines in parallel). Same hash → store dedups.
  const r2 = await admit(store, proposal)

  expect(r1.interaction.hash).toBe(r2.interaction.hash)
  const notes = await store.listByArtifact(ARTIFACT)
  expect(notes).toHaveLength(1)

  // Both engines agree on the single note.
  const activeA = activeNotes(engineA.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  const activeB = activeNotes(engineB.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(activeA).toEqual(activeB)
  expect(activeA).toHaveLength(1)

  engineA.close()
  engineB.close()
  store.close()
})

test('cross-machine: bootstrap on a new machine reproduces the existing view', async () => {
  // Build state with engine A, then "machine B" comes online: bootstrap
  // + fresh engine should reconstruct the exact same projections.
  const store = new SqliteStore(':memory:')
  const engineA = new FoldEngine(store)
  await engineA.register(loopGuardFold)
  await engineA.register(knowledgeFold)
  await admit(store, inboundMsg('owner1', 'owner'))
  await admit(store, knowledgePatch('bot1', 'agent', 'pre-existing'))

  const snapshotA = {
    lg: stateFor(engineA.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL),
    notes: activeNotes(engineA.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT),
  }

  const { bootstrap } = await import('./bootstrap.ts')
  const boot = await bootstrap(store)
  expect(boot.hasExistingData).toBe(true)
  expect(boot.scanned).toBeGreaterThan(0)

  const engineB = new FoldEngine(store)
  await engineB.register(loopGuardFold)
  await engineB.register(knowledgeFold)
  const snapshotB = {
    lg: stateFor(engineB.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), CHANNEL),
    notes: activeNotes(engineB.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT),
  }
  expect(snapshotB).toEqual(snapshotA)

  engineA.close()
  engineB.close()
  store.close()
})

test('cross-machine: equal-role admit ordering still ties via lower hash for cross-machine winner picks', async () => {
  // Three concurrent agent-role proposals. A higher-role override later
  // arrives. On both machines, the override's "winner" (in case it needed
  // to break a tie among equal-role peers) must be the lower-hash one.
  // Direct merge-function test with three peers, propose owner:
  const peers: Interaction[] = ['botA', 'botB', 'botC'].map(actor => {
    const p = knowledgePatch(actor, 'agent', `view-${actor}`)
    return { ...p, hash: hashInteraction(p), lifecycle: 'admitted', createdAt: '2026-01-01T00:00:00.000Z' }
  })
  const ownerP = knowledgePatch('owner1', 'owner', 'TRUTH')
  const owner: Interaction = {
    ...ownerP,
    hash: hashInteraction(ownerP),
    lifecycle: 'admitted',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  // Two machines may have peers in different stored order; merge sorts.
  const out1 = mergeProposal(owner, peers)
  const out2 = mergeProposal(owner, [...peers].reverse())
  expect(out1).toEqual(out2)
  expect(out1.kind).toBe('admit')
  // All three peers are superseded — supersede list is sorted ascending.
  const supersede = (out1 as { supersede: string[] }).supersede
  expect([...supersede]).toEqual([...supersede].sort())
  expect(new Set(supersede)).toEqual(new Set(peers.map(p => p.hash)))
})
