#!/usr/bin/env bun
/**
 * relay.ts — multi-agent supervisor.
 *
 * Reads the access file and spawns one AgentHost per configured agent. Each
 * AgentHost owns its own bot identity, token, runtime, and rooms (the platform
 * — Discord/Slack/… — is the agent's MessagingAdapter).
 * Configure agents with `bun setup.ts`, then start with `bun relay.ts`.
 *
 * Start a subset instead of every agent:
 *   bun relay.ts <key> [<key> …]   start only the named agents (scriptable)
 *   bun relay.ts --pick            interactive multi-select (TTY only)
 * No args (non-interactive) starts all configured agents.
 *
 * Phase 3 architecture: the ledger drives the flow.
 *   Discord inbound → AgentHost gate → admit(channel.message)
 *   → prompt-on-message → admit(turn.prompted)
 *   → drive-turn → adapter.prompt → tool.X / turn.replied admissions
 *   → post-on-reply → Discord post (under external_claim)
 * Side-effect helpers (DmCourier, ack reaction) hang off store subscriptions
 * in AgentHost, not off the inline pipeline.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { join } from 'path'
import { multiselect, isCancel } from '@clack/prompts'
import { STATE_DIR, readAccessFile, readSettings } from './state.ts'
import { resolveLedgerConfig } from './lib.ts'
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
import { turnFold, TURN_FOLD, findTurnForInteraction, type TurnFoldState } from './ledger/concepts/turn.ts'
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
import { captureWorkspaceEdit } from './ledger/synchronizations/capture-workspace-edit.ts'
import { writeBackVersionable } from './ledger/synchronizations/write-back-versionable.ts'
import { applySupersession } from './ledger/synchronizations/apply-supersession.ts'
import { versionableFold } from './ledger/artifacts/versionable.ts'
import { watchFold } from './ledger/concepts/watch.ts'
import { configFold } from './ledger/concepts/config.ts'
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

// ─── Agent selection ────────────────────────────────────────────────────────
// Default: start every configured agent. Narrow it with positional keys (for
// scripts) or `--pick` for an interactive multi-select. Done before the heavy
// ledger/store boot so a cancel exits cheaply.
const argv = process.argv.slice(2)
const wantPick = argv.includes('--pick') || argv.includes('-p')
const requestedKeys = argv.filter(a => !a.startsWith('-'))

let selectedEntries = agentEntries
if (requestedKeys.length > 0) {
  const known = new Set(agentEntries.map(([k]) => k))
  for (const k of requestedKeys) {
    if (!known.has(k)) {
      process.stderr.write(`relay: unknown agent "${k}" — ignoring (run \`bun setup.ts\` to list agents).\n`)
    }
  }
  selectedEntries = agentEntries.filter(([k]) => requestedKeys.includes(k))
} else if (wantPick) {
  if (!process.stdin.isTTY) {
    process.stderr.write('relay: --pick needs an interactive terminal; starting all agents.\n')
  } else {
    const picked = await multiselect({
      message: 'Which agents should this relay start? (space to toggle, enter to confirm)',
      options: agentEntries.map(([k, a]) => ({
        value: k,
        label: k,
        hint: `${a.platform ?? 'discord'} · ${a.runtime}`,
      })),
      initialValues: agentEntries.map(([k]) => k),
      required: true,
    })
    if (isCancel(picked)) {
      process.stderr.write('relay: cancelled.\n')
      process.exit(0)
    }
    const set = new Set(picked as string[])
    selectedEntries = agentEntries.filter(([k]) => set.has(k))
  }
}

if (selectedEntries.length === 0) {
  process.stderr.write('relay: no agents selected — nothing to start.\n')
  process.exit(1)
}
if (selectedEntries.length !== agentEntries.length) {
  process.stderr.write(
    `relay: starting ${selectedEntries.length}/${agentEntries.length} agents: ` +
      `${selectedEntries.map(([k]) => k).join(', ')}\n`,
  )
}

const ui = new ConsoleUI()
const hosts: AgentHost[] = []
const bootEntries: Array<{ key: string; runtime: string; workspace: string }> = []

// One ledger + one fold engine shared across every agent on this machine.
// Backend is setup-managed (settings.json) with KNOCK_KNOCK_LEDGER_URL as an
// env override; Postgres is the cross-machine collaboration backend.
const ledgerConfig = resolveLedgerConfig(process.env, readSettings())
let store: Store
if (ledgerConfig.backend === 'postgres') {
  try {
    store = await PgStore.connect(ledgerConfig.url)
  } catch (err) {
    // Refuse to silently fall back to SQLite — that would split the shared
    // history across machines, which is worse than failing loudly.
    process.stderr.write(
      `relay: FATAL — could not connect to the Postgres ledger: ${err}\n` +
        `  Backend is set to postgres (settings.json or KNOCK_KNOCK_LEDGER_URL).\n` +
        `  Not starting on local SQLite. Fix the connection or run \`bun setup.ts\`\n` +
        `  and choose the local backend.\n`,
    )
    process.exit(1)
  }
  process.stderr.write(
    `relay: ledger = postgres (${ledgerConfig.url.replace(/:[^:@]+@/, ':***@')})\n`,
  )
} else {
  const ledgerPath = ledgerConfig.file ?? join(STATE_DIR, 'ledger.sqlite')
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
await engine.register(versionableFold) // file-edit convergence (write-back reads this)
await engine.register(configFold) // per-channel config overlay (owner !config edits)

// Create AgentHosts (each builds its messaging adapter; not yet connected).
for (const [key, agent] of selectedEntries) {
  // iMessage is local (no token) — it authenticates via macOS permissions, not a
  // bot token, so don't gate it on a token env var.
  const tokenless = agent.platform === 'imessage'
  const token = process.env[agent.tokenEnv]
  if (!token && !tokenless) {
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
synchronizer.register(
  classifyOnToolRequest({
    // Permission profiles are keyed by ROOM (the parent channel); a tool
    // request's channel is the task SCOPE (a thread). Resolve scope→room via
    // the serving host so a threaded turn classifies against the same floor as
    // a top-level one — and apply the thread's permission `mode` so a loosened
    // thread's audit classification matches enforcement (without it the audit
    // would under-report allows). No serving host ⇒ empty profile here, but this
    // sync is audit only — the enforced deny floor is the adapter's applyPolicy.
    readPolicy: (agentKey, scopeId) => {
      for (const h of hosts) {
        const p = h.auditProfileForScope(agentKey, scopeId)
        if (p) return p
      }
      return { allow: [], ask: [], deny: [] }
    },
  }),
)
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
    maxMessageLength: channelId =>
      hosts.find(h => h.getAgentForChannel(channelId))?.maxMessageLength,
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
// A unique id for THIS relay process, used as a claim holder so cross-relay
// side effects (conflict-card posts) are performed by exactly one relay.
const relayId = `relay-${process.pid}-${Date.now()}`
synchronizer.register(
  conflictCard({
    relayId,
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
synchronizer.register(resumeOnWatch({ relayId }))
// Local-first cross-machine convergence: a peer re-derives a supersession from
// the winner's immutable `supersedes` op (which crosses NOTIFY), since the
// loser's lifecycle UPDATE does not. INSERT-driven, like AOCM.
synchronizer.register(applySupersession())
// File-edit sync: capture Edit/Write tool runs as workspace.edit (merge gate),
// then project + write the merged file back to disk under a per-file claim so
// relays sharing one Postgres ledger converge without Discord conversation.
synchronizer.register(
  captureWorkspaceEdit({
    relativize: (scope, absPath) => {
      for (const h of hosts) {
        const rel = h.relativizeWorkspacePath(scope, absPath)
        if (rel) return rel
      }
      return undefined
    },
  }),
)
synchronizer.register(
  writeBackVersionable({
    resolvePath: artifactId => {
      for (const h of hosts) {
        const abs = h.resolveVersionablePath(artifactId)
        if (abs) return abs
      }
      return undefined
    },
    readFile: async absPath => {
      try {
        return readFileSync(absPath, 'utf8')
      } catch {
        return undefined
      }
    },
    writeFile: async (absPath, content) => {
      // Atomic temp+rename within the same directory (same pattern as state.ts).
      const tmp = `${absPath}.knock-tmp-${process.pid}`
      writeFileSync(tmp, content)
      renameSync(tmp, absPath)
    },
  }),
)
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
  relayId,
})
watchSupervisor.start()

// §4.1 now-working Workbench — one message PER TURN (per agent-tag "call"),
// refreshed as the turn runs (start, each tool step, end) and left as a trace.
// Driven at relay level (not per-host) from the shared Turn fold: resolve the
// turn each event belongs to, then refresh that turn's board. AgentHost throttles
// the Discord edits. The board is no longer pinned — the ConfigCard owns the pin.
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
  if (!host) return
  let promptHash: string | undefined
  try {
    promptHash = findTurnForInteraction(engine.get<TurnFoldState>(TURN_FOLD), i)
  } catch {
    promptHash = undefined
  }
  if (promptHash) host.updateWorkbench(i.channel, promptHash)
})

// Now connect each host's messaging adapter — messages will start flowing into
// the ledger-driven pipeline.
for (let n = 0; n < hosts.length; n++) {
  const entry = bootEntries[n]!
  const host = hosts[n]!
  // Experimental (walking-skeleton) platforms are opt-in and not live-certified;
  // surface that loudly at boot so a non-Discord agent never looks production-ready.
  if (host.experimental) {
    ui.error(
      entry.key,
      `${access.agents[entry.key]!.platform ?? 'discord'} is an experimental adapter (not live-certified) — verify it before relying on it.`,
    )
  }
  // Token-less platforms (iMessage) pass an empty string; their adapter ignores it.
  const token = process.env[access.agents[entry.key]!.tokenEnv] ?? ''
  void host.start(token).catch(err => {
    const msg = String(err)
    // A process-global resource conflict (e.g. two webhook adapters on one port)
    // surfaces as EADDRINUSE; name it so it isn't mistaken for a credential error.
    const hint = /EADDRINUSE|address already in use/i.test(msg)
      ? ' — a port is already in use (two webhook/DB adapters can\'t share one port; give each agent its own)'
      : ''
    ui.error(entry.key, `login failed: ${err}${hint}`)
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
