/**
 * Concept folds: behavioral equivalence with the imperative state they
 * replace. The LoopGuard concept must reproduce the seven `lib.test.ts`
 * cases for `loopGuard()` exactly, since the pure function is unchanged
 * — only its INPUT (per-channel state) is now derived from the ledger
 * rather than from an in-memory Map.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { Ledger } from '../capture.ts'
import { FoldEngine } from '../fold.ts'
import { TurnRecorder } from '../turn-recorder.ts'
import { admit } from '../admit.ts'
import { discordArtifact } from '../interaction.ts'
import {
  LOOP_GUARD_FOLD,
  loopGuardFold,
  stateFor,
  decideLoopGuard,
  type LoopGuardFoldState,
} from './loop-guard.ts'
import { CHANNEL_FOLD, channelFold, type ChannelFoldState } from './channel.ts'
import { TURN_FOLD, turnFold, type TurnFoldState } from './turn.ts'
import { APPROVAL_FOLD, approvalFold, type ApprovalFoldState, pendingApprovals } from './approval.ts'

async function setupEngine() {
  const store = new SqliteStore(':memory:')
  const ledger = new Ledger(store)
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(channelFold)
  await engine.register(turnFold)
  await engine.register(approvalFold)
  return { store, ledger, engine }
}

const ctx = {
  agentKey: 'bot1',
  approverUserId: 'owner1',
  channelId: 'chan-A',
}

/** Phase 3 helper: mimics what Approvals.resolveInteraction does — admits
 *  tool.approved/tool.denied caused_by the matched tool.requested hash. */
async function admitVerdict(
  store: SqliteStore,
  recorder: TurnRecorder,
  name: string,
  input: unknown,
  behavior: 'allow' | 'deny',
): Promise<void> {
  const parent = recorder.popPendingForVerdict(name, input)
  await admit(store, {
    actor: ctx.approverUserId,
    role: 'owner',
    channel: ctx.channelId,
    target: { artifactId: `extp:tool/${parent}`, anchor: { kind: 'proxy', proxyId: parent } },
    verb: behavior === 'allow' ? 'tool.approved' : 'tool.denied',
    patch: {
      kind: 'external',
      intent: { channel: 'tool', op: 'verdict', args: { behavior } },
    },
    effect: 'external',
    caused_by: [parent],
  })
}

// ─── LoopGuard ─────────────────────────────────────────────────────────────

test('LoopGuard concept: owner channel.message resets the counter', async () => {
  // The Phase 3 fold counts turn.prompted (turns we DECIDED to take), not
  // raw channel.messages. Three turn.prompted admissions → counter = 3.
  // An owner channel.message resets to 0; subsequent turn.prompted (e.g.,
  // for our reply) would re-increment.
  const { store, ledger, engine } = await setupEngine()
  for (let n = 0; n < 3; n++) {
    await TurnRecorder.beginTurn(ledger, ctx, {
      senderId: `peer${n}`,
      senderKind: 'agent',
      messageId: `m-${n}`,
      text: 'hi',
    })
  }
  expect(
    stateFor(engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), ctx.channelId)
      .consecutiveAgentTurns,
  ).toBe(3)
  // Admit a raw owner channel.message (no follow-up turn.prompted) so we
  // can observe the reset isolated from any new prompt.
  await admit(store, {
    actor: 'owner1',
    role: 'owner',
    channel: ctx.channelId,
    target: { artifactId: discordArtifact(ctx.channelId), anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: {
        channel: 'discord',
        op: 'received',
        args: { text: 'stop', messageId: 'm-owner' },
      },
    },
    effect: 'external',
    caused_by: [],
  })
  expect(
    stateFor(engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD), ctx.channelId)
      .consecutiveAgentTurns,
  ).toBe(0)
  engine.close()
  store.close()
})

test('LoopGuard concept: decideLoopGuard reproduces the threshold behavior', async () => {
  const { store, ledger, engine } = await setupEngine()
  for (let n = 0; n < 4; n++) {
    await TurnRecorder.beginTurn(ledger, ctx, {
      senderId: `peer${n}`,
      senderKind: 'agent',
      messageId: `m-${n}`,
      text: 'hi',
    })
  }
  const fold = engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD)
  const decision = decideLoopGuard(fold, ctx.channelId, 'agent', Date.now(), {
    maxConsecutive: 4,
    cooldownMs: 1_000,
  })
  expect(decision.allow).toBe(false)
  expect(decision.reason).toBe('threshold')
  engine.close()
  store.close()
})

test('LoopGuard concept: state is per-channel — channel B unaffected by channel A', async () => {
  const { store, ledger, engine } = await setupEngine()
  for (let n = 0; n < 3; n++) {
    await TurnRecorder.beginTurn(ledger, ctx, {
      senderId: `peer${n}`,
      senderKind: 'agent',
      messageId: `m-${n}`,
      text: 'hi',
    })
  }
  await TurnRecorder.beginTurn(
    ledger,
    { ...ctx, channelId: 'chan-B' },
    { senderId: 'peer-X', senderKind: 'agent', messageId: 'm-B', text: 'hi' },
  )
  const fold = engine.get<LoopGuardFoldState>(LOOP_GUARD_FOLD)
  expect(stateFor(fold, 'chan-A').consecutiveAgentTurns).toBe(3)
  expect(stateFor(fold, 'chan-B').consecutiveAgentTurns).toBe(1)
  engine.close()
  store.close()
})

// ─── Channel ───────────────────────────────────────────────────────────────

test('Channel concept: transcript fold appends messages + replies in order', async () => {
  const { store, ledger, engine } = await setupEngine()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'hello',
  })
  await r.finishTurn('hi back')

  const transcript = engine.get<ChannelFoldState>(CHANNEL_FOLD).get(ctx.channelId)!
  expect(transcript).toHaveLength(2)
  expect(transcript[0]!.kind).toBe('message')
  expect(transcript[1]!.kind).toBe('reply')
  expect(transcript[0]!.kind === 'message' && transcript[0]!.text).toBe('hello')
  expect(transcript[1]!.kind === 'reply' && transcript[1]!.text).toBe('hi back')
  engine.close()
  store.close()
})

// ─── Turn ──────────────────────────────────────────────────────────────────

test('Turn concept: lifecycle keys by promptHash and tracks tool calls', async () => {
  const { store, ledger, engine } = await setupEngine()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'run X',
  })
  await r.onAdapterEvent({ type: 'tool_call', toolCallId: 't-1', name: 'Bash', input: { command: 'ls' } })
  await r.onAdapterEvent({ type: 'tool_result', toolCallId: 't-1', status: 'completed' })
  await r.finishTurn('done')

  const turn = engine.get<TurnFoldState>(TURN_FOLD).get(r.promptHash)!
  expect(turn).toBeDefined()
  expect(turn.toolCalls).toHaveLength(1)
  expect(turn.toolCalls[0]!.name).toBe('Bash')
  expect(turn.toolCalls[0]!.status).toBe('executed')
  expect(turn.reply?.text).toBe('done')
  engine.close()
  store.close()
})

// ─── Approval ──────────────────────────────────────────────────────────────

test('Approval concept: tool.requested → pending; tool.approved → allowed', async () => {
  const { store, ledger, engine } = await setupEngine()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'edit',
  })
  await r.onAdapterEvent({
    type: 'tool_call',
    toolCallId: 't-1',
    name: 'Edit',
    input: { file_path: 'foo.ts' },
  })

  let pending = pendingApprovals(engine.get<ApprovalFoldState>(APPROVAL_FOLD))
  expect(pending).toHaveLength(1)
  expect(pending[0]!.toolName).toBe('Edit')

  await admitVerdict(store, r, 'Edit', { file_path: 'foo.ts' }, 'allow')

  pending = pendingApprovals(engine.get<ApprovalFoldState>(APPROVAL_FOLD))
  expect(pending).toHaveLength(0)
  const settled = [...engine.get<ApprovalFoldState>(APPROVAL_FOLD).values()]
  expect(settled[0]!.status).toBe('allowed')
  expect(settled[0]!.resolverActor).toBe('owner1')
  engine.close()
  store.close()
})

test('Approval concept: tool.denied → denied status, resolverActor tracked', async () => {
  const { store, ledger, engine } = await setupEngine()
  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'rm -rf',
  })
  await r.onAdapterEvent({ type: 'tool_call', toolCallId: 't-1', name: 'Bash', input: { command: 'rm -rf' } })
  await admitVerdict(store, r, 'Bash', { command: 'rm -rf' }, 'deny')
  const state = [...engine.get<ApprovalFoldState>(APPROVAL_FOLD).values()]
  expect(state[0]!.status).toBe('denied')
  engine.close()
  store.close()
})

// ─── Restart simulation ────────────────────────────────────────────────────

test('Folds: a fresh FoldEngine on a populated store reconstructs identical state', async () => {
  // Rubric #1: any state must be reconstructable purely by folding the
  // ledger. Building a second engine from scratch must produce the same view.
  const { store, ledger, engine } = await setupEngine()

  const r = await TurnRecorder.beginTurn(ledger, ctx, {
    senderId: 'owner1',
    senderKind: 'owner',
    messageId: 'm-1',
    text: 'edit',
  })
  await r.onAdapterEvent({
    type: 'tool_call',
    toolCallId: 't-1',
    name: 'Edit',
    input: { file_path: 'foo.ts' },
  })
  await admitVerdict(store, r, 'Edit', { file_path: 'foo.ts' }, 'allow')
  await r.onAdapterEvent({ type: 'tool_result', toolCallId: 't-1', status: 'completed' })
  await r.finishTurn('done')

  // Snapshot what the live engine sees.
  const liveTranscript = [...engine.get<ChannelFoldState>(CHANNEL_FOLD).get(ctx.channelId)!]
  const liveApprovals = [...engine.get<ApprovalFoldState>(APPROVAL_FOLD).values()]

  // Tear down everything except the store and bootstrap from scratch.
  engine.close()
  const reborn = new FoldEngine(store)
  await reborn.register(channelFold)
  await reborn.register(approvalFold)

  const replayedTranscript = [
    ...reborn.get<ChannelFoldState>(CHANNEL_FOLD).get(ctx.channelId)!,
  ]
  const replayedApprovals = [...reborn.get<ApprovalFoldState>(APPROVAL_FOLD).values()]

  expect(replayedTranscript).toEqual(liveTranscript)
  expect(replayedApprovals).toEqual(liveApprovals)

  reborn.close()
  store.close()
})
