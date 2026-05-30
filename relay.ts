#!/usr/bin/env bun
/**
 * relay.ts — multi-agent supervisor.
 *
 * Reads the access file and spawns one AgentHost per configured agent. Each
 * AgentHost owns its own Discord bot identity, token, runtime, and rooms.
 * Configure agents with `bun setup.ts`, then start with `bun relay.ts`.
 *
 * Phase 3 architecture: the ledger drives the flow.
 *   Discord inbound → AgentHost gate → admit(channel.message)
 *   → prompt-on-message → admit(turn.prompted)
 *   → drive-turn → adapter.prompt → tool.X / turn.replied admissions
 *   → post-on-reply → Discord post (under external_claim)
 * Side-effect helpers (DmCourier, ack reaction) hang off store subscriptions
 * in AgentHost, not off the inline pipeline.
 */

import { readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, readAccessFile } from './state.ts'
import { AgentHost } from './agent-host.ts'
import { ConsoleUI } from './console-ui.ts'
import { SqliteStore } from './ledger/store-sqlite.ts'
import { PgStore } from './ledger/store-pg.ts'
import type { Store } from './ledger/store.ts'
import { Ledger } from './ledger/capture.ts'
import { FoldEngine } from './ledger/fold.ts'
import { Synchronizer } from './ledger/sync.ts'
import { bootstrap } from './ledger/bootstrap.ts'
import { loopGuardFold } from './ledger/concepts/loop-guard.ts'
import { channelFold } from './ledger/concepts/channel.ts'
import { turnFold } from './ledger/concepts/turn.ts'
import { approvalFold } from './ledger/concepts/approval.ts'
import { knowledgeFold } from './ledger/artifacts/knowledge.ts'
import { classifyOnToolRequest } from './ledger/synchronizations/classify-on-tool-request.ts'
import { promptOnMessage } from './ledger/synchronizations/prompt-on-message.ts'
import { driveTurn } from './ledger/synchronizations/drive-turn.ts'
import { postOnReply } from './ledger/synchronizations/post-on-reply.ts'
import { dmOnSupersede } from './ledger/synchronizations/dm-on-supersede.ts'
import { conflictCard } from './ledger/synchronizations/conflict-card.ts'
import { retryOnReaction } from './ledger/synchronizations/retry-on-reaction.ts'
import { resumeOnWatch } from './ledger/synchronizations/resume-on-watch.ts'
import { watchFold } from './ledger/concepts/watch.ts'
import { WatchSupervisor, bunSpawn } from './watch-supervisor.ts'

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
// Phase 4: KNOCK_KNOCK_LEDGER_URL switches to Postgres for cross-machine.
const pgUrl = process.env.KNOCK_KNOCK_LEDGER_URL
let store: Store
if (pgUrl) {
  store = await PgStore.connect(pgUrl)
  process.stderr.write(`relay: ledger = postgres (${pgUrl.replace(/:[^:@]+@/, ':***@')})\n`)
} else {
  const ledgerPath =
    process.env.KNOCK_KNOCK_LEDGER_FILE ?? join(STATE_DIR, 'ledger.sqlite')
  store = new SqliteStore(ledgerPath)
  process.stderr.write(`relay: ledger = sqlite (${ledgerPath})\n`)
}
const bootResult = await bootstrap(store)
if (bootResult.hasExistingData) {
  process.stderr.write(`relay: replaying ${bootResult.scanned} interactions from existing ledger\n`)
}
const ledger = new Ledger(store)
const engine = new FoldEngine(store)

// Bootstrap every concept's fold from existing ledger data before any host
// starts handling messages — `engine.get(name)` is synchronous after this.
await engine.register(loopGuardFold)
await engine.register(channelFold)
await engine.register(turnFold)
await engine.register(approvalFold)
await engine.register(knowledgeFold) // §4.6 stale-note flag reads this at reply time
await engine.register(watchFold) // deferred-continuation primitive (docs/knock-knock-watches.md)

// Create AgentHosts (Discord clients not yet connected).
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

  const host = new AgentHost(key, agent, readAccessFile, ui, ledger, store, engine)
  hosts.push(host)
  bootEntries.push({ key, runtime: agent.runtime, workspace: agent.workspace })
}

if (hosts.length === 0) {
  process.stderr.write('relay: no agents could be started — check token env vars above.\n')
  process.exit(1)
}

// Synchronizations — behavior is one new file per synchronization (rubric #2).
// The host-dependent ones close over the hosts array; the first host that
// claims a channel handles it.
const synchronizer = new Synchronizer(store, engine)
synchronizer.register(classifyOnToolRequest())
synchronizer.register(
  promptOnMessage({
    getAgentForChannel: channelId => {
      for (const h of hosts) {
        const r = h.getAgentForChannel(channelId)
        if (r) return r
      }
      return undefined
    },
  }),
)
synchronizer.register(
  driveTurn({
    getDriveHandle: channelId => {
      for (const h of hosts) {
        const handle = h.getDriveHandle(channelId)
        if (handle) return handle
      }
      return undefined
    },
    getByHash: hash => store.getByHash(hash),
  }),
)
synchronizer.register(
  postOnReply({
    discordSend: async (channelId, text) => {
      for (const h of hosts) {
        if (h.getAgentForChannel(channelId)) {
          return h.discordSend(channelId, text)
        }
      }
      return undefined
    },
  }),
)
synchronizer.register(
  dmOnSupersede({
    getOwnerForAgent: agentKey => access.agents[agentKey]?.ownerUserId,
    dmSend: async (userId, text) => {
      // Any connected host can deliver the DM; use the first.
      for (const h of hosts) {
        const id = await h.dmUser(userId, text)
        if (id) return id
      }
      return undefined
    },
  }),
)
synchronizer.register(
  conflictCard({
    getOwnerForChannel: channelId => {
      for (const h of hosts) {
        const o = h.getOwnerForChannel(channelId)
        if (o) return o
      }
      return undefined
    },
    postCard: async post => {
      for (const h of hosts) {
        if (h.getAgentForChannel(post.channelId)) {
          await h.postConflictCard(post)
          return
        }
      }
    },
  }),
)
synchronizer.register(retryOnReaction())
synchronizer.register(resumeOnWatch())
synchronizer.start()

// WatchSupervisor — owns the OS processes behind armed watches and admits a
// watch.fired when a watch's output gate matches; resume-on-watch turns that
// into an agent turn. It reconciles against the watch fold, so watches armed
// before this boot are re-armed on the initial subscribe.
const watchSupervisor = new WatchSupervisor({
  store,
  engine,
  resolve: spec => {
    for (const h of hosts) {
      const env = h.resolveWatch(spec)
      if (env) return env
    }
    return undefined
  },
  spawn: bunSpawn,
  log: msg => ui.note('watch', msg),
})
watchSupervisor.start()

// §4.1 now-working Workbench — one pinned message per channel, refreshed as the
// turn runs (start, each tool step, end). Driven at relay level (not per-host)
// so a channel served by several agents still gets a single board, rendered
// from the shared Turn fold. AgentHost.updatePill throttles the Discord edits.
const PILL_VERBS = new Set([
  'turn.prompted',
  'turn.replied',
  'tool.requested',
  'tool.approved',
  'tool.denied',
  'tool.executed',
])
store.subscribe(i => {
  if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return
  if (!PILL_VERBS.has(i.verb)) return
  const host = hosts.find(h => h.getAgentForChannel(i.channel))
  host?.updatePill(i.channel)
})

// Now connect the Discord clients — messages will start flowing into the
// ledger-driven pipeline.
for (let n = 0; n < hosts.length; n++) {
  const entry = bootEntries[n]!
  const token = process.env[access.agents[entry.key]!.tokenEnv]!
  void hosts[n]!.start(token).catch(err => {
    ui.error(entry.key, `login failed: ${err}`)
  })
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
