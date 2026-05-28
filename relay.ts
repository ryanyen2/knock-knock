#!/usr/bin/env bun
/**
 * relay.ts — multi-agent supervisor.
 *
 * Reads the access file and spawns one AgentHost per configured agent. Each
 * AgentHost owns its own Discord bot identity, token, runtime, and rooms.
 * Configure agents with `bun setup.ts`, then start with `bun relay.ts`.
 */

import { readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, readAccessFile } from './state.ts'
import { AgentHost } from './agent-host.ts'
import { ConsoleUI } from './console-ui.ts'
import { SqliteStore } from './ledger/store-sqlite.ts'
import { Ledger } from './ledger/capture.ts'
import { FoldEngine } from './ledger/fold.ts'
import { Synchronizer } from './ledger/sync.ts'
import { loopGuardFold } from './ledger/concepts/loop-guard.ts'
import { channelFold } from './ledger/concepts/channel.ts'
import { turnFold } from './ledger/concepts/turn.ts'
import { approvalFold } from './ledger/concepts/approval.ts'
import { classifyOnToolRequest } from './ledger/synchronizations/classify-on-tool-request.ts'

// ─── Load .env from state dir ─────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

// ─── Boot agents ──────────────────────────────────────────────────────────────

const access = readAccessFile()
const agentEntries = Object.entries(access.agents)

if (agentEntries.length === 0) {
  process.stderr.write('relay: no agents configured. Run `bun setup.ts` first.\n')
  process.exit(1)
}

const ui = new ConsoleUI()
const hosts: AgentHost[] = []
const bootEntries: Array<{ key: string; runtime: string; workspace: string }> = []

// One ledger + one fold engine shared across every agent on this machine.
// Phase 4 swaps SqliteStore for store-pg; nothing else changes.
const ledgerPath =
  process.env.KNOCK_KNOCK_LEDGER_FILE ?? join(STATE_DIR, 'ledger.sqlite')
const store = new SqliteStore(ledgerPath)
const ledger = new Ledger(store)
const engine = new FoldEngine(store)

// Bootstrap every concept's fold from existing ledger data before any host
// starts handling messages — `engine.get(name)` is synchronous after this.
await engine.register(loopGuardFold)
await engine.register(channelFold)
await engine.register(turnFold)
await engine.register(approvalFold)

// Synchronizations — behavior is one new file per synchronization (rubric #2).
// classify-on-tool-request audits every tool request against the room policy
// and journals the verdict so the dual-audience trail explains every block.
const synchronizer = new Synchronizer(store, engine)
synchronizer.register(classifyOnToolRequest())
synchronizer.start()

for (const [key, agent] of agentEntries) {
  const token = process.env[agent.tokenEnv]
  if (!token) {
    process.stderr.write(
      `relay: agent "${key}" skipped — ${agent.tokenEnv} is not set.\n` +
        `  Run \`bun setup.ts\` to save its bot token.\n`,
    )
    continue
  }
  if (!agent.workspace) {
    process.stderr.write(
      `relay: agent "${key}" skipped — workspace is not set.\n` +
        `  Run \`bun setup.ts\` to configure it.\n`,
    )
    continue
  }

  const host = new AgentHost(key, agent, readAccessFile, ui, ledger, engine)
  hosts.push(host)
  bootEntries.push({ key, runtime: agent.runtime, workspace: agent.workspace })
  void host.start(token).catch(err => {
    ui.error(key, `login failed: ${err}`)
  })
}

if (hosts.length === 0) {
  process.stderr.write('relay: no agents could be started — check token env vars above.\n')
  process.exit(1)
}

ui.banner(bootEntries)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  process.stderr.write(`relay: unhandled rejection: ${err}\n`)
})

process.on('uncaughtException', err => {
  process.stderr.write(`relay: uncaught exception: ${err}\n`)
})

async function shutdown(): Promise<void> {
  process.stderr.write('relay: shutting down\n')
  await Promise.all(hosts.map(h => h.stop()))
  synchronizer.stop()
  engine.close()
  store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
