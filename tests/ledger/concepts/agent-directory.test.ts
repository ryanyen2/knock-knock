/**
 * Agent-directory fold — bots publish their platform identity (`agent.identity`,
 * anchor `none` ⇒ admitted applied, INSERT-only) and every relay folds the same
 * directory. Mirrors config.test.ts: two FoldEngines over one SqliteStore stand in
 * for Postgres LISTEN/NOTIFY, so this also exercises cross-machine convergence.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../../src/ledger/fold.ts'
import { admit } from '../../../src/ledger/admit.ts'
import {
  AGENT_DIRECTORY_FOLD,
  agentDirectoryFold,
  dirArtifact,
  directoryFor,
  type AgentDirectoryFoldState,
} from '../../../src/ledger/concepts/agent-directory.ts'
import type { AgentIdentity, ProposedInteraction } from '../../../src/ledger/interaction.ts'

function identity(data: AgentIdentity): ProposedInteraction {
  return {
    actor: data.agentKey,
    role: 'agent',
    channel: 'agent-directory',
    target: { artifactId: dirArtifact(data.agentKey), anchor: { kind: 'none' } },
    verb: 'agent.identity',
    patch: { kind: 'identity', data },
    effect: 'pure',
    caused_by: [],
  }
}

const tick = () => new Promise(r => setTimeout(r, 2))

async function setup() {
  const store = new SqliteStore(':memory:')
  const engineA = new FoldEngine(store)
  const engineB = new FoldEngine(store)
  await engineA.register(agentDirectoryFold)
  await engineB.register(agentDirectoryFold)
  return { store, engineA, engineB }
}

test('agent-directory: an identity published on one machine is visible on the other', async () => {
  const { store, engineB } = await setup()
  const r = await admit(store, identity({ agentKey: 'cc', platform: 'discord', userId: 'U_CC', label: 'cc', rooms: ['chan1'] }))
  expect(r.kind).toBe('admitted')
  await tick()
  const dir = directoryFor(engineB.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
  expect(dir.map(d => d.userId)).toEqual(['U_CC'])
})

test('agent-directory: two bots both appear; re-publish supersedes by last-writer-wins', async () => {
  const { store, engineA } = await setup()
  await admit(store, identity({ agentKey: 'cc', platform: 'discord', userId: 'U_CC', rooms: ['chan1'] }))
  await admit(store, identity({ agentKey: 'd-bot', platform: 'discord', userId: 'U_D', rooms: ['chan1'] }))
  await tick()
  let dir = directoryFor(engineA.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
  expect(new Set(dir.map(d => d.agentKey))).toEqual(new Set(['cc', 'd-bot']))

  // cc reconnects with an extra room — LWW keeps one entry per agentKey, the latest.
  await admit(store, identity({ agentKey: 'cc', platform: 'discord', userId: 'U_CC', rooms: ['chan1', 'chan2'] }))
  await tick()
  dir = directoryFor(engineA.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
  const cc = dir.find(d => d.agentKey === 'cc')!
  expect(dir.filter(d => d.agentKey === 'cc').length).toBe(1)
  expect(cc.rooms).toEqual(['chan1', 'chan2'])
})
