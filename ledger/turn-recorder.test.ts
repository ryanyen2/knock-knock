/**
 * End-to-end Phase 0 integration test: drive TurnRecorder with synthetic
 * adapter events (no Discord, no agent SDK) and assert the resulting
 * Interaction sequence has the right shape and causal chains. This is the
 * rubric #1 (Replayability) anchor for the cutover: every audit-worthy
 * decision in a turn lives in the ledger and reconstructs from it.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { Ledger } from './capture.ts'
import { TurnRecorder } from './turn-recorder.ts'
import type { AgentEvent } from '../agent-adapter.ts'

function setup() {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  return {
    store,
    ledger,
    ctx: {
      agentKey: 'bot1',
      approverUserId: 'owner1',
      channelId: 'chan-A',
      channelArtifactId: 'extp:discord/chan-A',
    },
  }
}

test('end-to-end: an inbound message produces channel.message + turn.prompted', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'hello',
  })

  const all = await store.listByChannel(ctx.channelId)
  expect(all).toHaveLength(2)
  expect(all[0]!.verb).toBe('channel.message')
  expect(all[0]!.role).toBe('owner')
  expect(all[0]!.actor).toBe('owner1')
  expect(all[1]!.verb).toBe('turn.prompted')
  expect(all[1]!.role).toBe('agent')
  expect(all[1]!.actor).toBe('bot1')
  expect(all[1]!.caused_by).toEqual([r.inboundHash])
  store.close()
})

test('end-to-end: tool_call → tool_result are recorded and causally chained', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'list files',
  })

  const callEvent: AgentEvent = {
    type: 'tool_call',
    toolCallId: 't-1',
    name: 'Bash',
    input: { command: 'ls' },
  }
  const resultEvent: AgentEvent = { type: 'tool_result', toolCallId: 't-1', status: 'completed' }

  const req = await r.onAdapterEvent(callEvent)
  const exec = await r.onAdapterEvent(resultEvent)

  expect(req?.verb).toBe('tool.requested')
  expect(req?.caused_by).toEqual([r.promptHash])
  expect(req?.target.artifactId).toBe('extp:tool/t-1')
  expect(exec?.verb).toBe('tool.executed')
  expect(exec?.caused_by).toEqual([req!.hash])
  // The full causal slice for this turn is two hops from r.promptHash.
  expect(await store.isAncestor(r.promptHash, exec!.hash)).toBe(true)
  expect(await store.isAncestor(r.inboundHash, exec!.hash)).toBe(true)
  store.close()
})

test('end-to-end: an ask-tier verdict records tool.approved with the right parent', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'edit foo.ts',
  })
  await r.onAdapterEvent({
    type: 'tool_call',
    toolCallId: 't-1',
    name: 'Edit',
    input: { file_path: 'foo.ts' },
  })

  const verdict = await r.onVerdict('Edit', { file_path: 'foo.ts' }, { behavior: 'allow' })
  expect(verdict.verb).toBe('tool.approved')
  expect(verdict.actor).toBe('owner1')
  expect(verdict.role).toBe('owner')

  // The verdict should point at the tool.requested, NOT at the prompt.
  const requested = (await store.listByVerb('tool.requested'))[0]!
  expect(verdict.caused_by).toEqual([requested.hash])
  store.close()
})

test('end-to-end: a denied verdict produces tool.denied', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'rm -rf',
  })
  await r.onAdapterEvent({
    type: 'tool_call',
    toolCallId: 't-1',
    name: 'Bash',
    input: { command: 'rm -rf' },
  })
  const v = await r.onVerdict(
    'Bash',
    { command: 'rm -rf' },
    { behavior: 'deny', message: 'denied' },
  )
  expect(v.verb).toBe('tool.denied')
  store.close()
})

test('end-to-end: turn.replied caused_by includes prompt + every executed tool', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'do two things',
  })
  await r.onAdapterEvent({ type: 'tool_call', toolCallId: 't-1', name: 'A', input: {} })
  await r.onAdapterEvent({ type: 'tool_result', toolCallId: 't-1', status: 'completed' })
  await r.onAdapterEvent({ type: 'tool_call', toolCallId: 't-2', name: 'B', input: {} })
  await r.onAdapterEvent({ type: 'tool_result', toolCallId: 't-2', status: 'completed' })

  const reply = await r.finishTurn('done')
  expect(reply?.verb).toBe('turn.replied')

  const executed = await store.listByVerb('tool.executed')
  expect(executed).toHaveLength(2)
  expect(new Set(reply!.caused_by)).toEqual(
    new Set([r.promptHash, ...executed.map(e => e.hash)]),
  )
  store.close()
})

test('end-to-end: an empty reply produces no turn.replied (no spurious record)', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'silent',
  })
  const reply = await r.finishTurn(undefined)
  expect(reply).toBeUndefined()
  const replies = await store.listByVerb('turn.replied')
  expect(replies).toHaveLength(0)
  store.close()
})

test('end-to-end: two sequential turns chain via channel.message caused_by latest-in-channel', async () => {
  const { store, ledger, ctx } = setup()

  const r1 = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'first',
  })
  await r1.finishTurn('reply one')

  const r2 = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-2',
    text: 'second',
  })

  // The second channel.message's caused_by should be the prior latest in the
  // channel (the turn.replied from turn 1).
  const all = await store.listByChannel(ctx.channelId)
  const secondInbound = all.find(
    i => i.verb === 'channel.message' && i.actor === 'owner1' && i.caused_by.length > 0,
  )
  expect(secondInbound).toBeDefined()
  // The full DAG should be ancestor-connected: every record on turn 2
  // transitively reaches the first inbound.
  expect(await store.isAncestor(r1.inboundHash, r2.promptHash)).toBe(true)
  store.close()
})

test('end-to-end: verdict without a matching tool_call falls back to promptHash parent', async () => {
  // Handles the race where the adapter calls the permission handler before
  // emitting the corresponding tool_call event. The verdict still gets a
  // sensible caused_by (the prompt) rather than throwing.
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'fast tool',
  })
  const v = await r.onVerdict('Mystery', { x: 1 }, { behavior: 'allow' })
  expect(v.caused_by).toEqual([r.promptHash])
  store.close()
})

test('end-to-end: every recorded interaction verifies against its hash', async () => {
  const { store, ledger, ctx } = setup()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'hi',
  })
  await r.onAdapterEvent({ type: 'tool_call', toolCallId: 't-1', name: 'X', input: {} })
  await r.onAdapterEvent({ type: 'tool_result', toolCallId: 't-1', status: 'completed' })
  await r.finishTurn('ok')

  const all = await store.listByChannel(ctx.channelId)
  const { verifyHash } = await import('./canonical.ts')
  for (const i of all) expect(verifyHash(i)).toBe(true)
  store.close()
})
