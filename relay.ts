#!/usr/bin/env bun
/**
 * relay.ts — multi-agent supervisor.
 *
 * Reads the v2 access file and spawns one AgentHost per configured agent.
 * Each AgentHost owns its own Discord bot identity, token, runtime, and rooms.
 * Add agents via `bun setup.ts agent add` or the /knock-knock:room skill.
 *
 * Start: bun relay.ts
 *
 * Legacy single-agent installs still work without any config changes:
 * readAccessFileV2 migrates the old {self, rooms} shape into a one-entry
 * agents map on read, using DISCORD_BOT_TOKEN / KNOCK_KNOCK_AGENT /
 * KNOCK_KNOCK_WORKSPACE from the environment.
 */

import { readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, readAccessFileV2 } from './state.ts'
import { AgentHost } from './agent-host.ts'

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

const access = readAccessFileV2()
const agentEntries = Object.entries(access.agents)

if (agentEntries.length === 0) {
  process.stderr.write(
    'relay: no agents configured.\n' +
      '  Run `bun setup.ts agent add` or `/knock-knock:room setup` in Claude Code first.\n',
  )
  process.exit(1)
}

const hosts: AgentHost[] = []

for (const [key, agent] of agentEntries) {
  const token = process.env[agent.tokenEnv]
  if (!token) {
    process.stderr.write(
      `relay: agent "${key}" skipped — ${agent.tokenEnv} is not set.\n` +
        `  Run \`bun setup.ts configure\` or add it to ${ENV_FILE}.\n`,
    )
    continue
  }
  if (!agent.workspace) {
    process.stderr.write(
      `relay: agent "${key}" skipped — workspace is not set.\n` +
        `  Run \`bun setup.ts agent add\` to configure it.\n`,
    )
    continue
  }

  const host = new AgentHost(key, agent, readAccessFileV2)
  hosts.push(host)
  void host.start(token).catch(err => {
    process.stderr.write(`relay [${key}]: login failed: ${err}\n`)
  })
}

if (hosts.length === 0) {
  process.stderr.write('relay: no agents could be started — check token env vars above.\n')
  process.exit(1)
}

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
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
