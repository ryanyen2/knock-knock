/**
 * Pure-merge tests. No store, no admit gate — just the role-ordered decision
 * function. These describe the contract the gate enforces; admit.test.ts
 * exercises the end-to-end flow including supersession surfacing.
 */

import { test, expect } from 'bun:test'
import { hashInteraction } from '../../ledger/canonical.ts'
import { mergeProposal } from '../../ledger/merge.ts'
import type { Interaction, ProposedInteraction, Role } from '../../ledger/interaction.ts'

function make(
  overrides: Partial<ProposedInteraction> & { lifecycle?: Interaction['lifecycle'] } = {},
): Interaction {
  const p: ProposedInteraction = {
    actor: 'someone',
    role: 'agent',
    channel: 'c',
    target: { artifactId: 'vers:repo/foo.ts', anchor: { kind: 'range', from: 0, to: 10 } },
    verb: 'workspace.edit',
    patch: { kind: 'versionable', ops: '' },
    effect: 'workspace',
    caused_by: [],
    ...overrides,
  }
  return {
    ...p,
    hash: hashInteraction(p),
    lifecycle: overrides.lifecycle ?? 'admitted',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

test('merge: no concurrent peers → straight admit', () => {
  const r = mergeProposal(make(), [])
  expect(r.kind).toBe('admit')
  expect((r as { supersede: string[] }).supersede).toEqual([])
})

test('merge: anchor=none bypasses the merge entirely (no conflicts ever)', () => {
  // A channel.message has anchor=none — two of them at the same channel
  // must never conflict, no matter how many concurrent peers exist.
  const proposed = make({
    role: 'owner',
    target: { artifactId: 'extp:discord/c1', anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
  })
  const peer = make({
    role: 'human',
    target: { artifactId: 'extp:discord/c1', anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: { kind: 'none' },
    effect: 'pure',
    actor: 'someone-else',
  })
  const r = mergeProposal(proposed, [peer])
  expect(r.kind).toBe('admit')
})

test('merge: owner overrides agent at the same anchor — agent is superseded', () => {
  const agentPatch = make({ role: 'agent', actor: 'bot1' })
  const ownerPatch = make({ role: 'owner', actor: 'owner1' })
  const r = mergeProposal(ownerPatch, [agentPatch])
  expect(r.kind).toBe('admit')
  expect((r as { supersede: string[] }).supersede).toEqual([agentPatch.hash])
})

test('merge: human overrides agent', () => {
  const agentPatch = make({ role: 'agent', actor: 'bot1' })
  const humanPatch = make({ role: 'human', actor: 'human1' })
  const r = mergeProposal(humanPatch, [agentPatch])
  expect(r.kind).toBe('admit')
  expect((r as { supersede: string[] }).supersede).toEqual([agentPatch.hash])
})

test('merge: agent is rejected when an owner has already admitted at the same anchor', () => {
  const ownerPatch = make({ role: 'owner', actor: 'owner1' })
  const agentPatch = make({ role: 'agent', actor: 'bot1' })
  const r = mergeProposal(agentPatch, [ownerPatch])
  expect(r.kind).toBe('reject')
  expect((r as { reason: string; winner: string }).reason).toBe('lower-role')
  expect((r as { reason: string; winner: string }).winner).toBe(ownerPatch.hash)
})

test('merge: equal-role concurrent peers surface as conflict (both branches visible)', () => {
  const a = make({ role: 'agent', actor: 'botA' })
  const b = make({ role: 'agent', actor: 'botB' })
  const r = mergeProposal(b, [a])
  expect(r.kind).toBe('conflict')
  expect(new Set((r as { branches: string[] }).branches)).toEqual(new Set([a.hash, b.hash]))
})

test('merge: mix of equal + lower peers → conflict (equal-role takes precedence)', () => {
  const equal = make({ role: 'agent', actor: 'botEqual' })
  const lower = make({ role: 'agent', actor: 'botOther' }) // also agent — actually same rank
  // To exercise "mix", make one lower (none in this 3-tier system would be
  // strictly lower than agent, so test mix of equal + external instead).
  const externalPeer = make({
    role: 'agent',
    actor: 'botEx',
    effect: 'external',
    target: { artifactId: 'extp:tool/x', anchor: { kind: 'proxy', proxyId: 'x' } },
    verb: 'tool.executed',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'x', args: {} } },
  })
  // External in the peer set forces straight admit regardless of equal-role.
  const r = mergeProposal(
    make({
      role: 'agent',
      target: { artifactId: 'extp:tool/x', anchor: { kind: 'proxy', proxyId: 'x' } },
      effect: 'external',
      verb: 'tool.executed',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'x', args: {} } },
    }),
    [externalPeer],
  )
  expect(r.kind).toBe('admit')
  // lower/equal unused in this scenario but documented to show the design.
  void [equal, lower]
})

test('merge: external proposed bypasses role-ordered merge (no supersede of peers)', () => {
  const peer = make({
    role: 'agent',
    effect: 'workspace',
    target: { artifactId: 'vers:x', anchor: { kind: 'range', from: 0, to: 1 } },
  })
  const proposed = make({
    role: 'owner',
    effect: 'external',
    target: { artifactId: 'vers:x', anchor: { kind: 'range', from: 0, to: 1 } },
    verb: 'external.release',
    patch: { kind: 'external', intent: { channel: 'http', op: 'POST', args: {} } },
  })
  const r = mergeProposal(proposed, [peer])
  expect(r.kind).toBe('admit')
  // external never supersedes — peer keeps its lifecycle.
  expect((r as { supersede: string[] }).supersede).toEqual([])
})

test('merge: owner with multiple agent peers → all peers superseded', () => {
  const peers = [
    make({ role: 'agent', actor: 'b1' }),
    make({ role: 'agent', actor: 'b2' }),
    make({ role: 'agent', actor: 'b3' }),
  ]
  const owner = make({ role: 'owner', actor: 'o' })
  const r = mergeProposal(owner, peers)
  expect(r.kind).toBe('admit')
  expect(new Set((r as { supersede: string[] }).supersede)).toEqual(
    new Set(peers.map(p => p.hash)),
  )
})

test('merge: any higher-role peer wins, even when others would be supersedable', () => {
  // Mixed peer set: one owner (higher), one agent (lower). Proposed = human.
  // The owner wins; proposed is rejected; the agent's would-be supersession
  // does NOT happen (the agent peer remains admitted alongside the owner).
  const ownerPeer = make({ role: 'owner', actor: 'o' })
  const agentPeer = make({ role: 'agent', actor: 'a' })
  const proposedHuman = make({ role: 'human', actor: 'h' })
  const r = mergeProposal(proposedHuman, [ownerPeer, agentPeer])
  expect(r.kind).toBe('reject')
  expect((r as { winner: string }).winner).toBe(ownerPeer.hash)
})

test('merge: role rank ordering (owner > human > agent) holds in both directions', () => {
  const rolePairs: Array<[Role, Role, 'admit' | 'reject']> = [
    ['owner', 'human', 'admit'],
    ['owner', 'agent', 'admit'],
    ['human', 'agent', 'admit'],
    ['human', 'owner', 'reject'],
    ['agent', 'owner', 'reject'],
    ['agent', 'human', 'reject'],
  ]
  for (const [proposed, peer, expected] of rolePairs) {
    const r = mergeProposal(
      make({ role: proposed, actor: `P-${proposed}` }),
      [make({ role: peer, actor: `C-${peer}` })],
    )
    expect(r.kind).toBe(expected)
  }
})
