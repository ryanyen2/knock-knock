/**
 * classify-on-tool-request: end-to-end policy-classification flow through the
 * synchronizer. Uses an injected readPolicy stub so the test owns the policy
 * input deterministically — no STATE_DIR shenanigans.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { FoldEngine } from '../fold.ts'
import { Synchronizer } from '../sync.ts'
import { admit } from '../admit.ts'
import { classifyOnToolRequest } from './classify-on-tool-request.ts'
import type { PermissionProfile } from '../../state.ts'
import type { ProposedInteraction } from '../interaction.ts'

const POLICY: PermissionProfile = {
  allow: ['Read(*)'],
  ask: ['Bash(*)'],
  deny: ['Bash(rm -rf *)'],
}

function setup(policy: PermissionProfile = POLICY) {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(classifyOnToolRequest({ readPolicy: () => policy }))
  sync.start()
  return { store, engine, sync }
}

function toolRequest(
  name: string,
  input: unknown,
  overrides: Partial<ProposedInteraction> = {},
): ProposedInteraction {
  return {
    actor: 'bot1',
    role: 'agent',
    channel: 'chan',
    target: { artifactId: `extp:tool/${name}`, anchor: { kind: 'proxy', proxyId: name } },
    verb: 'tool.requested',
    patch: {
      kind: 'external',
      intent: { channel: 'tool', op: name, args: input },
    },
    effect: 'external',
    caused_by: [],
    ...overrides,
  }
}

async function settle() {
  // Synchronizations are async/fire-and-forget; let microtasks drain.
  await new Promise(r => setTimeout(r, 20))
}

test('classify: allow-tier tool produces a tool.classified(allow) audit', async () => {
  const { store, sync, engine } = setup()
  await admit(store, toolRequest('Read', { file_path: 'README.md' }))
  await settle()
  const classified = await store.listByVerb('tool.classified')
  expect(classified).toHaveLength(1)
  const args = (classified[0]!.patch as { intent: { args: { verdict: string } } }).intent.args
  expect(args.verdict).toBe('allow')
  // No additional tool.approved/tool.denied — allow flows naturally.
  expect(await store.listByVerb('tool.approved')).toHaveLength(0)
  expect(await store.listByVerb('tool.denied')).toHaveLength(0)
  sync.stop()
  engine.close()
  store.close()
})

test('classify: ask-tier tool produces only tool.classified — UX handles the rest', async () => {
  const { store, sync, engine } = setup()
  await admit(store, toolRequest('Bash', { command: 'ls' }))
  await settle()
  const classified = await store.listByVerb('tool.classified')
  expect(classified).toHaveLength(1)
  const args = (classified[0]!.patch as { intent: { args: { verdict: string } } }).intent.args
  expect(args.verdict).toBe('ask')
  // No tool.denied here — only when the OWNER decides (via Approvals) or
  // when policy is deny-tier.
  expect(await store.listByVerb('tool.denied')).toHaveLength(0)
  sync.stop()
  engine.close()
  store.close()
})

test('classify: deny-tier tool produces tool.classified(deny) AND tool.denied (pre-deny)', async () => {
  const { store, sync, engine } = setup()
  await admit(store, toolRequest('Bash', { command: 'rm -rf /tmp/x' }))
  await settle()
  const classified = await store.listByVerb('tool.classified')
  expect(classified).toHaveLength(1)
  const args = (classified[0]!.patch as { intent: { args: { verdict: string } } }).intent.args
  expect(args.verdict).toBe('deny')

  const denied = await store.listByVerb('tool.denied')
  expect(denied).toHaveLength(1)
  // The deny carries the policy reason for the audit trail.
  const denyArgs = (denied[0]!.patch as { intent: { args: { reason: string } } }).intent.args
  expect(denyArgs.reason).toBe('policy:deny-tier')
  sync.stop()
  engine.close()
  store.close()
})

test('classify: causal chain — tool.requested ← tool.classified ← (optional) tool.denied', async () => {
  const { store, sync, engine } = setup()
  const req = await admit(store, toolRequest('Bash', { command: 'sudo rm -rf /' }))
  await settle()
  const denied = (await store.listByVerb('tool.denied'))[0]!
  const classified = (await store.listByVerb('tool.classified'))[0]!
  expect(classified.caused_by).toEqual([req.interaction.hash])
  expect(denied.caused_by).toEqual([req.interaction.hash])
  sync.stop()
  engine.close()
  store.close()
})

test('classify: deny survives even when the agent mislabels the tool kind', async () => {
  // The classifyTool deny floor matches by literal in the subject — the
  // policy `Bash(rm -rf *)` blocks any tool whose subject contains "rm -rf"
  // at a command boundary. Synchronization passes the subject through
  // verbatim, so the floor holds.
  const { store, sync, engine } = setup()
  await admit(store, toolRequest('Edit', { command: 'rm -rf /' }))
  await settle()
  const classified = await store.listByVerb('tool.classified')
  expect(classified).toHaveLength(1)
  const args = (classified[0]!.patch as { intent: { args: { verdict: string } } }).intent.args
  expect(args.verdict).toBe('deny')
  sync.stop()
  engine.close()
  store.close()
})

test('classify: a different agent in the same channel can have a different policy', async () => {
  // Per-agent policies: bot1 has strict policy; bot2 has permissive.
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sync = new Synchronizer(store, engine)
  sync.register(
    classifyOnToolRequest({
      readPolicy: agentKey =>
        agentKey === 'bot1'
          ? { allow: [], ask: [], deny: ['Bash(*)'] }
          : { allow: ['Bash(*)'], ask: [], deny: [] },
    }),
  )
  sync.start()

  await admit(store, toolRequest('Bash', { command: 'ls' }, { actor: 'bot1' }))
  await admit(store, toolRequest('Bash', { command: 'ls' }, { actor: 'bot2' }))
  await settle()

  const classified = await store.listByVerb('tool.classified')
  expect(classified).toHaveLength(2)
  const verdicts = classified
    .map(c => ({
      verdict: (c.patch as { intent: { args: { verdict: string } } }).intent.args.verdict,
      // The causing tool.requested's actor identifies which agent.
      causingActor: classified.length > 0 ? c.caused_by[0] : undefined,
    }))
  // bot1 (deny) should produce one deny; bot2 (allow) one allow.
  const verdictSet = new Set(verdicts.map(v => v.verdict))
  expect(verdictSet).toEqual(new Set(['deny', 'allow']))
  sync.stop()
  engine.close()
  store.close()
})
