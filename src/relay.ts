#!/usr/bin/env bun
/**
 * relay.ts — multi-agent supervisor. Spawns one AgentHost per configured agent;
 * the ledger drives the inbound→prompt→drive→post flow.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { join } from 'path'
import { multiselect, isCancel } from '@clack/prompts'
import { STATE_DIR, readAccessFile, readSettings } from './state.ts'
import {
  resolveLedgerConfig,
  responderElection,
  addressedAgentKeys,
  selectActorHost,
  declaresPeerCollaborators,
} from './lib.ts'
import { AgentHost } from './agent-host.ts'
import { ConsoleUI } from './console-ui.ts'
import type { RelayUI } from './console-ui.ts'
import { PaneTUI } from './tui.ts'
import { gatherQuickConfig, applyQuickConfig, type QuickConfig } from './relay-startup.ts'
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
import { replyClaim } from './ledger/synchronizations/reply-claim.ts'
import { capturePresence } from './ledger/synchronizations/capture-presence.ts'
import { driveTurn } from './ledger/synchronizations/drive-turn.ts'
import { postOnReply } from './ledger/synchronizations/post-on-reply.ts'
import { dmOnSupersede } from './ledger/synchronizations/dm-on-supersede.ts'
import { conflictCard } from './ledger/synchronizations/conflict-card.ts'
import { retryOnReaction } from './ledger/synchronizations/retry-on-reaction.ts'
import { resumeOnWatch } from './ledger/synchronizations/resume-on-watch.ts'
import { captureWorkspaceEdit } from './ledger/synchronizations/capture-workspace-edit.ts'
import { ingestAttachment } from './ledger/synchronizations/ingest-attachment.ts'
import { shareFile } from './ledger/synchronizations/share-file.ts'
import { writeBackVersionable } from './ledger/synchronizations/write-back-versionable.ts'
import { applySupersession } from './ledger/synchronizations/apply-supersession.ts'
import { versionableFold } from './ledger/artifacts/versionable.ts'
import { watchFold } from './ledger/concepts/watch.ts'
import { configFold, CONFIG_FOLD, resolveConfigFor, type ConfigFoldState } from './ledger/concepts/config.ts'
import { coordBoardFold, boardFor, COORD_BOARD_FOLD, type CoordBoardFoldState } from './ledger/concepts/coordination-board.ts'
import { agentDirectoryFold, directoryFor, AGENT_DIRECTORY_FOLD, type AgentDirectoryFoldState } from './ledger/concepts/agent-directory.ts'
import { taskDagFold, TASK_DAG_FOLD, taskArtifact, type TaskDagFoldState } from './ledger/concepts/task-dag.ts'
import { taskScheduler, scheduleScope, type TaskSchedulerOpts } from './ledger/synchronizations/task-scheduler.ts'
import { completeTaskOnTurn } from './ledger/synchronizations/complete-task-on-turn.ts'
import { admit } from './ledger/admit.ts'
import { WatchSupervisor, bunSpawn } from './watch-supervisor.ts'
import {
  startWebhookReceiver,
  DEFAULT_WEBHOOK_PORT,
  type WebhookReceiverHandle,
} from './webhook-receiver.ts'

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
  process.stderr.write('relay: no agents configured. Run `knock-knock setup` first.\n')
  process.exit(1)
}

// ─── Agent selection ────────────────────────────────────────────────────────
// Default: all agents. Narrow with positional keys or `--pick`.
const argv = process.argv.slice(2)
const wantPick = argv.includes('--pick') || argv.includes('-p')
const wantTui = argv.includes('--tui')
const wantConfig = argv.includes('--config') || argv.includes('-c')
// Daemon mode: connect EVERY credentialed bot (so all can hear), but only the picked
// ones are active (have a pane). The rest start idle and wake on their first message.
const wantDaemon = argv.includes('--daemon') || argv.includes('--wake')
const requestedKeys = argv.filter(a => !a.startsWith('-'))

let selectedEntries = agentEntries
if (requestedKeys.length > 0) {
  const known = new Set(agentEntries.map(([k]) => k))
  for (const k of requestedKeys) {
    if (!known.has(k)) {
      process.stderr.write(`relay: unknown agent "${k}" — ignoring (run \`knock-knock setup\` to list agents).\n`)
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

// Optional per-bot quick config (coding agent / model / thinking / effort / sessions),
// gathered interactively NOW (clack) — before any TUI takes the screen — and applied to
// the ledger after the folds are live (below). Offered with `--pick`, `--config`/`-c`.
const quickConfig: Map<string, QuickConfig> =
  (wantPick || wantConfig) && process.stdin.isTTY
    ? await gatherQuickConfig(selectedEntries)
    : new Map()

// Renderer seam: the multi-pane TUI (one pane per bot) on an interactive TTY with
// `--tui`, else the single-stream console (also the CI / piped fallback).
const useTui = wantTui && !!process.stdout.isTTY
const ui: RelayUI = useTui ? new PaneTUI() : new ConsoleUI()
const paneTui = useTui ? (ui as PaneTUI) : undefined
const hosts: AgentHost[] = []
const bootEntries: Array<{ key: string; runtime: string; workspace: string; idle?: boolean }> = []

// One ledger + one fold engine shared across every agent on this machine.
const ledgerConfig = resolveLedgerConfig(process.env, readSettings())
let store: Store
if (ledgerConfig.backend === 'postgres') {
  try {
    store = await PgStore.connect(ledgerConfig.url)
  } catch (err) {
    // Refuse to fall back to SQLite — would split shared history across machines.
    process.stderr.write(
      `relay: FATAL — could not connect to the Postgres ledger: ${err}\n` +
        `  Backend is set to postgres (settings.json or KNOCK_KNOCK_LEDGER_URL).\n` +
        `  Not starting on local SQLite. Fix the connection or run \`knock-knock setup\`\n` +
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

// No-Postgres cross-machine coordination: when the backend is local SQLite and mesh is
// explicitly enabled, bots coordinate over the shared messaging channel via deterministic
// election (no atomic lock, no NOTIFY). Never on Postgres — its atomic claim + NOTIFY are
// strictly better. See docs/how-coordination-works.md.
// Mesh auto-enables on SQLite the moment a peer-bot collaborator (another machine's bot) is
// configured — that's the cross-machine intent, so the user shouldn't have to remember an env
// var. KNOCK_KNOCK_MESH stays an explicit override: `1` forces it on (e.g. before any peer is
// rostered), `0` forces it off. Never on Postgres (its atomic claim + NOTIFY are strictly better).
const meshEnv = process.env.KNOCK_KNOCK_MESH
const hasPeers = declaresPeerCollaborators(access.agents)
const meshEnabled =
  ledgerConfig.backend === 'sqlite' && meshEnv !== '0' && (meshEnv === '1' || hasPeers)
if (meshEnabled) {
  const why = meshEnv === '1' ? 'KNOCK_KNOCK_MESH=1' : 'peer-bot collaborators configured'
  process.stderr.write(
    `relay: mesh = ON (${why}) — no-Postgres cross-machine coordination over the messaging channel\n`,
  )
  const hasTransportChannel = Object.values(access.agents).some(a =>
    Object.values(a.rooms).some(r => r.meshTransport),
  )
  if (!hasTransportChannel) {
    process.stderr.write(
      'relay: no mesh-transport channel configured — ⟦kk-mesh⟧ lines (incl. discovery beacons)\n' +
        '  post to the human channels. To keep them out of view, add a dedicated transport channel:\n' +
        "  run `knock-knock setup` → Add channel → answer yes to \"dedicated mesh-transport channel\",\n" +
        '  and add the SAME channel on every machine. See docs/how-coordination-works.md.\n',
    )
  }
} else if (ledgerConfig.backend === 'sqlite' && hasPeers && meshEnv === '0') {
  // Peer bots are configured (cross-machine intent) but mesh was explicitly turned off. A peer's
  // messages are then heard only where it's manually rostered, and the shared directory/board
  // never converges across machines — which looks exactly like "the other machine's bot just
  // doesn't respond." Say it out loud rather than failing silently.
  process.stderr.write(
    'relay: KNOCK_KNOCK_MESH=0 but peer-bot collaborators are configured — cross-machine coordination is OFF.\n' +
      '  Unset KNOCK_KNOCK_MESH (mesh auto-enables on SQLite when peers are configured), or switch to Postgres.\n',
  )
}
const ledger = new Ledger(store)
const engine = new FoldEngine(store)

// Bootstrap every fold before any host handles messages — `engine.get` is then synchronous.
await engine.register(loopGuardFold)
await engine.register(channelFold)
await engine.register(turnFold)
await engine.register(approvalFold)
await engine.register(knowledgeFold)
await engine.register(watchFold)
await engine.register(versionableFold)
await engine.register(configFold)
await engine.register(coordBoardFold)
await engine.register(taskDagFold)
await engine.register(agentDirectoryFold)

// Apply any startup quick config now that the folds are live and before the hosts
// connect — so the first turn already resolves the seeded model/agent/etc.
await applyQuickConfig(store, engine, access, quickConfig, msg => process.stderr.write(`relay: ${msg}\n`))

// In daemon mode, boot EVERY configured bot (so idle ones can still hear messages);
// otherwise only the selected set. The picked set is always "active"; in daemon mode
// the rest start idle. Idle still requires credentials — an unconfigured bot can't listen.
const activeKeys = new Set(selectedEntries.map(([k]) => k))
const bootSource = wantDaemon ? agentEntries : selectedEntries

// A woken idle bot: promote its UI to an active pane (the session is created lazily by
// the turn the wake message drives). Quiet by design — no chat message.
const onWake = (key: string): void => {
  if (paneTui) paneTui.activate(key, access.agents[key]?.runtime)
  else ui.note(key, 'woke on message (idle → active)')
}

// Create AgentHosts (each builds its messaging adapter; not yet connected).
for (const [key, agent] of bootSource) {
  const token = process.env[agent.tokenEnv]
  if (!token) {
    process.stderr.write(
      `relay: agent "${key}" skipped — ${agent.tokenEnv} is not set.\n` +
        `  Run \`knock-knock setup\` to save its bot token.\n`,
    )
    continue
  }
  if (Object.keys(agent.rooms).length === 0) {
    process.stderr.write(
      `relay: bot "${key}" skipped — it isn't a member of any channel, so it has\n` +
        `  nothing to listen to. Add it to a channel with \`knock-knock setup\`.\n`,
    )
    continue
  }
  if (!agent.workspace) {
    process.stderr.write(
      `relay: bot "${key}" skipped — no workspace folder set for its channels.\n` +
        `  Run \`knock-knock setup\` → add/edit channel to set one.\n`,
    )
    continue
  }

  const host = new AgentHost(key, agent, readAccessFile, ui, ledger, store, engine)
  // Lazy: by the time the mesh consults it (post-connect), every host exists, so the
  // set is the relay's full roster of co-resident bots. A directory entry outside it is
  // a genuine remote peer — the only case where mesh gossip over the channel is useful.
  if (meshEnabled) host.enableMesh(() => new Set(hosts.map(h => h.botKey)))
  // Idle iff daemon mode AND not in the picked/active set.
  if (wantDaemon && !activeKeys.has(key)) host.setIdle()
  host.onWake = onWake
  hosts.push(host)
  bootEntries.push({ key, runtime: agent.runtime, workspace: agent.workspace, idle: !host.isActive })
}

if (hosts.length === 0) {
  process.stderr.write('relay: no agents could be started — check token env vars above.\n')
  process.exit(1)
}

// ─── Who's listening where ──────────────────────────────────────────────────
// Print every started bot → channels it serves; flag channels claimed by >1 bot.
{
  const lines: string[] = ['relay: listening —']
  const claimants = new Map<string, string[]>() // channelId → bot keys
  for (const { key, idle } of bootEntries) {
    const agent = access.agents[key]
    if (!agent) continue
    const rooms = Object.entries(agent.rooms)
    const stateNote = idle ? '  ·  idle (wakes on message)' : ''
    lines.push(`  ${idle ? '○' : '●'} ${key}  ·  ${agent.platform ?? 'discord'}  ·  ${agent.runtime} (default)${stateNote}`)
    if (rooms.length === 0) lines.push('      (no channels — add one with `knock-knock setup`)')
    for (const [channelId, room] of rooms) {
      const agentNote = room.runtime && room.runtime !== agent.runtime ? `  [${room.runtime}]` : ''
      lines.push(
        `      #${channelId}  →  ${room.workspace ?? agent.workspace}${agentNote}` +
          (room.requireMention ? '  (@mention required)' : ''),
      )
      claimants.set(channelId, [...(claimants.get(channelId) ?? []), key])
    }
  }
  for (const [channelId, bots] of claimants) {
    if (bots.length > 1) {
      lines.push(
        `  ⚠ channel #${channelId} has ${bots.length} bots (${bots.join(', ')}); ` +
          `@mention each by name. Without require-mention, all of them respond.`,
      )
    }
  }
  process.stderr.write(lines.join('\n') + '\n')
}

// Synchronizations — one behavior per file. Host-dependent ones close over the
// hosts array; the first host that claims a channel handles it.
const synchronizer = new Synchronizer(store, engine)
synchronizer.register(
  classifyOnToolRequest({
    // Profiles are room-keyed; resolve scope→room so a threaded turn classifies
    // against the same floor. Audit only — the enforced floor is applyPolicy.
    readPolicy: (agentKey, scopeId) => {
      for (const h of hosts) {
        const p = h.auditProfileForScope(agentKey, scopeId)
        if (p) return p
      }
      return { allow: [], ask: [], deny: [] }
    },
  }),
)
// Registered BEFORE reply-claim ON PURPOSE: subs fire sequentially and are
// awaited, so attachments are recorded as file.received before the turn is
// prompted — the same turn the file rode in on can see it.
synchronizer.register(
  ingestAttachment({
    filesInbound: scope => {
      for (const h of hosts) {
        const cap = h.inboundFileCap(scope)
        if (cap) return cap
      }
      return undefined
    },
    loadAttachments: (scope, hash) => {
      for (const h of hosts) {
        if (!h.inboundFileCap(scope)) continue
        const atts = h.loadInboundAttachments(hash)
        if (atts.length) return atts
      }
      return []
    },
    download: async (scope, att) => {
      for (const h of hosts) {
        if (!h.inboundFileCap(scope)) continue
        return h.downloadInboundAttachment(att)
      }
      return undefined
    },
    materialize: async (scope, safeName, bytes) => {
      for (const h of hosts) {
        const rel = await h.materializeAttachment(scope, safeName, bytes)
        if (rel) return rel
      }
      return undefined
    },
    note: (scope, text) => {
      for (const h of hosts) {
        if (h.inboundFileCap(scope)) {
          h.noteToScope(scope, text)
          return
        }
      }
    },
  }),
)
// Unique id for THIS relay process — a claim holder so cross-relay side effects
// (reply drive-election, conflict-card posts) are performed by exactly one relay.
const relayId = `relay-${process.pid}-${Date.now()}`
synchronizer.register(
  replyClaim({
    // Resolve the local agent + policy context for a channel.message. Prefer the
    // addressed bot; fall back to the first serving host. Undefined ⇒ the message
    // is for an agent that runs on another relay (we stand down).
    resolveCoord: (channelId, targetAgent) => {
      let host: AgentHost | undefined
      let info: ReturnType<AgentHost['getAgentForChannel']>
      for (const h of hosts) {
        const r = h.getAgentForChannel(channelId)
        if (!r) continue
        if (targetAgent && r.agentKey === targetAgent) {
          host = h
          info = r
          break
        }
        if (!targetAgent && !host) {
          host = h
          info = r
        }
      }
      // A message addressed to a SPECIFIC agent this relay does not run → stand
      // down; never let a different local bot answer in its place (the addressed
      // bot replies on its own relay). Only the no-target broadcast case falls
      // back to a local serving host.
      if (!host || !info) return undefined
      const roomId = host.roomForScope(channelId)
      if (!roomId) return undefined
      const cfgState = engine.get<ConfigFoldState>(CONFIG_FOLD)
      const cfg = resolveConfigFor(cfgState, roomId, channelId)
      // Locally-run agents are the owner's own bots (peer agents fire reply-claim
      // on their own owners' relays); role-priority bites across relays.
      const isOwnerBot = !!access.agents[info.agentKey]?.ownerUserId
      return { agentKey: info.agentKey, loopGuardOpts: info.loopGuardOpts, isOwnerBot, cfg, relayId }
    },
    // Directed-message routing (every backend, not mesh-only): the bots EXPLICITLY
    // @mentioned in this message, from the shared directory. When a user names specific
    // bots ("@cc and @d-bot, one does X one does Y"), each answers its own part and an
    // unnamed bot stays out — instead of all named bots racing for one reply.
    resolveAddressing: (channel, _messageId, text) => {
      const host = hosts.find(h => h.roomForScope(channel))
      const roomId = host?.roomForScope(channel)
      if (!host || !roomId) return []
      return addressedAgentKeys(directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD)), roomId, host.platform, text)
    },
    // Mesh mode only: deterministic election over the shared directory replaces the
    // same-machine-only atomic reply claim, so two laptops take turns without Postgres.
    ...(meshEnabled
      ? {
          election: {
            // This agent's failover rank (0 = elected winner) for the message, computed
            // identically on every machine from the mesh-synced directory + message text.
            rankFor: (channel, messageId, text, selfAgentKey) => {
              const host = hosts.find(h => h.botKey === selfAgentKey)
              const roomId = host?.roomForScope(channel)
              if (!host || !roomId) return undefined
              const directory = directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
              const order = responderElection(directory, roomId, host.platform, text, messageId)
              const rank = order.indexOf(selfAgentKey)
              return rank < 0 ? undefined : rank
            },
            // A peer's designation (mesh-synced onto the board) for this message → stand down.
            alreadyDesignated: (channel, messageId, selfAgentKey) =>
              boardFor(engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), channel).responders.some(
                r => r.ref === messageId && r.agentKey !== selfAgentKey,
              ),
          },
        }
      : {}),
  }),
)
// Presence capture: turn.prompted/turn.replied → coordination-board notes.
synchronizer.register(capturePresence())
// Task scheduler: claim/assign ready tasks (pull/push/bid), wake the owner, fail over.
const schedulerOpts: TaskSchedulerOpts = {
  // Return ALL co-resident bots that serve the scope — each bot must be able to claim
  // its own tasks independently. With a single context, only the first bot in array
  // order could ever claim (the same "first-serving-host" bug as "@cc → d-bot answers").
  resolveSchedule: scope => {
    const ctxs = []
    for (const h of hosts) {
      const info = h.getAgentForChannel(scope)
      if (!info) continue
      const roomId = h.roomForScope(scope)
      if (!roomId) continue
      const cfg = resolveConfigFor(engine.get<ConfigFoldState>(CONFIG_FOLD), roomId, scope)
      ctxs.push({ agentKey: info.agentKey, cfg, relayId, isTurnLive: () => h.isTurnLive(scope) })
    }
    return ctxs.length ? ctxs : undefined
  },
  // Mesh mode only: deterministic pull-claim allocation over the shared directory
  // (bid/push converge on their own once task.* events bridge).
  ...(meshEnabled
    ? {
        election: {
          eligibleClaimants: scope => {
            const host = hosts.find(h => h.getAgentForChannel(scope))
            const roomId = host?.roomForScope(scope)
            if (!host || !roomId) return []
            return directoryFor(engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
              .filter(id => id.platform === host.platform && id.rooms.includes(roomId))
              .map(id => id.agentKey)
          },
        },
        // Hold off per-insert scheduling while ANY host replays channel history on reconnect:
        // each replayed task.* insert would otherwise fire the scheduler against a half-built
        // board. The settle pass below runs once the last host finishes.
        suppressed: () => hosts.some(h => h.isReplaying),
      }
    : {}),
}
synchronizer.register(taskScheduler(schedulerOpts))
// Close the loop: a scheduler-driven turn replying marks its task done (unlocks
// dependents, stops reconcile re-waking it). Crashed turns never reply → failover.
synchronizer.register(completeTaskOnTurn())
synchronizer.register(
  driveTurn({
    getDriveHandle: (channelId, agentKey) => {
      // Route to the host whose botKey IS the turn's actor — not just the first host in
      // array order serving the room, which let a co-resident sibling drive another bot's
      // turn ("@cc → d-bot answers, cc silent"). Falls back to first-serving for non-local
      // actors so cross-relay drive routing is unchanged.
      const host = selectActorHost(hosts, agentKey, h => !!h.getAgentForChannel(channelId))
      return host?.getDriveHandle(channelId)
    },
    getByHash: hash => store.getByHash(hash),
  }),
)
synchronizer.register(
  postOnReply({
    // Name the attribution author by directory label, NOT a raw id — a raw platform id in
    // the "traced from …" subtext gets re-parsed into a live mention (Slack @Uxxx → <@Uxxx>)
    // and re-triggers the named bot, an endless peer-to-peer ack loop. A label is plain text.
    resolveActorName: actorId => {
      for (const h of hosts) {
        const name = h.displayNameForActor(actorId)
        if (name !== actorId) return name
      }
      return actorId
    },
    discordSend: async (channelId, text, agentKey) => {
      // Post via the replying agent's own host, not the first sibling serving the room —
      // otherwise the wrong bot posts the reply (the "@cc → d-bot answers" bug).
      const host = selectActorHost(hosts, agentKey, h => !!h.getAgentForChannel(channelId))
      return host?.discordSend(channelId, text)
    },
    maxMessageLength: channelId =>
      hosts.find(h => h.getAgentForChannel(channelId))?.maxMessageLength,
  }),
)
synchronizer.register(
  dmOnSupersede({
    getOwnerForAgent: agentKey => access.agents[agentKey]?.ownerUserId,
    dmSend: async (userId, text) => {
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
// Local-first cross-machine convergence: a peer re-derives a supersession from the
// winner's immutable `supersedes` op (which crosses NOTIFY); the loser's lifecycle UPDATE doesn't.
synchronizer.register(applySupersession())
// Capture Edit/Write tool runs as workspace.edit, then write the merged file back.
synchronizer.register(
  captureWorkspaceEdit({
    relativize: (scope, absPath, agentKey) => {
      // Relativize against the EDITING bot's workspace — co-resident bots can have different
      // workspaces in one room, so the first sibling's would yield the wrong (or no) relpath.
      const host = selectActorHost(hosts, agentKey, h => !!h.relativizeWorkspacePath(scope, absPath))
      return host?.relativizeWorkspacePath(scope, absPath)
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
      // Atomic temp+rename within the same directory.
      const tmp = `${absPath}.knock-tmp-${process.pid}`
      writeFileSync(tmp, content)
      renameSync(tmp, absPath)
    },
  }),
)
// Outbound file share: resolves `!share` inside the workspace, refuses credentials
// (secret floor), classifies FileShare, sends under the channel claim.
synchronizer.register(
  shareFile({
    resolveFile: async (scope, relpath) => {
      for (const h of hosts) {
        if (!h.roomForScope(scope)) continue
        return h.resolveShareFile(scope, relpath)
      }
      return { error: 'no agent serves this scope' }
    },
    classify: (scope, relpath) => {
      for (const h of hosts) {
        if (!h.roomForScope(scope)) continue
        return h.classifyShareFor(scope, relpath)
      }
      return 'deny'
    },
    send: async (scope, _holder, name, bytes) => {
      for (const h of hosts) {
        if (!h.roomForScope(scope)) continue
        return h.sendFileToScope(scope, name, bytes)
      }
      return false
    },
    note: (scope, text) => {
      for (const h of hosts) {
        if (h.roomForScope(scope)) {
          h.noteToScope(scope, text)
          return
        }
      }
    },
  }),
)
synchronizer.start()

// Task reconcile tick — re-runs the scheduler for every scope with tasks so a
// lapsed claim (crashed/stalled owner) is re-taken even when no new event arrives
// (the watches §7 lesson: failover can't rely on an event). A no-op when idle.
const TASK_RECONCILE_MS = 15_000
const reconcileTasks = async () => {
  // Skip while any host is replaying channel history on reconnect — scheduling must wait for
  // the converged ledger. Doubles as the post-replay settle: a host calls this after its
  // replay (its own flag cleared), and it runs once the LAST host finishes, on the full set.
  if (hosts.some(h => h.isReplaying)) return
  let state: TaskDagFoldState
  try {
    state = engine.get<TaskDagFoldState>(TASK_DAG_FOLD)
  } catch {
    return
  }
  for (const artifactId of state.keys()) {
    const scope = artifactId.slice(taskArtifact('').length)
    await scheduleScope({
      store,
      engine,
      admit: p => admit(store, p),
      opts: schedulerOpts,
      scope,
      allowBidClaim: true, // reconcile = the bid window has settled; the winner may claim
    }).catch(err => process.stderr.write(`task reconcile ${scope}: ${err}\n`))
  }
}
const taskReconcileTimer = setInterval(() => void reconcileTasks(), TASK_RECONCILE_MS)
;(taskReconcileTimer as unknown as { unref?: () => void }).unref?.()

// WatchSupervisor — owns the OS processes behind armed watches and admits a
// watch.fired when an output gate matches. Reconciles against the watch fold,
// so watches armed before this boot are re-armed on subscribe.
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

// Workbench — one message per turn, refreshed as the turn runs. Driven from the
// shared Turn fold: resolve the turn an event belongs to, then refresh its board.
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
  // The status surface is per-scope and owned by the elected scribe, so notify every
  // co-resident host serving the channel (they share one fold); non-scribe hosts no-op at
  // the gate. Routing only to the actor host would leave the scribe stale when a sibling acts.
  for (const host of hosts) {
    if (host.getAgentForChannel(i.channel)) host.updateWorkbench(i.channel)
  }
})

// Connect each host's messaging adapter — messages start flowing into the pipeline.
for (let n = 0; n < hosts.length; n++) {
  const entry = bootEntries[n]!
  const host = hosts[n]!
  const token = process.env[access.agents[entry.key]!.tokenEnv] ?? ''
  // After a host finishes replaying channel history on reconnect, settle the task board once
  // on the converged ledger (no-op while any host still replays — so it lands once, on the
  // full set). Mesh-only; non-mesh hosts never set replaying, so this never fires for them.
  host.onReplaySettle = reconcileTasks
  void host.start(token).catch(err => {
    ui.error(entry.key, `login failed: ${err}`)
  })
}

// Event-driven intake (opt-in): if any bot is `intake: 'webhook'`, open the single
// local HTTP receiver and route /<platform>/<botKey> to that host. Poll-mode bots open
// no server — this is the only place the "no public URL" default is relaxed.
let webhookReceiver: WebhookReceiverHandle | undefined
const webhookHosts = hosts.filter(h => h.usesWebhookIntake)
if (webhookHosts.length > 0) {
  const portEnv = Number(process.env.KNOCK_KNOCK_WEBHOOK_PORT)
  webhookReceiver = startWebhookReceiver({
    hosts: webhookHosts,
    port: Number.isFinite(portEnv) && portEnv > 0 ? portEnv : DEFAULT_WEBHOOK_PORT,
    log: msg => ui.note('webhook', msg),
  })
}

// Banner the active bots (they get panes); idle bots ride the TUI idle strip instead.
ui.banner(bootEntries.filter(e => !e.idle))
paneTui?.setIdle(
  bootEntries
    .filter(e => e.idle)
    .map(e => ({ key: e.key, rooms: Object.keys(access.agents[e.key]?.rooms ?? {}).length })),
)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  process.stderr.write(`relay: unhandled rejection: ${err}\n`)
})

process.on('uncaughtException', err => {
  process.stderr.write(`relay: uncaught exception: ${err}\n`)
})

async function shutdown(): Promise<void> {
  paneTui?.stop() // restore the terminal before any further stderr writes
  process.stderr.write('relay: shutting down\n')
  webhookReceiver?.stop()
  await Promise.all(hosts.map(h => h.stop()))
  clearInterval(taskReconcileTimer)
  synchronizer.stop()
  engine.close()
  store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
