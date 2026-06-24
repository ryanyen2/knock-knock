/**
 * AgentHost — Phase 3: Discord ↔ ledger adapter.
 *
 * Inbound: handleInbound gates the message and admits a `channel.message`.
 * That's it. The synchronizer chain (prompt-on-message → drive-turn →
 * post-on-reply) does the rest.
 *
 * Outbound and adapter-side work: this host exposes callbacks that
 * synchronizations call back into — getAgentForChannel, getDriveHandle,
 * discordSend. The Session map (one Driver + adapter per channel) still
 * lives here because adapter instances are per-process; everything else
 * lives in the ledger.
 *
 * The AgentAdapter seam is byte-for-byte preserved — applyPolicy /
 * onPermissionRequest / prompt / onEvent unchanged. The permission
 * handler closure inside Driver now awaits a ledger verdict via
 * `awaitVerdict` instead of an in-process Promise.
 */

import { makeMessagingAdapter } from './adapters-msg/index.ts'
import type {
  MessagingAdapter,
  MessageRef,
  IncomingMessage,
  IncomingAction,
  IncomingReaction,
} from './messaging-adapter.ts'
import {
  readRoomSettings,
  readSessionBinding,
  writeSessionBinding,
  clearSessionBinding,
} from './state.ts'
import {
  type AgentConfig,
  type Access,
  type PreambleContext,
  guildSenderAllowed,
  senderKind,
  buildRosterLinesForRoom,
  approverForAgent,
  isShareSessionCommand,
  isResumeSessionCommand,
  resolveRoomForScope,
  resolveReactionScope,
  resolveProfileForActor,
  threadNameFromPrompt,
  matchesMentionPattern,
  wrapChannelRole,
  wrapChannelGoal,
  applyModeToProfile,
  toThinkingConfig,
  DEFAULT_LOOP_GUARD,
  type ChannelConfig,
  type LoopGuardOpts,
  type WatchSpec,
} from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { makeAdapter, runtimeSelfArmsWatches } from './adapters/index.ts'
import { Approvals } from './approvals.ts'
import { ConsoleUI } from './console-ui.ts'
import { DmCourier, type TurnHandle as DmTurnHandle } from './dm-courier.ts'
import type { AgentEvent, PermissionProfile } from './agent-adapter.ts'
import type { Ledger } from './ledger/capture.ts'
import type { Store } from './ledger/store.ts'
import type { FoldEngine } from './ledger/fold.ts'
import { admit } from './ledger/admit.ts'
import { awaitVerdict } from './ledger/await-verdict.ts'
import { TurnRecorder } from './ledger/turn-recorder.ts'
import { discordArtifact, type ChannelId, type Hash } from './ledger/interaction.ts'
import { parseVersionableId } from './ledger/artifacts/versionable.ts'
import { join, relative, resolve, isAbsolute } from 'path'
import type { DriveTurnHandle } from './ledger/synchronizations/drive-turn.ts'
import type { ConflictCardPost } from './ledger/synchronizations/conflict-card.ts'
import {
  GLYPHS,
  rewindActionFor,
  renderRewindAck,
  renderSessionResumed,
  type RewindAction,
} from './ledger/render/surface.ts'
import type { WatchRunEnv } from './watch-supervisor.ts'
import {
  sessionRuntimeForAgent,
  type SessionSummary,
} from './sessions/index.ts'
import type { HostContext } from './host/context.ts'
import { Workbench } from './host/workbench.ts'
import { ConfigCard } from './host/config-card.ts'
import { ConflictUI } from './host/conflict-ui.ts'
import { WatchControl } from './host/watch-control.ts'
import { SessionSharing } from './host/session-sharing.ts'
import { ChannelConfigControl } from './host/channel-config.ts'
import { ContextControl } from './host/context-control.ts'
import { CONFIG_FOLD, configFor, resolveConfigFor, type ConfigFoldState } from './ledger/concepts/config.ts'

const RECENT_BOT_MSG_CAP = 200

/** Set a key on a Map, FIFO-evicting the oldest entry when it exceeds `cap`.
 *  The host keeps several bounded side tables (task scope, pending DM handles,
 *  inbound side tables) that all want this exact set-and-evict dance. */
function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value)
  if (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** A per-channel session: the live adapter + driver + per-turn state. */
type Session = {
  driver: Driver
  /** Per-channel mailbox of in-flight turn metadata for adapter event fanout. */
  activeTurn?: {
    promptHash: Hash
    recorder: TurnRecorder
    dmHandle: DmTurnHandle
    /** Aborts this turn when the owner reacts 🛑. */
    abort: AbortController
  }
}

/** Side-table the host owns so synchronization callbacks can resolve
 *  inbound-related messaging state (ack reactions, DmCourier headers). */
type InboundSideTable = {
  /** Ref of the inbound message (for the ack reaction + outcome glyph). */
  ref: MessageRef
  ackEmoji: string
  senderLabel: string
  channelLabel: string
  userPrompt: string
}

export class AgentHost {
  private readonly messaging: MessagingAdapter
  private readonly approvals: Approvals
  private readonly courier: DmCourier
  private readonly sessions = new Map<ChannelId, Session>()
  private readonly inboundRate = new Map<string, number[]>()
  private readonly recentBotMsgIds = new Set<string>()
  /** Inbound side-table keyed by the channel.message hash. Consumed by the
   *  turn.prompted subscriber (DmCourier kickoff) and the turn.replied
   *  subscriber (ack cleanup). */
  private readonly inboundByHash = new Map<Hash, InboundSideTable>()
  /** §4.2 conflict card post + button resolution. */
  private readonly conflictUI: ConflictUI
  /** Watch arm/disarm/list — owner `!watch` and the agent MCP tool. */
  private readonly watchControl: WatchControl
  /** Session sharing/resume — owner-only import + the per-scope context delivery. */
  private readonly sessionSharing: SessionSharing
  /** Per-channel config overlay — owner `!config` (persona/role brief, knobs). */
  private readonly channelConfig: ChannelConfigControl
  /** Per-thread context surface — owner `!context` (view/add/remove shared context). */
  private readonly contextControl: ContextControl
  /** Scope (a thread id, or a plain channel id) → the room (parent channel) it
   *  belongs to. The single seam between the task scope the ledger keys on and
   *  the room that permission profiles / roster / routing key on. Populated on
   *  inbound and on thread creation. */
  private readonly scopeToRoom = new Map<ChannelId, ChannelId>()
  /** Inbound message id → the task scope it spawned (a thread). A top-level
   *  @mention runs its turn in a thread, but the owner reacts 🛑/🔁 on the
   *  original message (parent-channel scope); this maps that message back to the
   *  scope its turn actually runs in. In-memory and FIFO-bounded — lost on
   *  restart, which is fine (no turn is in flight after a restart). */
  private readonly taskScopeByMessage = new Map<string, ChannelId>()
  /** DM-courier handles awaiting their turn's activeTurn. `onTurnPrompted` (a
   *  store subscriber) and `runTurnForChannel` (the drive-turn path) fire on the
   *  same `turn.prompted` in nondeterministic order; whichever runs second
   *  reconciles here, so the per-turn DM handle attaches regardless of ordering. */
  private readonly pendingDmByPrompt = new Map<Hash, DmTurnHandle>()
  /** §4.1 per-turn activity log (no longer pinned). */
  private readonly workbench: Workbench
  /** Pinned per-thread config/setup card (takes the pin slot from the workbench). */
  private readonly configCard: ConfigCard
  private storeUnsub?: () => void

  constructor(
    private readonly key: string,
    private readonly agent: AgentConfig,
    private readonly getAccess: () => Access,
    private readonly ui: ConsoleUI,
    private readonly ledger: Ledger,
    private readonly store: Store,
    private readonly engine: FoldEngine,
  ) {
    // Build the messaging adapter for this agent's platform (Discord today). The
    // host speaks only the MessagingAdapter seam from here on — no platform SDK.
    // Resolve any per-agent secondary token (Slack's app token) by env-var name,
    // falling back to the platform's global convention inside the adapter.
    const appToken = agent.appTokenEnv ? process.env[agent.appTokenEnv] : undefined
    this.messaging = makeMessagingAdapter(agent.platform ?? 'discord', { appToken })

    const liveAgentGetter = () => getAccess().agents[this.key] ?? this.agent

    this.approvals = new Approvals(
      this.messaging,
      liveAgentGetter,
      this.store,
      info => {
        if (info.destination === 'channel' && info.reason) {
          this.ui.note(this.key, `approval fell back to channel — ${info.reason}`)
        } else {
          this.ui.note(this.key, `approval prompt sent to ${info.destination}`)
        }
      },
    )

    this.courier = new DmCourier(
      this.messaging,
      this.engine,
      () => liveAgentGetter().ownerUserId,
      reason => this.ui.note(this.key, reason),
    )

    // The shared capabilities the UI collaborators reach back into. Built once;
    // bundles only what they need so none holds a back-reference to the host.
    const ctx: HostContext = {
      key: this.key,
      messaging: this.messaging,
      store: this.store,
      engine: this.engine,
      ledger: this.ledger,
      ui: this.ui,
      getAccess: () => this.getAccess(),
      roomForScope: id => this.roomForScope(id),
      getOwnerForChannel: id => this.getOwnerForChannel(id),
      discordSend: (id, text) => this.discordSend(id, text),
      noteBotMsg: id => this.noteBotMsg(id),
      refreshConfigCard: id => this.configCard.refresh(id),
    }
    this.workbench = new Workbench(ctx)
    this.configCard = new ConfigCard(ctx)
    this.conflictUI = new ConflictUI(ctx)
    this.watchControl = new WatchControl(ctx, this.approvals)
    this.sessionSharing = new SessionSharing(ctx, (action, scopeId, summary) =>
      this.resumeSession(action, scopeId, summary),
    )
    this.channelConfig = new ChannelConfigControl(ctx)
    this.contextControl = new ContextControl(ctx)

    // Inbound: the adapter normalizes platform events into these three handlers.
    this.messaging.onMessage(m => {
      this.handleInbound(m).catch(e =>
        this.ui.error(this.key, `handleInbound error: ${e}`),
      )
    })

    this.messaging.onAction(action => {
      if (action.actionId.startsWith('appr:')) {
        this.approvals.resolve(action).catch(e =>
          this.ui.error(this.key, `interaction error: ${e}`),
        )
      } else if (this.conflictUI.handles(action)) {
        this.conflictUI.resolve(action).catch(e =>
          this.ui.error(this.key, `conflict resolve error: ${e}`),
        )
      } else if (this.sessionSharing.handles(action)) {
        this.sessionSharing.handlePick(action).catch(e =>
          this.ui.error(this.key, `session pick error: ${e}`),
        )
      }
    })

    this.messaging.onReaction(reaction => {
      const emoji = reaction.glyph
      if (emoji === '✅' || emoji === '❌') {
        this.approvals.resolveReaction(reaction.ref.id, emoji, reaction.userId).catch(e =>
          this.ui.error(this.key, `reaction error: ${e}`),
        )
        return
      }
      // Resolve the scope the reaction should act on: a 🛑/🔁 on the original
      // top-level message must reach the turn running in its spawned thread.
      const scope = resolveReactionScope(reaction.ref.id, reaction.ref.scope, this.taskScopeByMessage)
      if (emoji === GLYPHS.stop) {
        this.handleStop(scope, reaction.userId).catch(e =>
          this.ui.error(this.key, `stop error: ${e}`),
        )
        return
      }
      const action = rewindActionFor(emoji)
      if (action) {
        this.handleRewind(reaction.ref.id, scope, reaction.userId, action).catch(
          e => this.ui.error(this.key, `rewind error: ${e}`),
        )
      }
    })

    // Side-effect subscriber: turn.prompted → start the DmCourier. The
    // 👀→done/failed reaction transition is owned by runTurnForChannel (it
    // knows the turn's outcome, including failures that never reach
    // turn.replied). Ledger-driven work; only messaging bookkeeping lives here.
    this.storeUnsub = this.store.subscribe(i => {
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return
      if (i.verb === 'turn.prompted') void this.onTurnPrompted(i.hash, i.caused_by[0])
    })
  }

  async start(token: string): Promise<void> {
    await this.messaging.connect(token)
    // connect resolves once the gateway is ready, so the bot label is populated.
    this.ui.connected(this.key, this.messaging.botLabel ?? this.messaging.botUserId ?? this.key)
  }

  async stop(): Promise<void> {
    this.storeUnsub?.()
    this.workbench.stop()
    this.configCard.stop()
    await this.messaging.disconnect()
  }

  // ─── Synchronization callbacks (used by sync wiring in relay.ts) ──────────

  /**
   * Resolve a scope (a thread id, or a plain channel id) to the room — the
   * parent text channel — this host serves, or undefined if this host doesn't
   * serve that room. A room id resolves to itself; a thread id resolves to its
   * parent (cached on inbound / thread creation, with a live Discord-cache
   * fallback for scopes seen for the first time after a restart).
   *
   * Every room-scoped lookup (routing, permission profile, roster, approver)
   * goes through here, so a threaded turn resolves to the SAME permission floor
   * as a top-level one — it must never silently degrade to an empty profile.
   */
  roomForScope(scopeId: ChannelId): ChannelId | undefined {
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const roomId = resolveRoomForScope(scopeId, liveAgent.rooms, this.scopeToRoom, id =>
      this.messaging.parentOfSync(id),
    )
    // Memoize a freshly-probed thread→parent mapping so the next lookup is cheap.
    if (roomId && roomId !== scopeId) this.scopeToRoom.set(scopeId, roomId)
    return roomId
  }

  /**
   * Async cache-warming variant of `roomForScope`. On a cold-cache miss — e.g. a
   * cross-machine-synced conflict card for a thread this host hasn't seen an
   * inbound message in since restart — pay the async `parentOf` probe once,
   * memoize it, and resolve; only then declare the scope unserved. Keeps the hot
   * sync path untouched while closing the silent-drop gap for synced events.
   */
  async ensureRoomForScope(scopeId: ChannelId): Promise<ChannelId | undefined> {
    const sync = this.roomForScope(scopeId)
    if (sync) return sync
    // Bound the probe: a slow/unavailable platform API must not hang the calling
    // synchronization wave (e.g. conflict-card). Time out to undefined.
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5_000))
    const parent = await Promise.race([
      this.messaging.parentOf(scopeId).catch(() => undefined),
      timeout,
    ])
    if (!parent) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    if (!liveAgent.rooms[parent]) return undefined
    this.scopeToRoom.set(scopeId, parent) // warm so later sync lookups hit
    return parent
  }

  /** prompt-on-message asks "who responds on this scope?" — yes iff this host
   *  serves the room the scope belongs to. Also resolves the room's loop-guard
   *  opts (owner `!config loop-max/loop-cooldown` overlay, else the defaults) so
   *  the sync's gate uses this channel's tuned thresholds. */
  getAgentForChannel(scopeId: ChannelId): { agentKey: string; loopGuardOpts: LoopGuardOpts } | undefined {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return undefined
    const cfg = this.channelConfigFor(scopeId)
    return {
      agentKey: this.key,
      loopGuardOpts: {
        maxConsecutive: cfg.loopMaxConsecutive ?? DEFAULT_LOOP_GUARD.maxConsecutive,
        cooldownMs: cfg.loopCooldownMs ?? DEFAULT_LOOP_GUARD.cooldownMs,
      },
    }
  }

  /** Record the task scope a top-level message spawned, FIFO-bounded so the map
   *  can't grow without limit over a long-running relay. */
  private rememberTaskScope(messageId: string, scope: ChannelId): void {
    boundedMapSet(this.taskScopeByMessage, messageId, scope, 1000)
  }

  /** capture-workspace-edit asks "make this absolute edit path workspace-relative."
   *  Returns undefined when the scope is unserved or the file is outside the
   *  workspace — so only in-workspace edits become versionable artifacts, and the
   *  artifact id (vers:<scope>/<rel>) stays stable across machines. */
  relativizeWorkspacePath(scope: ChannelId, absFilePath: string): string | undefined {
    if (!this.roomForScope(scope)) return undefined
    const ws = (this.getAccess().agents[this.key] ?? this.agent).workspace
    if (!ws) return undefined
    const abs = isAbsolute(absFilePath) ? absFilePath : resolve(ws, absFilePath)
    const rel = relative(ws, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return rel
  }

  /** write-back-versionable asks "where on disk does this vers: artifact live?"
   *  Undefined when this host doesn't serve the artifact's scope. */
  resolveVersionablePath(artifactId: string): string | undefined {
    const parsed = parseVersionableId(artifactId)
    if (!parsed || !this.roomForScope(parsed.scope)) return undefined
    const ws = (this.getAccess().agents[this.key] ?? this.agent).workspace
    return ws ? join(ws, parsed.relPath) : undefined
  }

  /** drive-turn asks "give me a handle to actually run the adapter here." */
  getDriveHandle(channelId: ChannelId): DriveTurnHandle | undefined {
    if (!this.getAgentForChannel(channelId)) return undefined
    return {
      run: async opts => this.runTurnForChannel(channelId, opts),
    }
  }

  /** post-on-reply sends a chunk; we return the resulting message id. A failed
   *  send throws (matching the original `ch.send` rejection) so post-on-reply
   *  aborts the remaining chunks and the synchronizer's per-sync error isolation
   *  logs it, rather than silently continuing past a dropped chunk. */
  async discordSend(channelId: ChannelId, text: string): Promise<string | undefined> {
    const ref = await this.messaging.send(channelId, text)
    if (!ref) throw new Error(`messaging.send failed for ${channelId}`)
    this.noteBotMsg(ref.id)
    return ref.id
  }

  /** The platform's max message length, so post-on-reply chunks at the right
   *  width instead of assuming Discord's. */
  get maxMessageLength(): number {
    return this.messaging.capabilities().maxMessageLength
  }

  /** True when this host's platform adapter is a not-yet-certified skeleton, so
   *  the relay can warn loudly at startup. */
  get experimental(): boolean {
    return this.messaging.capabilities().experimental === true
  }

  /** Relay subscriber → refresh a turn's (per-call) Workbench message (throttled). */
  updateWorkbench(scopeId: ChannelId, promptHash: Hash): void {
    this.workbench.updateForTurn(scopeId, promptHash)
  }

  /**
   * Owner reacted 🛑 on a message in a channel with an in-flight turn — abort it
   * promptly via the turn's AbortController. The adapter cancels its work and
   * runTurnForChannel posts a short "Stopped" note and marks the outcome. No-op
   * if there's no active turn here or the reactor isn't this agent's owner.
   */
  private async handleStop(channelId: ChannelId, userId: string): Promise<void> {
    if (!this.getAgentForChannel(channelId)) return
    const at = this.sessions.get(channelId)?.activeTurn
    if (!at) return
    const ownerId = this.getOwnerForChannel(channelId)
    if (!ownerId || userId !== ownerId) return
    this.ui.note(this.key, `stop requested in ${channelId}`)
    at.abort.abort()
  }

  /**
   * §4.5 — owner reacted ⏪/🔁/🧷 on one of this bot's messages. We require the
   * reaction to be on THIS host's message (recentBotMsgIds) which also dedups
   * across hosts sharing a channel, and that the reactor is the channel owner.
   * The action is journaled as an interaction; 🔁 retry re-runs the turn via
   * the retry-on-reaction synchronization, ⏪/🧷 are recorded + acknowledged.
   */
  private async handleRewind(
    messageId: string,
    rawChannelId: string,
    userId: string,
    action: RewindAction,
  ): Promise<void> {
    if (!this.recentBotMsgIds.has(messageId)) return // not our message / dedup
    const channelId = rawChannelId
    if (!this.getAgentForChannel(channelId)) return
    const ownerId = this.getOwnerForChannel(channelId)
    if (!ownerId || userId !== ownerId) return

    const channelArtifactId = discordArtifact(channelId)
    const frontier = await this.store.channelFrontier(channelId)

    if (action === 'retry') {
      // Target the channel's most recent turn.prompted.
      const inChannel = await this.store.listByChannel(channelId)
      const lastPrompt = [...inChannel].reverse().find(i => i.verb === 'turn.prompted')
      if (!lastPrompt) return
      await admit(this.store, {
        actor: ownerId,
        role: 'owner',
        channel: channelId,
        target: { artifactId: channelArtifactId, anchor: { kind: 'none' } },
        verb: 'turn.retry',
        patch: { kind: 'none' },
        effect: 'pure',
        caused_by: [lastPrompt.hash],
      })
    } else {
      const verb = action === 'rewind' ? 'frontier.rewind' : 'frontier.checkpoint'
      await admit(this.store, {
        actor: ownerId,
        role: 'owner',
        channel: channelId,
        target: { artifactId: channelArtifactId, anchor: { kind: 'none' } },
        verb,
        patch: { kind: 'none' },
        effect: 'pure',
        caused_by: frontier.length > 0 ? frontier : [],
      })
    }

    await this.discordSend(channelId, renderRewindAck(action)).catch(() => {})
  }

  /** dm-on-supersede (§4.4) sends an owner a short override note. */
  async dmUser(userId: string, text: string): Promise<string | undefined> {
    const ref = await this.messaging.dm(userId, text)
    return ref?.id
  }

  /** §4.2 — the conflict-card synchronization posts a card for a held conflict. */
  async postConflictCard(post: ConflictCardPost): Promise<string | undefined> {
    // Warm the scope→room cache first: a conflict on a synced edit can arrive
    // for a thread this host hasn't seen since restart, where the sync owner
    // lookup inside ConflictUI would otherwise miss and silently drop the card.
    await this.ensureRoomForScope(post.channelId)
    return this.conflictUI.postCard(post)
  }

  // ─── Session resume (owner-only) ───────────────────────────────────────────

  /**
   * Bind a scope's Driver to an existing runtime session and persist it so the
   * resume survives a relay restart. Only valid when the agent's runtime can
   * continue that session's runtime; otherwise fall the owner back to import.
   * Delegated to from SessionSharing because it's tied to the Session/Driver
   * lifecycle this host owns.
   */
  private async resumeSession(
    action: IncomingAction,
    scopeId: ChannelId,
    summary: SessionSummary,
  ): Promise<void> {
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const roomId = this.roomForScope(scopeId)
    const room = roomId ? liveAgent.rooms[roomId] : undefined
    if (!room || sessionRuntimeForAgent(liveAgent.runtime) !== summary.runtime) {
      await action.respond(
        `This agent (${liveAgent.runtime}) can't resume a ${summary.runtime} session — try "share session" to import its context instead.`,
        { ephemeral: true },
      )
      return
    }
    const session = this.getOrCreateSession(scopeId, liveAgent, room)
    session.driver.bindSession(summary.id)
    writeSessionBinding(this.key, scopeId, {
      runtime: summary.runtime,
      sessionId: summary.id,
      workspace: liveAgent.workspace,
    })
    this.ui.note(this.key, `resuming ${summary.runtime} session ${summary.id.slice(0, 8)} in ${scopeId}`)
    await action.update(renderSessionResumed({ runtime: summary.runtime, title: summary.title }))
  }

  /** This host's agent key — relay uses it to map agentKey → owner. */
  get agentKey(): string {
    return this.key
  }

  /** Owner of this host's agent (live-read so setup changes apply). */
  get ownerUserId(): string | undefined {
    return (this.getAccess().agents[this.key] ?? this.agent).ownerUserId
  }

  /** Owner/approver for a scope this host serves, else undefined (§4.2). The
   *  approver is configured per room, so resolve scope→room first. */
  getOwnerForChannel(scopeId: ChannelId): string | undefined {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    return approverForAgent(liveAgent, roomId) ?? liveAgent.ownerUserId
  }

  /** Relay's WatchSupervisor resolver: workspace + permission decision (room-resolved). */
  resolveWatch(spec: WatchSpec): WatchRunEnv | undefined {
    return this.watchControl.resolveWatch(spec)
  }

  /** The base profile the audit-only classify-on-tool-request sync should match
   *  against, for a scope this host serves: the room profile with the thread's
   *  permission `mode` applied (so the audit reflects a loosened thread), but no
   *  per-actor tiers (the audit stays on the base — tier deny ⊇ base deny). Undefined
   *  when this host doesn't serve the scope's room. */
  auditProfileForScope(agentKey: string, scopeId: ChannelId): PermissionProfile | undefined {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return undefined
    const base = readRoomSettings(agentKey, roomId)
    const mode = this.channelConfigFor(scopeId).permissionPreset
    return mode ? applyModeToProfile(base, mode) : base
  }

  // ─── Inbound (skinny) ─────────────────────────────────────────────────────

  /**
   * Get or create the task thread for a top-level message. The adapter is
   * race-tolerant (a concurrent starter wins and it adopts that thread). Returns
   * undefined if a thread can't be created (e.g. missing permission), so the
   * caller falls back to running the task at the channel level.
   */
  private async ensureTaskThread(m: IncomingMessage): Promise<ChannelId | undefined> {
    return this.messaging.startThread(m.ref, threadNameFromPrompt(m.text))
  }

  private async handleInbound(m: IncomingMessage): Promise<void> {
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent
    const botId = this.messaging.botUserId

    // Room = the parent text channel: permission profile, roster, allowlist.
    // A message in a thread inherits its parent's room.
    const roomId = m.isThread
      ? (this.messaging.parentOfSync(m.scope) ?? m.scope)
      : m.scope
    const room = liveAgent.rooms[roomId]
    if (!room) return

    if (m.authorId === botId) return

    const ownerId = liveAgent.ownerUserId
    if (!guildSenderAllowed(room, m.authorId, botId, ownerId)) return

    // Per-channel overlay (owner `!config`): rate cap, require-mention, extra
    // mention patterns, ack emoji. Room-keyed — these gate inbound BEFORE a task
    // thread exists, so they read the raw room overlay (no scope merge).
    const cfg = this.roomConfigRaw(roomId)
    const rateWindowMs = cfg.rateWindowMs ?? 60_000
    const rateCap = cfg.rateCapPerMin ?? 10
    const now = Date.now()
    const recent = (this.inboundRate.get(m.authorId) ?? []).filter(t => now - t < rateWindowMs)
    if (recent.length >= rateCap) return
    this.inboundRate.set(m.authorId, [...recent, now])

    // require-mention: overlay wins, then the room's RoomConfig, then default-on.
    // A UX knob only — `guildSenderAllowed` above still gates who is allowed.
    const requireMention = cfg.requireMention ?? room.requireMention ?? true
    const mentionPatterns = [...(access.mentionPatterns ?? []), ...(cfg.mentionPatterns ?? [])]
    const mentioned = await this.isMentioned(m, mentionPatterns)
    if (requireMention && !mentioned) return

    this.messaging.typing(m.scope)

    const kind = senderKind(room, m.authorId, ownerId)

    // Owner control commands operate at the scope they're TYPED in and never
    // spawn a task thread (they're control, not work): a command typed inside a
    // thread targets that thread; at top level it targets the channel itself.
    const controlScope = m.isThread ? m.scope : roomId

    // ─── Owner share/resume-session command — short-circuit before any admit ─
    // Owner-only (kind==='owner'): list this agent's local sessions and post a
    // selection card. The command itself is NOT admitted as a channel.message,
    // so the agent is never prompted with it; config/sessions stay terminal-
    // and owner-driven (the prompt-injection invariant). A peer can't reach
    // here — senderKind only returns 'owner' for the agent's owner. 'import'
    // distills context; 'resume' continues the live session.
    if (kind === 'owner' && (isShareSessionCommand(m.text) || isResumeSessionCommand(m.text))) {
      this.scopeToRoom.set(controlScope, roomId)
      const mode = isResumeSessionCommand(m.text) ? 'resume' : 'import'
      await this.sessionSharing.offer(controlScope, mode).catch(e =>
        this.ui.error(this.key, `offer session ${mode}: ${e}`),
      )
      return
    }

    // ─── Owner watch control (!watch / !unwatch) — short-circuit before admit ─
    // Owner-only, like the session commands: the control is NOT admitted as a
    // channel.message, so a watch can't be armed by a peer talking (the
    // prompt-injection invariant). Arming a command is permission-gated the same
    // way a Bash call is. See docs/knock-knock-watches.md.
    if (kind === 'owner' && (m.text.startsWith('!watch') || m.text.startsWith('!unwatch'))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.watchControl.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `watch command: ${e}`),
      )
      return
    }

    // ─── Owner per-channel config (!config) — short-circuit before any admit ──
    // Owner-only, like the watch/session commands: the command is NOT admitted as
    // a channel.message, so the agent is never prompted with it and a peer/human
    // (or a prompt injection) can't reach the config write path. Tunes the
    // behavioral overlay only (persona/role brief) — identity, the allowlist, and
    // permissions stay terminal-managed.
    if (kind === 'owner' && (m.text === '!config' || m.text.startsWith('!config '))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.channelConfig.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `config command: ${e}`),
      )
      return
    }

    // ─── Owner per-thread context surface (!context) — short-circuit before admit ─
    // Owner-only, like !config: the command is NOT admitted as a channel.message,
    // so the agent is never prompted with it and a peer/human can't curate context.
    // Views / adds / removes the thread's shared-context notes (reuses the same
    // knowledge artifact session import writes + the once-per-turn delivery path).
    if (kind === 'owner' && (m.text === '!context' || m.text.startsWith('!context '))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.contextControl.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `context command: ${e}`),
      )
      return
    }

    // ─── Resolve the task scope ──────────────────────────────────────────────
    // A message already in a thread runs in that thread. A top-level @mention
    // spawns (or reuses) a task thread, so each task gets its own turn lineage,
    // workbench, and agent session. A top-level non-mention (only reachable when
    // requireMention is false) stays at the channel. Thread creation failing
    // (e.g. missing permission) degrades to running at the channel.
    let scopeId: ChannelId
    if (m.isThread) {
      scopeId = m.scope
    } else if (mentioned) {
      scopeId = (await this.ensureTaskThread(m)) ?? m.scope
    } else {
      scopeId = m.scope
    }
    this.scopeToRoom.set(scopeId, roomId)
    // Remember which task scope this top-level message spawned, so a 🛑/🔁
    // reaction on the original message resolves to the thread its turn runs in.
    if (scopeId !== m.scope) this.rememberTaskScope(m.ref.id, scopeId)
    // Surface the thread's pinned setup card (no-op for a plain-channel scope).
    this.configCard.refresh(scopeId)

    // ─── Admit channel.message — that's all handleInbound does in Phase 3 ───
    const channelArtifactId = discordArtifact(scopeId)
    const prior = await this.store.latestInChannel(scopeId)
    const inboundResult = await admit(this.store, {
      actor: m.authorId,
      role: kind === 'unknown' ? 'agent' : kind,
      channel: scopeId,
      target: { artifactId: channelArtifactId, anchor: { kind: 'none' } },
      verb: 'channel.message',
      patch: {
        kind: 'external',
        intent: {
          channel: this.messaging.platform,
          op: 'received',
          args: { text: m.text, messageId: m.ref.id },
        },
      },
      effect: 'external',
      caused_by: prior ? [prior.hash] : [],
    })
    if (inboundResult.kind !== 'admitted') return

    // Side-table: stash messaging context so synchronization-driven UX can
    // react/edit the inbound message later (ack reaction, DmCourier header).
    const channelLabel = m.scopeLabel ?? `#${roomId}`
    const ackEmoji = cfg.ackReaction ?? access.ackReaction ?? '👀'
    // Bounded: markInboundOutcome no longer deletes entries (a 🔁 retry re-marks
    // the same inbound), so FIFO-evict the oldest to keep this from growing forever.
    boundedMapSet(this.inboundByHash, inboundResult.interaction.hash, {
      ref: m.ref,
      ackEmoji,
      senderLabel: m.authorName,
      channelLabel,
      userPrompt: m.text,
    }, 500)

    this.ui.turnStart(this.key, {
      channel: { label: channelLabel },
      sender: { label: m.authorName, kind },
      text: m.text,
    })

    // Ack reaction (👀 = received/working). Swapped for a persistent 🏁 done /
    // 🛑 failed by markInboundOutcome when the turn ends. If the loop-guard
    // denies the turn, the ack stays until a TTL sweep (Phase 3.1).
    void this.messaging.react(m.ref, ackEmoji).catch(() => {})
  }

  // ─── Ledger-driven side effects (subscribed in constructor) ───────────────

  private async onTurnPrompted(promptHash: Hash, inboundHash: Hash | undefined): Promise<void> {
    if (!inboundHash) return
    const side = this.inboundByHash.get(inboundHash)
    if (!side) return // not our channel.message, or already consumed
    try {
      const dmHandle = await this.courier.beginTurn({
        senderLabel: side.senderLabel,
        channelLabel: side.channelLabel,
        userPrompt: side.userPrompt,
        promptHash,
      })
      // Reconcile with runTurnForChannel without depending on ordering: if it
      // has already created the activeTurn, attach directly; otherwise stash the
      // handle for it to pick up when it does. This whole block is synchronous
      // after the await, so it can't interleave with runTurnForChannel's own
      // synchronous get-pending-then-set-activeTurn block — exactly one of the
      // two paths attaches the handle.
      const session = this.sessionForPrompt(promptHash)
      if (session?.activeTurn?.promptHash === promptHash) {
        session.activeTurn.dmHandle = dmHandle
      } else {
        this.rememberPendingDm(promptHash, dmHandle)
      }
    } catch (err) {
      this.ui.error(this.key, `dm courier begin: ${err}`)
    }
  }

  /**
   * Transition the inbound message's reactions when a turn winds down: drop the
   * transient 👀 (working/saw) and add a persistent outcome marker — 🏁 done,
   * ⚠️ failed, or ⏹ stopped — so the channel keeps a glance-able, traceable
   * record. Then release the side-table. Called from runTurnForChannel for every
   * outcome (a crash never reaches turn.replied, so this can't live there).
   */
  private async markInboundOutcome(
    inboundHash: Hash,
    outcome: 'done' | 'failed' | 'stopped',
  ): Promise<void> {
    const side = this.inboundByHash.get(inboundHash)
    if (!side) return
    // Keep the side-table (FIFO-bounded at the set site): a 🔁 retry re-runs this
    // same inbound message and must be able to re-mark its outcome.
    const glyph =
      outcome === 'stopped' ? GLYPHS.stopped : outcome === 'failed' ? GLYPHS.failed : GLYPHS.done
    // Drop the transient ack and any *prior* outcome glyph before applying the
    // new one, so a retried-then-resolved message never stacks two outcomes.
    void this.messaging.unreact(side.ref, side.ackEmoji).catch(() => {})
    for (const g of [GLYPHS.done, GLYPHS.failed, GLYPHS.stopped]) {
      if (g !== glyph) void this.messaging.unreact(side.ref, g).catch(() => {})
    }
    void this.messaging.react(side.ref, glyph).catch(() => {})
  }

  /** The session whose active turn matches this promptHash, if one exists yet.
   *  Used by onTurnPrompted to attach the DM handle when runTurnForChannel has
   *  already created the activeTurn; returns undefined when it hasn't, in which
   *  case the handle is stashed in pendingDmByPrompt instead. */
  private sessionForPrompt(promptHash: Hash): Session | undefined {
    for (const sess of this.sessions.values()) {
      if (sess.activeTurn?.promptHash === promptHash) return sess
    }
    return undefined
  }

  /** Stash a DM handle for runTurnForChannel to claim, FIFO-bounded so an
   *  admitted-but-never-driven prompt can't leak handles unbounded. */
  private rememberPendingDm(promptHash: Hash, handle: DmTurnHandle): void {
    boundedMapSet(this.pendingDmByPrompt, promptHash, handle, 256)
  }

  // ─── Adapter driver (called by drive-turn via getDriveHandle) ─────────────

  /** The SCOPE-RESOLVED config overlay (thread overlay ⊕ room default) for a
   *  scope this host serves, or {} if unresolved / the fold isn't registered. The
   *  single per-turn read seam: role, end-goal, loop-guard, approval timeout,
   *  model/thinking/effort, and the permission mode all resolve through this. */
  private channelConfigFor(scopeId: ChannelId): ChannelConfig {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return {}
    try {
      return resolveConfigFor(this.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId, scopeId)
    } catch {
      return {}
    }
  }

  /** The RAW room overlay (no scope merge), for the inbound gate — which runs
   *  BEFORE a task thread exists, so rate-cap / require-mention / mention / ack
   *  are necessarily room-keyed (the per-thread plan defers these by design). */
  private roomConfigRaw(roomId: ChannelId): ChannelConfig {
    try {
      return configFor(this.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId)
    } catch {
      return {}
    }
  }

  /** This scope's persona blocks — the role brief and the end-goal/objective,
   *  each wrapped for the prompt — joined, or undefined when neither is set. Read
   *  fresh per turn so a `!config role/end-goal …` change takes effect next turn. */
  private personaBlocksFor(scopeId: ChannelId): string | undefined {
    const cfg = this.channelConfigFor(scopeId)
    const blocks = [
      cfg.role ? wrapChannelRole(cfg.role) : undefined,
      cfg.endGoal ? wrapChannelGoal(cfg.endGoal) : undefined,
    ].filter(Boolean)
    return blocks.length ? blocks.join('\n\n') : undefined
  }

  /** This scope's approval timeout override (ms), or undefined to use the
   *  default. awaitVerdict treats undefined as DEFAULT_VERDICT_TIMEOUT_MS. */
  private approvalTimeoutFor(scopeId: ChannelId): number | undefined {
    return this.channelConfigFor(scopeId).approvalTimeoutMs
  }

  private async runTurnForChannel(
    channelId: ChannelId,
    opts: {
      promptHash: Hash
      inboundHash: Hash
      promptText: string
      senderId: string
      senderKindKind: 'owner' | 'human' | 'agent'
      messageId: string
      ts: string
    },
  ): Promise<{ chunks: string[]; error?: string }> {
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent
    // channelId is the task scope (a thread). The roster/approver/profile come
    // from the room — resolve scope→room (a turn always runs in a scope this
    // host serves, so this resolves).
    const roomId = this.roomForScope(channelId)
    const room = roomId ? liveAgent.rooms[roomId] : undefined
    if (!room || !roomId) return { chunks: [], error: 'no room' }

    const session = this.getOrCreateSession(channelId, liveAgent, room)
    const approverUserId = approverForAgent(liveAgent, roomId) ?? liveAgent.ownerUserId

    // Per-actor permission floor: the room profile is the OWNER floor; a turn
    // prompted by a peer/human is narrowed by its tier. Read fresh + resolve per
    // turn (the requester can differ between turns on one cached session), then
    // re-apply to the adapter inside the serialized runTurn. The audit-only
    // classify-on-tool-request sync resolves the same scope mode (see relay.ts).
    const storedProfile = readRoomSettings(this.key, roomId)
    // Per-thread permission `mode` (owner `!config mode …`): a vetted preset whose
    // allow/ask loosen the room base, but whose deny is UNIONed with the room deny
    // + floor — so a thread loosens what it auto-allows but never drops a
    // terminal-set deny. Tiers then apply on top (only tighten).
    const mode = this.channelConfigFor(channelId).permissionPreset
    const base = mode ? applyModeToProfile(storedProfile, mode) : storedProfile
    const turnProfile = resolveProfileForActor(
      base,
      storedProfile.tiers,
      opts.senderKindKind,
      opts.senderId,
    )
    const recorder = TurnRecorder.restore(
      this.ledger,
      { agentKey: this.key, approverUserId, channelId },
      opts.inboundHash,
      opts.promptHash,
    )
    // Claim the DM handle onTurnPrompted opened for this prompt, if it ran
    // first; otherwise it will attach to this activeTurn when it resumes. The
    // get+delete and the activeTurn assignment are one synchronous block, so the
    // reconciliation with onTurnPrompted is race-free (see pendingDmByPrompt).
    const abort = new AbortController()
    const pendingDm = this.pendingDmByPrompt.get(opts.promptHash)
    this.pendingDmByPrompt.delete(opts.promptHash)
    session.activeTurn = { promptHash: opts.promptHash, recorder, dmHandle: pendingDm ?? noopDm(), abort }

    const meta: TurnMeta = {
      senderId: opts.senderId,
      kind: opts.senderKindKind,
      messageId: opts.messageId,
      ts: opts.ts,
      channelId,
    }

    // Inject any freshly-imported session context ahead of this turn. Mark it
    // delivered only AFTER the turn succeeds (below), so a failed/stopped turn
    // re-offers it next time instead of silently swallowing it.
    const pendingCtx = this.sessionSharing.pendingContext(channelId)
    // Prepend this scope's persona blocks (role + end-goal, owner !config overlay)
    // ahead of any imported shared-context, read per-turn so a mid-session change
    // takes effect next turn (it rides the Driver's per-turn contextPrefix slot).
    const personaPrefix = this.personaBlocksFor(channelId)
    const contextPrefix = [personaPrefix, pendingCtx.prefix].filter(Boolean).join('\n\n') || undefined

    // Per-turn runtime knobs (model/thinking/effort), resolved per-thread. The
    // claude-sdk adapter honors them; ACP self-manages and ignores them.
    const turnCfg = this.channelConfigFor(channelId)
    const turnOptions = {
      ...(turnCfg.model ? { model: turnCfg.model } : {}),
      ...(turnCfg.thinking ? { thinking: turnCfg.thinking } : {}),
      ...(turnCfg.effort ? { effort: turnCfg.effort } : {}),
    }

    let chunks: string[] = []
    let turnError: string | undefined
    try {
      chunks = await session.driver.runTurn(opts.promptText, meta, abort.signal, contextPrefix, turnProfile, turnOptions)
    } catch (e) {
      turnError = e instanceof Error ? e.message : String(e)
      this.ui.error(this.key, `turn failed: ${turnError}`)
    }

    // A 🛑 stop suppresses the (partial) reply in favour of a short note, so the
    // channel and the ledger both close the turn cleanly.
    const stopped = abort.signal.aborted
    const replyText = stopped
      ? '⏹ Stopped by owner.'
      : chunks.join('\n').trim() || undefined
    await recorder
      .finishTurn(replyText)
      .catch(err => this.ui.error(this.key, `ledger finish turn: ${err}`))

    // Finalize the DM transcript with any error; the reply text already
    // landed in the Turn fold which the courier subscribes to.
    void session.activeTurn?.dmHandle.finalize(turnError).catch(() => {})
    session.activeTurn = undefined

    // Transition the inbound reaction to a persistent outcome marker.
    let outcome: 'done' | 'failed' | 'stopped'
    if (stopped) outcome = 'stopped'
    else if (turnError || !replyText) outcome = 'failed'
    else outcome = 'done'
    void this.markInboundOutcome(opts.inboundHash, outcome).catch(() => {})

    // Confirmed delivery: mark the imported context delivered only on a genuine
    // success (outcome 'done'). Gating on `outcome` rather than `!turnError`
    // matters because driver.runTurn resolves adapter failures as error-text
    // chunks (it never rejects) — so a failed or empty-reply turn (outcome
    // 'failed') re-injects the context next time instead of silently losing it.
    if (outcome === 'done') {
      this.sessionSharing.confirmDelivered(channelId, pendingCtx.freshHashes)
    }

    return { chunks, error: turnError }
  }

  // ─── Session management ───────────────────────────────────────────────────

  private getOrCreateSession(
    channelId: ChannelId,
    liveAgent: AgentConfig,
    room: AgentConfig['rooms'][string],
  ): Session {
    const existing = this.sessions.get(channelId)
    if (existing) return existing

    // The adapter's deny floor (applyPolicy) is the real enforcement point —
    // read the ROOM's profile, resolving scope→room so a threaded session is
    // governed by the same floor as a top-level one.
    const profile = readRoomSettings(this.key, this.roomForScope(channelId) ?? channelId)
    const adapter = makeAdapter(liveAgent.runtime, {
      workspace: liveAgent.workspace,
      watchTools: this.watchControl.toolsFor(channelId),
      sandbox: liveAgent.sandbox,
    })
    const ctx: PreambleContext = {
      identity: {
        name: liveAgent.name,
        ownerUserId: liveAgent.ownerUserId,
        blurb: liveAgent.blurb,
      },
      rosterLines: buildRosterLinesForRoom(room),
      canWatch: runtimeSelfArmsWatches(liveAgent.runtime),
    }
    const created: Session = {
      driver: new Driver(
        adapter,
        channelId,
        profile,
        async req => {
          // Phase 3 permission handler: post Discord prompt; wait on the ledger.
          const session = this.sessions.get(channelId)
          const at = session?.activeTurn
          if (!at) return { behavior: 'deny', message: 'no active turn for permission' }
          const toolReqHash = at.recorder.popPendingForVerdict(req.toolName, req.input)
          await this.approvals
            .postDiscord({
              channelId,
              toolRequestedHash: toolReqHash,
              toolName: req.toolName,
              input: req.input,
            })
            .catch(err => this.ui.error(this.key, `approvals post: ${err}`))
          // Per-channel approval timeout override (`!config approval-timeout`),
          // else awaitVerdict's default.
          return awaitVerdict(this.store, toolReqHash, this.approvalTimeoutFor(channelId))
        },
        ctx,
      ),
    }
    adapter.onEvent((event: AgentEvent) => {
      this.ui.event(this.key, event)
      const at = created.activeTurn
      if (at) {
        void at.recorder
          .onAdapterEvent(event)
          .catch(err => this.ui.error(this.key, `ledger adapter event: ${err}`))
      }
    })

    // Rebind a persisted resume binding so an owner's resume survives a restart.
    // Stale bindings are cleared, not honored: a runtime change (can't resume a
    // foreign runtime) or a workspace change (would resume a session from the
    // OLD workspace — a quieter cross-workspace leak). A deleted/unknown session
    // id is caught at run time by the adapter's graceful fresh-session fallback.
    const binding = readSessionBinding(this.key, channelId)
    if (binding) {
      const runtimeOk = sessionRuntimeForAgent(liveAgent.runtime) === binding.runtime
      const workspaceOk = !binding.workspace || binding.workspace === liveAgent.workspace
      if (runtimeOk && workspaceOk) {
        created.driver.bindSession(binding.sessionId)
        this.ui.note(this.key, `rebinding ${binding.runtime} session ${binding.sessionId.slice(0, 8)} in ${channelId}`)
      } else {
        clearSessionBinding(this.key, channelId)
      }
    }

    this.sessions.set(channelId, created)
    return created
  }

  // ─── Discord helpers ──────────────────────────────────────────────────────

  private noteBotMsg(id: string): void {
    this.recentBotMsgIds.add(id)
    if (this.recentBotMsgIds.size > RECENT_BOT_MSG_CAP) {
      const first = this.recentBotMsgIds.values().next().value
      if (first) this.recentBotMsgIds.delete(first)
    }
  }

  /**
   * Mention POLICY (platform-agnostic, lives here): a message is "directed at us"
   * if the platform natively addressed us (m.mentionsBot), if a configured
   * mention pattern matches the text, or if it replies to one of THIS host's
   * recent messages. The reply check first consults the in-process recent-bot-id
   * set (the dedup cache), then asks the adapter whether the referenced message
   * was authored by the bot (the old fetchReference fallback).
   */
  private async isMentioned(m: IncomingMessage, mentionPatterns?: string[]): Promise<boolean> {
    if (m.mentionsBot) return true

    const refId = m.replyToMessageId
    if (refId) {
      if (this.recentBotMsgIds.has(refId)) return true
      if (await this.messaging.authoredByBot(m.scope, refId)) return true
    }

    return matchesMentionPattern(m.text, mentionPatterns)
  }
}

function noopDm(): DmTurnHandle {
  return { finalize: async () => {} }
}
