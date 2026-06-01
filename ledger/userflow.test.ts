/**
 * End-to-end user flows — the wrap-up. Each test takes a black-box scenario
 * ("user does X, agent does Y") and reads back the ledger to assert the
 * captured story is complete, causally-chained, and self-explanatory.
 *
 * The harness avoids Discord and avoids real adapters — it composes the
 * SAME synchronization chain the relay runs, with stubbed callbacks that
 * stand in for "the adapter ran a tool" / "Discord accepted the post".
 * The assertions look at what `store.listByVerb(...)` shows — that's the
 * audit experience an operator (or LLM, rubric #3) would see.
 *
 * Run with: bun test ledger/userflow.test.ts
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './store-sqlite.ts'
import { FoldEngine } from './fold.ts'
import { Synchronizer } from './sync.ts'
import { admit } from './admit.ts'
import { loopGuardFold } from './concepts/loop-guard.ts'
import { channelFold, type ChannelFoldState, CHANNEL_FOLD } from './concepts/channel.ts'
import { turnFold, type TurnFoldState, TURN_FOLD } from './concepts/turn.ts'
import { approvalFold, type ApprovalFoldState, APPROVAL_FOLD } from './concepts/approval.ts'
import {
  knowledgeFold,
  activeNotes,
  annotateWithStaleness,
  type KnowledgeFoldState,
  KNOWLEDGE_FOLD,
} from './artifacts/knowledge.ts'
import { promptOnMessage } from './synchronizations/prompt-on-message.ts'
import { driveTurn, type DriveTurnHandle } from './synchronizations/drive-turn.ts'
import { postOnReply } from './synchronizations/post-on-reply.ts'
import { classifyOnToolRequest } from './synchronizations/classify-on-tool-request.ts'
import { awaitVerdict } from './await-verdict.ts'
import type { ProposedInteraction } from './interaction.ts'
import type { PermissionProfile } from '../state.ts'

// ─── Test harness: a Phase 3 relay stand-in ───────────────────────────────

type Harness = {
  store: SqliteStore
  engine: FoldEngine
  sync: Synchronizer
  /** Captures what would go to Discord; the post-on-reply sync feeds it. */
  posts: Array<{ channel: string; text: string }>
  /** The stub adapter's behavior for a given prompt text. */
  setAdapter: (
    fn: (opts: { promptHash: string; promptText: string }) => Promise<{
      text: string
      tools?: Array<{ name: string; input: unknown }>
    }>,
  ) => void
  /** Stub of the owner clicking Allow/Deny in Discord. */
  approve: (toolRequestedHash: string) => Promise<void>
  deny: (toolRequestedHash: string) => Promise<void>
  close: () => void
}

async function harness(opts: {
  agentKey?: string
  channel?: string
  policy?: PermissionProfile
} = {}): Promise<Harness> {
  const agentKey = opts.agentKey ?? 'bot1'
  const channel = opts.channel ?? 'chan-A'
  const policy: PermissionProfile = opts.policy ?? { allow: [], ask: [], deny: [] }

  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(loopGuardFold)
  await engine.register(channelFold)
  await engine.register(turnFold)
  await engine.register(approvalFold)
  await engine.register(knowledgeFold)
  const sync = new Synchronizer(store, engine)

  const posts: Array<{ channel: string; text: string }> = []
  let adapter:
    | ((opts: { promptHash: string; promptText: string }) => Promise<{
        text: string
        tools?: Array<{ name: string; input: unknown }>
      }>)
    | undefined

  // The drive-turn handle synthesizes the adapter's tool calls and reply
  // by admitting tool.requested / tool.executed / turn.replied directly —
  // same shape AgentHost.runTurnForChannel would produce.
  const handle: DriveTurnHandle = {
    run: async runOpts => {
      const fn = adapter
      if (!fn) {
        await admit(store, {
          actor: agentKey,
          role: 'agent',
          channel,
          target: { artifactId: `extp:discord/${channel}`, anchor: { kind: 'none' } },
          verb: 'turn.replied',
          patch: {
            kind: 'external',
            intent: { channel: 'discord', op: 'reply', args: { text: '(no adapter)' } },
          },
          effect: 'external',
          caused_by: [runOpts.promptHash],
        })
        return { chunks: ['(no adapter)'] }
      }
      const result = await fn({
        promptHash: runOpts.promptHash,
        promptText: runOpts.promptText,
      })
      const toolExecuted: string[] = []
      for (const t of result.tools ?? []) {
        const toolCallId = `t-${Math.random().toString(36).slice(2, 8)}`
        const req = await admit(store, {
          actor: agentKey,
          role: 'agent',
          channel,
          target: { artifactId: `extp:tool/${toolCallId}`, anchor: { kind: 'proxy', proxyId: toolCallId } },
          verb: 'tool.requested',
          patch: {
            kind: 'external',
            intent: { channel: 'tool', op: t.name, args: t.input },
          },
          effect: 'external',
          caused_by: [runOpts.promptHash],
        })
        // The real adapter waits on awaitVerdict for the ledger to admit a
        // tool.approved or tool.denied caused_by req.hash. We do the same.
        const verdict = await awaitVerdict(store, req.interaction.hash, 5_000)
        if (verdict.behavior === 'allow') {
          const exec = await admit(store, {
            actor: agentKey,
            role: 'agent',
            channel,
            target: { artifactId: `extp:tool/${toolCallId}`, anchor: { kind: 'proxy', proxyId: toolCallId } },
            verb: 'tool.executed',
            patch: {
              kind: 'external',
              intent: { channel: 'tool', op: 'result', args: {} },
              result: { ok: true, ref: toolCallId },
            },
            effect: 'external',
            caused_by: [req.interaction.hash],
          })
          toolExecuted.push(exec.interaction.hash)
        }
      }
      await admit(store, {
        actor: agentKey,
        role: 'agent',
        channel,
        target: { artifactId: `extp:discord/${channel}`, anchor: { kind: 'none' } },
        verb: 'turn.replied',
        patch: {
          kind: 'external',
          intent: { channel: 'discord', op: 'reply', args: { text: result.text } },
        },
        effect: 'external',
        caused_by: [runOpts.promptHash, ...toolExecuted],
      })
      return { chunks: [result.text] }
    },
  }

  sync.register(
    classifyOnToolRequest({ readPolicy: () => policy }),
  )
  sync.register(
    promptOnMessage({
      getAgentForChannel: ch => (ch === channel ? { agentKey } : undefined),
    }),
  )
  sync.register(
    driveTurn({
      getDriveHandle: ch => (ch === channel ? handle : undefined),
      getByHash: hash => store.getByHash(hash),
    }),
  )
  sync.register(
    postOnReply({
      discordSend: async (ch, text) => {
        posts.push({ channel: ch, text })
        return 'msg-out'
      },
    }),
  )
  sync.start()

  return {
    store,
    engine,
    sync,
    posts,
    setAdapter: fn => {
      adapter = fn
    },
    approve: async toolRequestedHash =>
      void (await admit(store, {
        actor: 'owner1',
        role: 'owner',
        channel,
        target: {
          artifactId: `extp:tool/${toolRequestedHash}`,
          anchor: { kind: 'proxy', proxyId: toolRequestedHash },
        },
        verb: 'tool.approved',
        patch: {
          kind: 'external',
          intent: { channel: 'tool', op: 'verdict', args: { behavior: 'allow' } },
        },
        effect: 'external',
        caused_by: [toolRequestedHash],
      })),
    deny: async toolRequestedHash =>
      void (await admit(store, {
        actor: 'owner1',
        role: 'owner',
        channel,
        target: {
          artifactId: `extp:tool/${toolRequestedHash}`,
          anchor: { kind: 'proxy', proxyId: toolRequestedHash },
        },
        verb: 'tool.denied',
        patch: {
          kind: 'external',
          intent: { channel: 'tool', op: 'verdict', args: { behavior: 'deny' } },
        },
        effect: 'external',
        caused_by: [toolRequestedHash],
      })),
    close: () => {
      sync.stop()
      engine.close()
      store.close()
    },
  }
}

async function settle(ms = 60) {
  await new Promise(r => setTimeout(r, ms))
}

function ownerMsg(text: string, messageId: string, channel = 'chan-A'): ProposedInteraction {
  return {
    actor: 'owner1',
    role: 'owner',
    channel,
    target: { artifactId: `extp:discord/${channel}`, anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'received', args: { text, messageId } },
    },
    effect: 'external',
    caused_by: [],
  }
}

function agentMsg(text: string, actor: string, channel = 'chan-A'): ProposedInteraction {
  return {
    actor,
    role: 'agent',
    channel,
    target: { artifactId: `extp:discord/${channel}`, anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'received', args: { text, messageId: `m-${actor}` } },
    },
    effect: 'external',
    caused_by: [],
  }
}

// ─── Flow 1: solo owner → agent reply → Discord post ──────────────────────

test('flow: owner asks; agent replies; the audit trail tells the story', async () => {
  const h = await harness()
  h.setAdapter(async ({ promptText }) => ({ text: `you said: ${promptText}` }))

  await admit(h.store, ownerMsg('hello bot', 'm-1'))
  await settle()

  // The ledger should contain: channel.message, turn.prompted, turn.replied.
  const messages = await h.store.listByVerb('channel.message')
  const prompts = await h.store.listByVerb('turn.prompted')
  const replies = await h.store.listByVerb('turn.replied')
  expect(messages).toHaveLength(1)
  expect(prompts).toHaveLength(1)
  expect(replies).toHaveLength(1)
  // Causal chain: reply ← prompt ← message
  expect(prompts[0]!.caused_by).toEqual([messages[0]!.hash])
  expect(replies[0]!.caused_by).toEqual([prompts[0]!.hash])
  // Discord post happened. Body is followed by the §4.3 attribution line.
  expect(h.posts).toHaveLength(1)
  expect(h.posts[0]!.channel).toBe('chan-A')
  expect(h.posts[0]!.text.split('\n\n')[0]).toBe('you said: hello bot')
  // Turn-fold projection (the dual-audience view, rubric #3) has the full picture.
  const turn = h.engine.get<TurnFoldState>(TURN_FOLD).get(prompts[0]!.hash)!
  expect(turn.reply?.text).toBe('you said: hello bot')
  expect(turn.toolCalls).toHaveLength(0)
  h.close()
})

// ─── Flow 2: multi-turn back-and-forth ────────────────────────────────────

test('flow: three sequential owner turns each produce their own audit slice', async () => {
  const h = await harness()
  let nReply = 0
  h.setAdapter(async ({ promptText }) => ({ text: `reply ${++nReply}: ${promptText}` }))

  await admit(h.store, ownerMsg('first', 'm-1'))
  await settle()
  await admit(h.store, ownerMsg('second', 'm-2'))
  await settle()
  await admit(h.store, ownerMsg('third', 'm-3'))
  await settle()

  const replies = await h.store.listByVerb('turn.replied')
  expect(replies).toHaveLength(3)
  expect(h.posts.map(p => p.text.split('\n\n')[0])).toEqual([
    'reply 1: first',
    'reply 2: second',
    'reply 3: third',
  ])
  // Channel transcript fold should contain 3 messages + 3 replies, in order.
  const transcript = h.engine.get<ChannelFoldState>(CHANNEL_FOLD).get('chan-A')!
  const kinds = transcript.map(e => e.kind)
  expect(kinds).toEqual(['message', 'reply', 'message', 'reply', 'message', 'reply'])
  h.close()
})

// ─── Flow 3: ask-tier tool — owner approves, tool executes ────────────────

test('flow: ask-tier tool waits for owner approval; allowed → executed', async () => {
  const h = await harness({
    policy: { allow: [], ask: ['Bash(*)'], deny: [] },
  })
  // Adapter requests a Bash tool; we'll approve it after a moment.
  let pendingApproveHash: string | undefined
  h.setAdapter(async ({ promptHash }) => {
    // The harness sequence: drive-turn admits tool.requested, classify
    // produces tool.classified(ask), the harness's "wait for verdict" sees
    // an owner approval (which the test simulates below).
    // To synchronize, capture the tool.requested hash by listing after admit.
    void promptHash
    return { text: 'tool ran', tools: [{ name: 'Bash', input: { command: 'ls' } }] }
  })

  // Kick off and let drive-turn admit the tool.requested.
  void admit(h.store, ownerMsg('run ls', 'm-1'))
  // Give the adapter time to issue the tool.requested.
  await new Promise(r => setTimeout(r, 50))
  const req = (await h.store.listByVerb('tool.requested'))[0]
  expect(req).toBeDefined()
  pendingApproveHash = req!.hash

  await h.approve(pendingApproveHash!)
  await settle(200)

  // The audit trail should show: tool.classified(ask) + tool.approved (owner)
  // + tool.executed; turn.replied caused_by includes tool.executed.
  const classified = (await h.store.listByVerb('tool.classified'))[0]
  expect(classified).toBeDefined()
  const verdict = (classified!.patch as { intent: { args: { verdict: string } } }).intent.args.verdict
  expect(verdict).toBe('ask')

  const approved = await h.store.listByVerb('tool.approved')
  expect(approved.length).toBeGreaterThan(0)
  expect(approved.some(a => a.caused_by.includes(req!.hash))).toBe(true)

  const executed = await h.store.listByVerb('tool.executed')
  expect(executed.length).toBeGreaterThan(0)

  const replies = await h.store.listByVerb('turn.replied')
  expect(replies).toHaveLength(1)
  expect(replies[0]!.caused_by).toContain(executed[0]!.hash)
  h.close()
})

// ─── Flow 4: deny-tier tool blocked by policy ─────────────────────────────

test('flow: deny-tier tool produces tool.denied; no tool.executed', async () => {
  const h = await harness({
    policy: { allow: [], ask: [], deny: ['Bash(rm -rf *)'] },
  })
  h.setAdapter(async () => ({
    text: 'cannot run',
    tools: [{ name: 'Bash', input: { command: 'rm -rf /' } }],
  }))

  await admit(h.store, ownerMsg('please rm', 'm-1'))
  await settle(200)

  // tool.classified should record verdict=deny; tool.denied should follow.
  const classified = await h.store.listByVerb('tool.classified')
  expect(classified).toHaveLength(1)
  const verdict = (classified[0]!.patch as { intent: { args: { verdict: string } } }).intent.args.verdict
  expect(verdict).toBe('deny')

  const denied = await h.store.listByVerb('tool.denied')
  expect(denied.length).toBeGreaterThan(0)
  // Reason attribution lives on the denied interaction's patch.
  const reason = (denied[0]!.patch as { intent: { args: { reason?: string } } }).intent.args.reason
  expect(reason).toContain('policy')

  // Tool.executed should NOT exist — the deny floor held.
  expect(await h.store.listByVerb('tool.executed')).toHaveLength(0)
  h.close()
})

// ─── Flow 5: loop-guard threshold trips on agent ping-pong ────────────────

test('flow: loop-guard blocks the 5th consecutive agent peer; no extra turn', async () => {
  const h = await harness()
  h.setAdapter(async () => ({ text: 'r' }))

  // Five distinct agent peers post in rapid succession.
  for (let n = 0; n < 5; n++) {
    await admit(h.store, agentMsg(`from peer ${n}`, `peer${n}`))
    await settle(50)
  }
  // Loop guard default = max 4 consecutive. The fold sees all 5 admitted
  // channel.messages; the synchronization gates the 5th.
  const prompts = await h.store.listByVerb('turn.prompted')
  expect(prompts.length).toBeLessThan(5)
  // Specifically: at most 3 prompts (the sync sees state already incremented
  // by the fold before its check; cooldown also trips). The point is fewer
  // than the 5 messages — the loop is bounded.
  expect(prompts.length).toBeGreaterThan(0)
  h.close()
})

// ─── Flow 6: knowledge accumulation + owner invalidate cascade ────────────

test('flow: agent builds knowledge; owner invalidates root; cascade renders stale', async () => {
  const h = await harness()

  // Build a chain of agent notes: root → child → grandchild.
  const ARTIFACT = 'know:agent/bot1/research'
  const root = await admit(h.store, {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: 'a', body: 'finding: foo is 42' } },
    effect: 'pure',
    caused_by: [],
  })
  const child = await admit(h.store, {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: 'b', body: 'derived from foo=42' } },
    effect: 'pure',
    caused_by: [root.interaction.hash],
  })
  await admit(h.store, {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.append',
    patch: { kind: 'knowledge', append: { id: 'c', body: 'and conclusion' } },
    effect: 'pure',
    caused_by: [child.interaction.hash],
  })

  // Three active notes.
  expect(activeNotes(h.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)).toHaveLength(3)

  // Owner discovers foo was wrong; invalidates the root.
  await admit(h.store, {
    actor: 'owner1',
    role: 'owner',
    channel: 'chan-A',
    target: { artifactId: ARTIFACT, anchor: { kind: 'none' } },
    verb: 'knowledge.invalidate',
    patch: { kind: 'knowledge', invalidate: { hash: root.interaction.hash } },
    effect: 'pure',
    caused_by: [root.interaction.hash],
  })

  // Active view → empty. All three are stale via cascade.
  expect(activeNotes(h.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)).toHaveLength(0)
  const annotated = annotateWithStaleness(h.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD), ARTIFACT)
  expect(annotated).toHaveLength(3)
  expect(annotated.every(a => a.stale)).toBe(true)
  h.close()
})

// ─── Flow 7: cross-machine echo — second engine sees A's admissions ───────

test('flow: cross-machine engine sees A\'s flow without re-running anything', async () => {
  const hA = await harness()
  hA.setAdapter(async ({ promptText }) => ({ text: `echo: ${promptText}` }))
  await admit(hA.store, ownerMsg('hi from A', 'm-1'))
  await settle()

  // "Machine B" attaches a second engine to the same store. It does NOT
  // re-run synchronizations — those only fire on its own subscribe; the
  // existing data is replayed only into folds. The B view of the channel
  // transcript and turn-fold should match A's.
  const engineB = new FoldEngine(hA.store)
  await engineB.register(channelFold)
  await engineB.register(turnFold)

  const transcriptA = hA.engine.get<ChannelFoldState>(CHANNEL_FOLD).get('chan-A')!
  const transcriptB = engineB.get<ChannelFoldState>(CHANNEL_FOLD).get('chan-A')!
  expect(transcriptB).toEqual(transcriptA)

  const promptedHash = (await hA.store.listByVerb('turn.prompted'))[0]!.hash
  const turnA = hA.engine.get<TurnFoldState>(TURN_FOLD).get(promptedHash)!
  const turnB = engineB.get<TurnFoldState>(TURN_FOLD).get(promptedHash)!
  expect(turnB).toEqual(turnA)

  engineB.close()
  hA.close()
})

// ─── Flow 8: causal-slice readability — "why did this happen?" ────────────

test('flow: a turn.replied is fully explainable from its caused_by chain', async () => {
  // Rubric #3 (Interpretability): reading one slice + its ancestors should
  // tell the auditor (or LLM) the full why. This test walks the chain.
  const h = await harness({
    policy: { allow: [], ask: ['Bash(*)'], deny: [] },
  })
  h.setAdapter(async () => ({
    text: 'done.',
    tools: [{ name: 'Bash', input: { command: 'pwd' } }],
  }))

  void admit(h.store, ownerMsg('show me the dir', 'm-1'))
  await new Promise(r => setTimeout(r, 50))
  const req = (await h.store.listByVerb('tool.requested'))[0]!
  await h.approve(req.hash)
  await settle(200)

  const reply = (await h.store.listByVerb('turn.replied'))[0]!

  // The reply's caused_by leads to the prompt and the executed tool.
  // Walk the chain and describe what happened in human terms.
  const story: string[] = []
  for (const parent of reply.caused_by) {
    const p = await h.store.getByHash(parent)
    if (!p) continue
    if (p.verb === 'turn.prompted') {
      const grandparent = await h.store.getByHash(p.caused_by[0]!)
      const text = (grandparent?.patch as { intent: { args: { text: string } } } | undefined)
        ?.intent.args.text
      story.push(`agent ${p.actor} was prompted by ${p.caused_by[0]!.slice(0, 8)} ("${text}")`)
    } else if (p.verb === 'tool.executed') {
      const reqInt = await h.store.getByHash(p.caused_by[0]!)
      const op = (reqInt?.patch as { intent: { op: string } } | undefined)?.intent.op
      story.push(`agent ran tool ${op} (request ${p.caused_by[0]!.slice(0, 8)})`)
    }
  }
  // The story must be non-empty and reference the prompt + tool.
  expect(story.length).toBeGreaterThan(0)
  expect(story.some(s => s.includes('prompted'))).toBe(true)
  expect(story.some(s => s.includes('tool'))).toBe(true)
  h.close()
})

// ─── Flow 9: rubric #1 dump — fresh fold engine reproduces every projection ─

test('flow: rubric #1 — after a busy session, a fresh engine reproduces every projection', async () => {
  // Simulate a busy session, then bootstrap a second engine and compare.
  const h = await harness({
    policy: { allow: ['Read(*)'], ask: ['Bash(*)'], deny: ['Bash(rm *)'] },
  })
  h.setAdapter(async ({ promptText }) => ({
    text: `processed: ${promptText}`,
    tools: [{ name: 'Read', input: { file_path: 'README.md' } }],
  }))

  await admit(h.store, ownerMsg('look at the readme', 'm-1'))
  await settle(200)
  await admit(h.store, ownerMsg('try a dangerous thing', 'm-2'))
  await settle(200)

  const liveChannel = h.engine.get<ChannelFoldState>(CHANNEL_FOLD).get('chan-A')!
  const liveApprovals = [...h.engine.get<ApprovalFoldState>(APPROVAL_FOLD).values()]

  const reborn = new FoldEngine(h.store)
  await reborn.register(channelFold)
  await reborn.register(approvalFold)
  expect(reborn.get<ChannelFoldState>(CHANNEL_FOLD).get('chan-A')!).toEqual(liveChannel)
  expect([...reborn.get<ApprovalFoldState>(APPROVAL_FOLD).values()]).toEqual(liveApprovals)
  reborn.close()
  h.close()
})
