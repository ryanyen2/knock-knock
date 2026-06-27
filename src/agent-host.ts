/**
 * AgentHost — Discord ↔ ledger adapter. handleInbound gates a message and admits a
 * `channel.message`; the synchronizer chain does the rest. Owns the per-channel
 * Session (Driver + adapter) since adapter instances are per-process.
 */

import { makeMessagingAdapter } from './adapters-msg/index.ts'
import { outboundFileNotice, parseChoiceReply } from './messaging-fallback.ts'
import type {
  MessagingAdapter,
  MessageRef,
  IncomingMessage,
  IncomingAttachment,
  IncomingAction,
  IncomingReaction,
  Choice,
  WebhookRequest,
  WebhookResponse,
} from './messaging-adapter.ts'
import {
  readSessionBinding,
  writeSessionBinding,
  clearSessionBinding,
} from './state.ts'
import {
  type AgentConfig,
  type Access,
  type RoomConfig,
  type RoomParticipant,
  type PreambleContext,
  guildSenderAllowed,
  githubAssociationTrusted,
  senderKind,
  buildRosterLinesForRoom,
  approverForAgent,
  isShareSessionCommand,
  isResumeSessionCommand,
  resolveChannelForScope,
  resolveReactionScope,
  resolveProfileForActor,
  resolveRoomProfile,
  threadNameFromPrompt,
  matchesMentionPattern,
  wrapChannelRole,
  wrapChannelGoal,
  pickFreshCoordination,
  parseDelegateCommand,
  selectRelatedContext,
  wrapRelatedContext,
  selectThreadRecap,
  wrapThreadRecap,
  peerDirectoryParticipants,
  isDirectoryBot,
  isMeshLine,
  extractKeywords,
  type RetrievalCandidate,
  type RecapSource,
  formatAttachedFilesBlock,
  parseShareCommand,
  classifyTool,
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
import type { RelayUI } from './console-ui.ts'
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
import { join, relative, resolve, isAbsolute, dirname, basename } from 'path'
import { mkdirSync, writeFileSync, readFileSync, realpathSync, statSync } from 'fs'
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
import { MeshSync } from './host/mesh-sync.ts'
import { CONFIG_FOLD, configFor, resolveConfigFor, type ConfigFoldState } from './ledger/concepts/config.ts'
import { COORD_BOARD_FOLD, boardFor, type CoordBoardFoldState } from './ledger/concepts/coordination-board.ts'
import { CHANNEL_FOLD, type ChannelFoldState } from './ledger/concepts/channel.ts'
import {
  AGENT_DIRECTORY_FOLD,
  dirArtifact,
  directoryFor,
  type AgentDirectoryFoldState,
} from './ledger/concepts/agent-directory.ts'
import { taskArtifact } from './ledger/concepts/task-dag.ts'

const RECENT_BOT_MSG_CAP = 200

/** Set a key on a Map, FIFO-evicting the oldest entry when it exceeds `cap`. */
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
  /** The coding-agent runtime this session was built for. A `!config agent` change
   *  makes the resolved runtime differ, which forces a rebuild in getOrCreateSession. */
  runtime: string
  /** True until the first turn completes (or a resume binding is rebound): the runtime
   *  has no memory of this scope yet, so a cold session is fed a `<thread-recap>`. */
  cold: boolean
  /** In-flight turn metadata for adapter event fanout. */
  activeTurn?: {
    promptHash: Hash
    recorder: TurnRecorder
    dmHandle: DmTurnHandle
    /** Aborts this turn when the owner reacts 🛑. */
    abort: AbortController
  }
}

/** Inbound-related messaging state synchronization callbacks resolve against. */
type InboundSideTable = {
  ref: MessageRef
  ackEmoji: string
  senderLabel: string
  channelLabel: string
  userPrompt: string
  /** Full inbound attachments (incl. signed/expiring URLs). Held in-process only —
   *  never persisted (the URL expires + leaks its signature). */
  attachments?: IncomingAttachment[]
}

export class AgentHost {
  private readonly messaging: MessagingAdapter
  private readonly approvals: Approvals
  private readonly courier: DmCourier
  /** Activation state (daemon/idle mode). Active = picked at boot (has a pane); idle =
   *  connected-and-listening but no pane/session until its first message wakes it. Defaults
   *  to active so non-daemon launches are unchanged. Coding-agent sessions are lazy either
   *  way, so an idle host costs only its gateway connection. */
  private active = true
  /** Called the first time an idle host admits an inbound message (it wakes). The relay
   *  uses this to allocate a TUI pane / promote the bot. Set by the relay; no-op otherwise. */
  onWake?: (key: string) => void
  private readonly sessions = new Map<ChannelId, Session>()
  private readonly inboundRate = new Map<string, number[]>()
  private readonly recentBotMsgIds = new Set<string>()
  /** Interactive choice prompts awaiting a TEXT reply (buttons/reactions absent). */
  private readonly pendingChoicePrompts = new PendingChoicePrompts()
  /** Dedup net for duplicate inbound DELIVERIES (Slack double-event, poll/webhook
   *  retries) keyed by `${scope} ${messageId}`. Orthogonal to reply-claim
   *  (which dedups WHICH agent answers, not duplicate deliveries of one message). */
  private readonly seenInbound = new Set<string>()
  /** Inbound side-table keyed by channel.message hash. Consumed by the turn.prompted
   *  subscriber (DmCourier kickoff) and turn.replied (ack cleanup). */
  private readonly inboundByHash = new Map<Hash, InboundSideTable>()
  /** Per-scope ingested files not yet delivered into a turn. Removed only after the
   *  turn succeeds, so a failed turn re-offers them. */
  private readonly pendingIngestedByScope = new Map<ChannelId, { relpath: string; kind: string; hash: Hash }[]>()
  private readonly conflictUI: ConflictUI
  private readonly watchControl: WatchControl
  private readonly sessionSharing: SessionSharing
  private readonly channelConfig: ChannelConfigControl
  private readonly contextControl: ContextControl
  /** Scope → room (parent channel): the seam between the scope the ledger keys on
   *  and the room profiles/roster/routing key on. Populated on inbound + thread creation. */
  private readonly scopeToRoom = new Map<ChannelId, ChannelId>()
  /** Inbound message id → the task scope it spawned, so a 🛑/🔁 on the original
   *  message resolves to its thread. FIFO-bounded, lost on restart (fine — no turn in flight). */
  private readonly taskScopeByMessage = new Map<string, ChannelId>()
  /** Per-scope set of coordination-board digests already injected, so a static
   *  board isn't re-delivered every turn (same lifetime as the turn loop). */
  private readonly coordDelivered = new Map<ChannelId, Set<string>>()
  /** Per-scope set of related-context blocks already injected (once-only). */
  private readonly relatedDelivered = new Map<ChannelId, Set<string>>()
  /** DM-courier handles awaiting their turn's activeTurn. onTurnPrompted and
   *  runTurnForChannel race on the same turn.prompted; whichever runs second reconciles here. */
  private readonly pendingDmByPrompt = new Map<Hash, DmTurnHandle>()
  private readonly workbench: Workbench
  /** Pinned per-thread config/setup card. */
  private readonly configCard: ConfigCard
  private storeUnsub?: () => void
  /** No-Postgres cross-machine transport (publish/ingest coordination over the
   *  messaging channel). Constructed on connect only when mesh is enabled. */
  private mesh?: MeshSync
  private meshEnabled = false

  constructor(
    private readonly key: string,
    private readonly agent: AgentConfig,
    private readonly getAccess: () => Access,
    private readonly ui: RelayUI,
    private readonly ledger: Ledger,
    private readonly store: Store,
    private readonly engine: FoldEngine,
  ) {
    // The host speaks only the MessagingAdapter seam from here on — no platform SDK.
    this.messaging = makeMessagingAdapter(agent.platform ?? 'discord')

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
      // Register/clear the Allow/Deny prompt so a text reply ("allow"/"1") can
      // resolve it where buttons/reactions are unavailable (GitHub, Notion).
      (scope, messageId, choices) => this.pendingChoicePrompts.add(scope, messageId, choices),
      (scope, messageId) => this.pendingChoicePrompts.remove(scope, messageId),
    )

    this.courier = new DmCourier(
      this.messaging,
      this.engine,
      () => liveAgentGetter().ownerUserId,
      reason => this.ui.note(this.key, reason),
    )

    // Shared capabilities the UI collaborators reach back into — no host back-reference.
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
      registerChoicePrompt: (scope, messageId, choices) =>
        this.pendingChoicePrompts.add(scope, messageId, choices),
      clearChoicePrompt: (scope, messageId) => this.pendingChoicePrompts.remove(scope, messageId),
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

    // The adapter normalizes platform events into these three handlers.
    this.messaging.onMessage(m => {
      this.handleInbound(m).catch(e =>
        this.ui.error(this.key, `handleInbound error: ${e}`),
      )
    })

    this.messaging.onAction(action => this.dispatchAction(action))

    this.messaging.onReaction(reaction => {
      const emoji = reaction.glyph
      if (emoji === '✅' || emoji === '❌') {
        this.approvals.resolveReaction(reaction.ref.id, emoji, reaction.userId).catch(e =>
          this.ui.error(this.key, `reaction error: ${e}`),
        )
        return
      }
      // A 🛑/🔁 on the original top-level message must reach the turn in its spawned thread.
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

    // turn.prompted → start the DmCourier. (The 👀→done/failed transition is owned
    // by runTurnForChannel, which knows outcomes that never reach turn.replied.)
    this.storeUnsub = this.store.subscribe(i => {
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return
      if (i.verb === 'turn.prompted') void this.onTurnPrompted(i.hash, i.caused_by[0])
      // file.received is admitted in the same wave, BEFORE the turn is prompted;
      // buffering here lets the very turn the file rode in on see it.
      else if (i.verb === 'file.received') this.bufferIngestedFile(i)
    })
  }

  async start(token: string): Promise<void> {
    // Resolve any extra secrets the adapter declared (Slack app token, GitHub App
    // key, …) from the bot's secretEnv map → process.env, keyed by logical name.
    // Single-token adapters (Discord, Telegram) declare none and get {}.
    const secrets: Record<string, string> = {}
    const needed = this.messaging.requiredSecrets ?? []
    const secretEnv = this.agent.secretEnv ?? {}
    // Resolve every declared secret (required + optional, e.g. a webhook secret) from
    // its env var, then warn only for missing REQUIRED ones — an unset optional secret
    // (no webhook configured) is fine.
    for (const [name, envName] of Object.entries(secretEnv)) {
      const value = envName ? process.env[envName] : undefined
      if (value) secrets[name] = value
    }
    for (const name of needed) {
      if (!secrets[name]) {
        this.ui.note(this.key, `missing secret "${name}" (set ${secretEnv[name] ?? `secretEnv.${name}`})`)
      }
    }
    // Apply runtime config (tracked rooms scope the poll/sweep; intake selects
    // poll vs webhook) before connecting. No-op on adapters without `configure`.
    this.messaging.configure?.({
      trackedRooms: Object.keys(this.agent.rooms),
      ...(this.agent.intake ? { intake: this.agent.intake } : {}),
    })
    await this.messaging.connect(token, secrets)
    this.ui.connected(this.key, this.messaging.botLabel ?? this.messaging.botUserId ?? this.key)
    // Start the mesh transport BEFORE publishing identity, so this bot's own
    // `agent.identity` admit is broadcast over the mesh and peers' directories converge.
    if (this.meshEnabled && !this.mesh) {
      this.mesh = new MeshSync({
        store: this.store,
        ownKey: this.key,
        directory: () => this.directoryIdentities(),
        resolveRoom: scope => this.roomForScope(scope),
        allRooms: () => Object.keys((this.getAccess().agents[this.key] ?? this.agent).rooms),
        send: (scope, text) => this.messaging.send(scope, text),
        noteBotMsg: id => this.noteBotMsg(id),
        log: msg => this.ui.note(this.key, msg),
      })
      this.mesh.start()
    }
    await this.publishIdentity().catch(err => this.ui.error(this.key, `publish identity: ${err}`))
  }

  /** Enable the no-Postgres cross-machine mesh transport for this host. Set by the
   *  relay when the backend is SQLite and mesh is explicitly turned on; takes effect
   *  at connect. No-op on Postgres (the relay never calls it there). */
  enableMesh(): void {
    this.meshEnabled = true
  }

  /** Publish this bot's platform identity to the shared agent directory so peers — co-resident
   *  AND cross-machine — can discover and address it (anchor `none`, admitted applied; the
   *  relay stamps agentKey/userId from THIS bot, so it can only publish itself). Re-published
   *  each connect; content-addressed ⇒ idempotent, and a changed label/rooms supersedes by LWW. */
  private async publishIdentity(): Promise<void> {
    const userId = this.messaging.botUserId
    if (!userId) return // platform id not resolved (e.g. poll adapters without a self id)
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    await admit(this.store, {
      actor: this.key,
      role: 'agent',
      channel: 'agent-directory',
      target: { artifactId: dirArtifact(this.key), anchor: { kind: 'none' } },
      verb: 'agent.identity',
      patch: {
        kind: 'identity',
        data: {
          agentKey: this.key,
          platform: this.platform,
          userId,
          ...(this.messaging.botLabel ? { label: this.messaging.botLabel } : {}),
          ...(liveAgent.blurb ? { blurb: liveAgent.blurb } : {}),
          rooms: Object.keys(this.agent.rooms),
        },
      },
      effect: 'pure',
      caused_by: [],
    })
  }

  /** This host's bot key (the access.json bot id) — used to route webhook paths. */
  get botKey(): string {
    return this.key
  }

  /** Whether this host is active (vs idle/listening). */
  get isActive(): boolean {
    return this.active
  }

  /** Mark this host idle (daemon mode): connected and listening, but no pane/session
   *  until its first inbound message wakes it. */
  setIdle(): void {
    this.active = false
  }

  /** The messaging platform this host speaks (e.g. 'github', 'notion'). */
  get platform(): string {
    return this.messaging.platform
  }

  /** Whether this host's adapter is in event-driven (webhook) intake mode — the relay
   *  uses this to decide whether to open the shared WebhookReceiver. */
  get usesWebhookIntake(): boolean {
    return this.agent.intake === 'webhook' && typeof this.messaging.ingestWebhook === 'function'
  }

  /** Feed a pushed webhook to this host's adapter (event-driven intake). Delegates to
   *  the adapter, which parses + emits via its `onMessage` handler. 501 if the adapter
   *  has no webhook support. */
  async ingestWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.messaging.ingestWebhook) return { status: 501 }
    return this.messaging.ingestWebhook(req)
  }

  async stop(): Promise<void> {
    this.storeUnsub?.()
    this.mesh?.stop()
    this.workbench.stop()
    this.configCard.stop()
    await this.messaging.disconnect()
  }

  // ─── Synchronization callbacks (used by sync wiring in relay.ts) ──────────

  /**
   * Resolve a scope to the room (parent channel) this host serves, or undefined.
   * Every room-scoped lookup (routing, profile, roster, approver) goes through here,
   * so a threaded turn resolves to the SAME floor as a top-level one — never an empty profile.
   */
  roomForScope(scopeId: ChannelId): ChannelId | undefined {
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const roomId = resolveChannelForScope(scopeId, liveAgent.rooms, this.scopeToRoom, id =>
      this.messaging.parentOfSync(id),
    )
    if (roomId && roomId !== scopeId) this.scopeToRoom.set(scopeId, roomId)
    return roomId
  }

  /** Async cache-warming variant of `roomForScope`: on a cold-cache miss (e.g. a
   *  synced conflict card for an unseen thread) pay the async parentOf probe once,
   *  then declare unserved. Keeps the hot sync path untouched. */
  async ensureRoomForScope(scopeId: ChannelId): Promise<ChannelId | undefined> {
    const sync = this.roomForScope(scopeId)
    if (sync) return sync
    // Bound the probe so a slow platform API can't hang the calling sync wave.
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5_000))
    const parent = await Promise.race([
      this.messaging.parentOf(scopeId).catch(() => undefined),
      timeout,
    ])
    if (!parent) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    if (!liveAgent.rooms[parent]) return undefined
    this.scopeToRoom.set(scopeId, parent)
    return parent
  }

  /** reply-claim: "who responds on this scope?" — yes iff this host serves
   *  the room, plus the room's resolved loop-guard opts. */
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

  /** Record the task scope a top-level message spawned, FIFO-bounded. */
  private rememberTaskScope(messageId: string, scope: ChannelId): void {
    boundedMapSet(this.taskScopeByMessage, messageId, scope, 1000)
  }

  /** Make an absolute edit path workspace-relative. Undefined when the scope is
   *  unserved or the file escapes the workspace — only in-workspace edits become
   *  versionable artifacts (artifact id stays stable across machines). */
  relativizeWorkspacePath(scope: ChannelId, absFilePath: string): string | undefined {
    const ws = this.workspaceForScope(scope)
    if (!ws) return undefined
    const abs = isAbsolute(absFilePath) ? absFilePath : resolve(ws, absFilePath)
    const rel = relative(ws, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return rel
  }

  /** The workspace folder for a scope — per-(bot,channel): the agent runs in
   *  `rooms[channel].workspace`, so containment + ingest/share resolve against the
   *  SAME folder. Falls back to the bot default, then undefined when unserved. */
  private workspaceForScope(scope: ChannelId): string | undefined {
    const roomId = this.roomForScope(scope)
    if (!roomId) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    return liveAgent.rooms[roomId]?.workspace ?? liveAgent.workspace
  }

  // ─── File ingest (deps for the ingest-attachment synchronization) ─────────────

  /** Inbound file support + per-file cap for the surface serving `scope`, or
   *  undefined when this host doesn't serve the scope or the platform delivers no
   *  files. The ingest sync skips when this is undefined. */
  inboundFileCap(scope: ChannelId): { maxBytes: number } | undefined {
    if (!this.roomForScope(scope)) return undefined
    const files = this.messaging.capabilities().files
    return files?.inbound ? { maxBytes: files.maxBytes } : undefined
  }

  /** The full inbound attachments for a channel.message hash, from the in-process
   *  side table. Empty on a peer relay that didn't receive the message. */
  loadInboundAttachments(hash: Hash): IncomingAttachment[] {
    return this.inboundByHash.get(hash)?.attachments ?? []
  }

  /** Fetch an inbound attachment's bytes at ingest time (URLs expire). */
  async downloadInboundAttachment(att: IncomingAttachment): Promise<Uint8Array | undefined> {
    return this.messaging.downloadAttachment?.(att.url, att.ref)
  }

  /** Materialize `bytes` into the workspace under `inbox/<safeName>`, returning the
   *  relative path. Undefined when unserved or the path escapes the workspace. */
  async materializeAttachment(
    scope: ChannelId,
    safeName: string,
    bytes: Uint8Array,
  ): Promise<string | undefined> {
    const ws = this.workspaceForScope(scope)
    if (!ws) return undefined
    const relIntended = join('inbox', safeName)
    const abs = resolve(ws, relIntended)
    // Containment: the resolved path must stay inside the workspace.
    const rel = this.relativizeWorkspacePath(scope, abs)
    if (!rel) return undefined
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, bytes)
      return rel
    } catch (e) {
      this.ui.error(this.key, `materializeAttachment failed for ${scope}: ${e}`)
      return undefined
    }
  }

  /** Post a short best-effort note back to a scope. Fire-and-forget. */
  noteToScope(scope: ChannelId, text: string): void {
    void this.messaging.send(scope, text).catch(() => {})
  }

  // ─── Ingested-file delivery ───────────────────────────────────────────────────

  /** Buffer a file.received so the next turn in its scope learns the path. */
  private bufferIngestedFile(i: import('./ledger/interaction.ts').Interaction): void {
    if (i.patch.kind !== 'external') return
    // Only the host SERVING this scope buffers — the file lives only in the
    // receiving machine's workspace; without this guard a peer accumulates undrainable entries.
    if (!this.roomForScope(i.channel)) return
    const args = i.patch.intent.args as { relpath?: string; kind?: string } | undefined
    if (!args?.relpath) return
    const list = this.pendingIngestedByScope.get(i.channel) ?? []
    if (list.some(f => f.hash === i.hash)) return // idempotent (replay/double-fanout)
    list.push({ relpath: args.relpath, kind: args.kind ?? 'file', hash: i.hash })
    if (list.length > 50) list.splice(0, list.length - 50)
    this.pendingIngestedByScope.set(i.channel, list)
  }

  /** The scope's not-yet-delivered ingested files + hashes. Does NOT clear —
   *  runTurnForChannel confirms delivery only after the turn succeeds. */
  peekPendingIngested(scope: ChannelId): {
    files: { relpath: string; kind: string }[]
    freshHashes: Hash[]
  } {
    const list = this.pendingIngestedByScope.get(scope) ?? []
    return {
      files: list.map(f => ({ relpath: f.relpath, kind: f.kind })),
      freshHashes: list.map(f => f.hash),
    }
  }

  /** Drop the named ingested files from the scope's pending buffer (called after
   *  a turn genuinely succeeds, so a failed turn re-offers them). */
  confirmIngestedDelivered(scope: ChannelId, hashes: readonly Hash[]): void {
    if (hashes.length === 0) return
    const drop = new Set(hashes)
    const list = (this.pendingIngestedByScope.get(scope) ?? []).filter(f => !drop.has(f.hash))
    if (list.length) this.pendingIngestedByScope.set(scope, list)
    else this.pendingIngestedByScope.delete(scope)
  }

  // ─── Outbound file share ────────────────────────────────────────────────────────

  /** Owner `!share <relpath>`: admit a file.shared request. Owner-gated at the call site. */
  async handleShareCommand(scope: ChannelId, text: string, requesterId: string): Promise<void> {
    const parsed = parseShareCommand(text)
    if (!parsed) {
      this.noteToScope(scope, 'usage: `!share <path-in-workspace>`')
      return
    }
    const prior = await this.store.latestInChannel(scope)
    await admit(this.store, {
      actor: requesterId,
      role: 'owner',
      channel: scope,
      target: { artifactId: discordArtifact(scope), anchor: { kind: 'none' } },
      verb: 'file.shared',
      patch: {
        kind: 'external',
        intent: {
          channel: this.messaging.platform,
          op: 'requested',
          args: { relpath: parsed.relpath, requestedBy: 'owner' },
        },
      },
      effect: 'external',
      caused_by: prior ? [prior.hash] : [],
    })
  }

  /** Read `relpath` from the workspace for an outbound share; containment lives here. */
  async resolveShareFile(
    scope: ChannelId,
    relpath: string,
  ): Promise<{ name: string; bytes: Uint8Array } | { error: string }> {
    const ws = this.workspaceForScope(scope)
    if (!ws) return { error: 'no workspace for this scope' }
    const abs = isAbsolute(relpath) ? relpath : resolve(ws, relpath)
    const rel = this.relativizeWorkspacePath(scope, abs)
    if (!rel) return { error: 'path is outside the workspace' }
    const target = join(ws, rel)
    // Symlink-escape guard: string containment above can't catch a symlink to a
    // secret outside the workspace — resolve the real path and re-check before reading.
    try {
      const real = realpathSync(target)
      if (this.relativizeWorkspacePath(scope, real) === undefined) {
        return { error: 'path resolves outside the workspace' }
      }
      // Size guard before reading into memory.
      const cap = this.messaging.capabilities().files?.maxBytes ?? 10 * 1024 * 1024
      const st = statSync(real)
      if (!st.isFile()) return { error: 'not a file' }
      if (st.size > cap) return { error: 'file is too large to share' }
      const bytes = new Uint8Array(readFileSync(real))
      return { name: basename(rel), bytes }
    } catch {
      return { error: 'file not found or unreadable' }
    }
  }

  /** Classify a FileShare of `relpath` against the scope's room profile. Fail to
   *  'deny' when unserved (the secret floor). */
  classifyShareFor(scope: ChannelId, relpath: string): 'allow' | 'ask' | 'deny' {
    const profile = this.auditProfileForScope(this.key, scope)
    if (!profile) return 'deny'
    return classifyTool(profile, { toolName: 'FileShare', subject: relpath })
  }

  /** Send a file out to a scope; degrades to a text notice where the platform can't
   *  attach files. Returns whether it was handled. */
  async sendFileToScope(scope: ChannelId, name: string, bytes: Uint8Array): Promise<boolean> {
    const caps = this.messaging.capabilities()
    if (!caps.files?.outbound) {
      const notice = outboundFileNotice([{ name }], caps)
      if (notice) await this.messaging.send(scope, notice).catch(() => {})
      return true
    }
    const ref = await this.messaging
      .send(scope, `shared \`${name}\``, { files: [{ name, data: bytes }] })
      .catch(() => undefined)
    if (ref) this.noteBotMsg(ref.id)
    return !!ref
  }

  /** Where on disk does this vers: artifact live? Undefined when unserved. */
  resolveVersionablePath(artifactId: string): string | undefined {
    const parsed = parseVersionableId(artifactId)
    if (!parsed) return undefined
    const ws = this.workspaceForScope(parsed.scope)
    return ws ? join(ws, parsed.relPath) : undefined
  }

  /** drive-turn: a handle to run the adapter here. */
  getDriveHandle(channelId: ChannelId): DriveTurnHandle | undefined {
    if (!this.getAgentForChannel(channelId)) return undefined
    return {
      run: async opts => this.runTurnForChannel(channelId, opts),
    }
  }

  /** post-on-reply sends a chunk; returns the message id. A failed send throws so
   *  post-on-reply aborts the remaining chunks rather than dropping one silently. */
  async discordSend(channelId: ChannelId, text: string): Promise<string | undefined> {
    const ref = await this.messaging.send(channelId, text)
    if (!ref) throw new Error(`messaging.send failed for ${channelId}`)
    this.noteBotMsg(ref.id)
    return ref.id
  }

  /** The platform's max message length, for post-on-reply chunking. */
  get maxMessageLength(): number {
    return this.messaging.capabilities().maxMessageLength
  }

  /** Relay subscriber → refresh a turn's Workbench message (throttled). */
  updateWorkbench(scopeId: ChannelId, promptHash: Hash): void {
    this.workbench.updateForTurn(scopeId, promptHash)
  }

  /** Owner reacted 🛑 — abort the in-flight turn via its AbortController. No-op if
   *  there's no active turn or the reactor isn't this agent's owner. */
  private async handleStop(channelId: ChannelId, userId: string): Promise<void> {
    if (!this.getAgentForChannel(channelId)) return
    const at = this.sessions.get(channelId)?.activeTurn
    if (!at) return
    const ownerId = this.getOwnerForChannel(channelId)
    if (!ownerId || userId !== ownerId) return
    this.ui.note(this.key, `stop requested in ${channelId}`)
    at.abort.abort()
  }

  /** Owner reacted ⏪/🔁/🧷 on one of this bot's messages. Requires the reaction to
   *  be on THIS host's message (recentBotMsgIds, which also dedups across hosts) and
   *  the reactor to be the channel owner. 🔁 re-runs via retry-on-reaction; ⏪/🧷 record. */
  private async handleRewind(
    messageId: string,
    rawChannelId: string,
    userId: string,
    action: RewindAction,
  ): Promise<void> {
    if (!this.recentBotMsgIds.has(messageId)) return // not our message / dedup
    await this.applyRewind(rawChannelId, userId, action)
  }

  /** The post-guard rewind/retry/checkpoint core, shared by the reaction path
   *  (`handleRewind`, gated on "our message") and the owner text commands
   *  (`!retry`/`!rewind`/`!checkpoint`, which carry no specific message). */
  private async applyRewind(
    channelId: string,
    userId: string,
    action: RewindAction,
  ): Promise<void> {
    if (!this.getAgentForChannel(channelId)) return
    const ownerId = this.getOwnerForChannel(channelId)
    if (!ownerId || userId !== ownerId) return

    const channelArtifactId = discordArtifact(channelId)
    const frontier = await this.store.channelFrontier(channelId)

    if (action === 'retry') {
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

  /** dm-on-supersede sends an owner a short override note. */
  async dmUser(userId: string, text: string): Promise<string | undefined> {
    const ref = await this.messaging.dm(userId, text)
    return ref?.id
  }

  /** conflict-card posts a card for a held conflict. */
  async postConflictCard(post: ConflictCardPost): Promise<string | undefined> {
    // Warm the scope→room cache first: a synced-edit conflict can arrive for an
    // unseen thread, where the owner lookup would otherwise miss and drop the card.
    await this.ensureRoomForScope(post.channelId)
    return this.conflictUI.postCard(post)
  }

  // ─── Session resume (owner-only) ───────────────────────────────────────────

  /** Bind a scope's Driver to an existing runtime session and persist it so resume
   *  survives a restart. Only valid when the runtime can continue that session;
   *  else fall the owner back to import. Delegated from SessionSharing. */
  private async resumeSession(
    action: IncomingAction,
    scopeId: ChannelId,
    summary: SessionSummary,
  ): Promise<void> {
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const roomId = this.roomForScope(scopeId)
    const room = roomId ? liveAgent.rooms[roomId] : undefined
    // Resume compatibility is judged against this channel's effective (membership-scoped) runtime.
    const effectiveRuntime = room?.runtime ?? liveAgent.runtime
    if (!room || sessionRuntimeForAgent(effectiveRuntime) !== summary.runtime) {
      await action.respond(
        `This agent (${effectiveRuntime}) can't resume a ${summary.runtime} session — try "share session" to import its context instead.`,
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

  /** Owner/approver for a scope this host serves, else undefined. Approver is
   *  per-room, so resolve scope→room first. */
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

  /** The base profile the audit-only classify-on-tool-request sync matches against:
   *  the room profile with the thread's `mode` applied, but no per-actor tiers (audit
   *  stays on the base — tier deny ⊇ base deny). Undefined when unserved. */
  auditProfileForScope(agentKey: string, scopeId: ChannelId): PermissionProfile | undefined {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return undefined
    // Inline profile + re-unioned DENY_FLOOR — same resolution the enforced profile uses.
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const base = resolveRoomProfile(liveAgent.rooms[roomId]?.profile)
    const mode = this.channelConfigFor(scopeId).permissionPreset
    return mode ? applyModeToProfile(base, mode) : base
  }

  /** Route an interactive action to the right resolver by id prefix. Shared by the
   *  adapter's button/`onAction` path and the text-reply fallback (`tryResolveTextChoice`). */
  private dispatchAction(action: IncomingAction): void {
    if (action.actionId.startsWith('appr:')) {
      this.approvals.resolve(action).catch(e => this.ui.error(this.key, `interaction error: ${e}`))
    } else if (this.conflictUI.handles(action)) {
      this.conflictUI.resolve(action).catch(e => this.ui.error(this.key, `conflict resolve error: ${e}`))
    } else if (this.sessionSharing.handles(action)) {
      this.sessionSharing.handlePick(action).catch(e => this.ui.error(this.key, `session pick error: ${e}`))
    }
  }

  /** Text-reply fallback for platforms without buttons/usable reactions: if the
   *  inbound message answers a choice prompt pending in its scope, resolve it
   *  through the same path a button click would and report handled. Synthesizes an
   *  `IncomingAction` targeting the PROMPT's message id (resolvers key off it). */
  private tryResolveTextChoice(m: IncomingMessage): boolean {
    const hit = this.pendingChoicePrompts.match(m.scope, m.text)
    if (!hit) return false
    const action: IncomingAction = {
      actionId: hit.actionId,
      userId: m.authorId,
      ref: { id: hit.messageId, scope: m.scope },
      scope: m.scope,
      message: '',
      respond: async (text) => {
        await this.messaging.send(m.scope, text).catch(() => undefined)
      },
      update: async (text, opts) => {
        await this.messaging.edit({ id: hit.messageId, scope: m.scope }, text, opts).catch(() => false)
      },
    }
    this.dispatchAction(action)
    return true
  }

  // ─── Inbound (skinny) ─────────────────────────────────────────────────────

  /** Get or create the task thread for a top-level message (race-tolerant). Undefined
   *  if a thread can't be created, so the caller falls back to the channel. */
  private async ensureTaskThread(m: IncomingMessage): Promise<ChannelId | undefined> {
    return this.messaging.startThread(m.ref, threadNameFromPrompt(m.text))
  }

  private async handleInbound(m: IncomingMessage): Promise<void> {
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent
    const botId = this.messaging.botUserId

    // Room = the parent text channel (profile, roster, allowlist); a thread inherits its parent.
    const roomId = m.isThread
      ? (this.messaging.parentOfSync(m.scope) ?? m.scope)
      : m.scope
    const room = liveAgent.rooms[roomId]
    if (!room) return

    if (m.authorId === botId) return

    // Coordination line from a peer (the no-Postgres mesh transport): decode + append
    // to the local ledger so folds/synchronizations light up as a NOTIFY would have.
    // Never a chat turn — return before any engagement gating. The decoder authenticates
    // the peer (provenance) and rejects anything outside the coordination allowlist.
    if (this.mesh && isMeshLine(m.text)) {
      await this.mesh.ingest(m.text, m.authorId)
      return
    }

    // Dedup net: drop a duplicate DELIVERY of the same message (Slack's double
    // event, poll/webhook retries, offset overlap) before it can spawn a 2nd turn.
    const inboundKey = `${m.scope} ${m.ref.id}`
    if (this.seenInbound.has(inboundKey)) return
    this.seenInbound.add(inboundKey)
    if (this.seenInbound.size > 2000) {
      const first = this.seenInbound.values().next().value
      if (first) this.seenInbound.delete(first)
    }

    const ownerId = liveAgent.ownerUserId
    // Auto-discovered peer bots (from the shared directory) merged into the room's
    // participants so they're both heard (allowlist) and addressable (roster) — covers
    // co-resident siblings AND cross-machine collaborators with no manual roster entry.
    const gateRoom = this.roomWithPeers(roomId, room)
    // Sender allowlist (owner + roster + discovered peers). On the open GitHub surface,
    // also admit a trusted repo author (OWNER/MEMBER/COLLABORATOR) so a repo's real
    // collaborators work without being re-listed — the deny floor + ask-first still bound them.
    const trustedByPlatform =
      this.messaging.platform === 'github' && githubAssociationTrusted(m.authorAssociation)
    if (!guildSenderAllowed(gateRoom, m.authorId, botId, ownerId) && !trustedByPlatform) return

    // Per-channel overlay (owner `!config`): rate cap, require-mention, mention
    // patterns, ack. Room-keyed — these gate inbound BEFORE a thread exists (raw room overlay).
    const cfg = this.roomConfigRaw(roomId)
    const rateWindowMs = cfg.rateWindowMs ?? 60_000
    const rateCap = cfg.rateCapPerMin ?? 10
    const now = Date.now()
    const recent = (this.inboundRate.get(m.authorId) ?? []).filter(t => now - t < rateWindowMs)
    if (recent.length >= rateCap) return
    this.inboundRate.set(m.authorId, [...recent, now])

    // Text-reply fallback: if this message answers a choice prompt pending in its
    // scope (approval / conflict / session), resolve it the same way a button would
    // and stop — never admit it as a turn prompt. This makes those controls usable
    // on platforms without buttons/usable reactions (GitHub, Notion), and is gated
    // to a pending prompt so ordinary "1"/"allow" prose still flows through normally.
    if (this.tryResolveTextChoice(m)) return

    // require-mention: overlay > RoomConfig > default-on. UX only — guildSenderAllowed gates who.
    const requireMention = cfg.requireMention ?? room.requireMention ?? true
    const mentionPatterns = [...(access.mentionPatterns ?? []), ...(cfg.mentionPatterns ?? [])]
    let mentioned = await this.isMentioned(m, mentionPatterns)
    // A peer BOT (in the directory) engages this bot ONLY when it explicitly @mentions or
    // replies to it — regardless of the room's require-mention setting — so two bots don't
    // loop on every broadcast in a busy multi-bot channel. Humans keep the behavior below.
    const senderIsPeerBot = isDirectoryBot(this.directoryIdentities(), m.authorId)
    // Thread follow-up (Discord parity): a message in a thread the bot is already
    // engaged in is a follow-up to that task, so it triggers without a fresh
    // @mention. Platforms like Slack have no per-message reply pointer in a thread,
    // so engagement (a live session, or prior admitted history in the scope) is the
    // signal. Plain-channel scopes still require a mention. Peer bots are exempt — they
    // must address this bot explicitly even in an engaged thread.
    if (!mentioned && !senderIsPeerBot && m.isThread && (await this.isEngagedThread(m.scope))) {
      mentioned = true
    }
    if ((requireMention || senderIsPeerBot) && !mentioned) return

    this.messaging.typing(m.scope)

    const kind = senderKind(gateRoom, m.authorId, ownerId)

    // Owner control commands act at the scope they're TYPED in and never spawn a thread.
    const controlScope = m.isThread ? m.scope : roomId

    // Owner share/resume-session — short-circuit before any admit. NOT admitted as a
    // channel.message, so the agent is never prompted with it (prompt-injection invariant).
    if (kind === 'owner' && (isShareSessionCommand(m.text) || isResumeSessionCommand(m.text))) {
      this.scopeToRoom.set(controlScope, roomId)
      const mode = isResumeSessionCommand(m.text) ? 'resume' : 'import'
      await this.sessionSharing.offer(controlScope, mode).catch(e =>
        this.ui.error(this.key, `offer session ${mode}: ${e}`),
      )
      return
    }

    // Owner watch control (!watch / !unwatch) — short-circuit before admit. NOT
    // admitted, so a watch can't be armed by a peer talking (prompt-injection invariant).
    if (kind === 'owner' && (m.text.startsWith('!watch') || m.text.startsWith('!unwatch'))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.watchControl.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `watch command: ${e}`),
      )
      return
    }

    // Owner per-channel config (!config) — short-circuit before any admit. NOT admitted,
    // so a peer/injection can't reach the config write path. Tunes the behavioral
    // overlay only — identity/allowlist/permissions stay terminal-managed.
    if (kind === 'owner' && (m.text === '!config' || m.text.startsWith('!config '))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.channelConfig.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `config command: ${e}`),
      )
      return
    }

    // Owner per-thread context surface (!context) — short-circuit before admit. NOT
    // admitted, so a peer can't curate context. View/add/remove shared-context notes.
    if (kind === 'owner' && (m.text === '!context' || m.text.startsWith('!context '))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.contextControl.handleCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `context command: ${e}`),
      )
      return
    }

    // Owner file share (!share <relpath>) — short-circuit before any admit. The owner
    // curates what leaves the machine (the consent); the share-file sync still refuses
    // a credential path/content (secret floor holds even for the owner).
    if (kind === 'owner' && (m.text === '!share' || m.text.startsWith('!share '))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.handleShareCommand(controlScope, m.text, m.authorId).catch(e =>
        this.ui.error(this.key, `share command: ${e}`),
      )
      return
    }

    // Owner task delegation (!delegate) — short-circuit before any admit. NOT admitted
    // as a channel.message, so only the owner (never a peer/injection) can seed tasks.
    if (kind === 'owner' && (m.text === '!delegate' || m.text.startsWith('!delegate'))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.handleDelegateCommand(controlScope, m.text).catch(e =>
        this.ui.error(this.key, `delegate command: ${e}`),
      )
      return
    }

    // Owner turn controls as text — the platform-agnostic equivalent of the 🛑/🔁/⏪/🧷
    // reactions, so stop/retry/rewind/checkpoint work where reactions are absent or
    // restricted (GitHub, Notion). Owner-gated + short-circuited before admit, like the
    // commands above. They act in the scope they're typed in (a thread for a task).
    const control = m.text.trim()
    if (kind === 'owner' && control === '!stop') {
      this.scopeToRoom.set(controlScope, roomId)
      await this.handleStop(controlScope, m.authorId).catch(e => this.ui.error(this.key, `stop command: ${e}`))
      return
    }
    const rewindCmd: RewindAction | undefined =
      control === '!retry' ? 'retry' : control === '!rewind' ? 'rewind' : control === '!checkpoint' ? 'checkpoint' : undefined
    if (kind === 'owner' && rewindCmd) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.applyRewind(controlScope, m.authorId, rewindCmd).catch(e =>
        this.ui.error(this.key, `${rewindCmd} command: ${e}`),
      )
      return
    }

    // Resolve the task scope. A thread message stays in its thread; a top-level
    // @mention spawns (or reuses) a task thread; a top-level non-mention stays at the
    // channel. Thread-creation failure degrades to the channel.
    let scopeId: ChannelId
    if (m.isThread) {
      scopeId = m.scope
    } else if (mentioned) {
      scopeId = (await this.ensureTaskThread(m)) ?? m.scope
    } else {
      scopeId = m.scope
    }
    this.scopeToRoom.set(scopeId, roomId)
    // So a 🛑/🔁 reaction on the original message resolves to the thread it spawned.
    if (scopeId !== m.scope) this.rememberTaskScope(m.ref.id, scopeId)
    // Surface the thread's pinned setup card (no-op for a plain-channel scope).
    this.configCard.refresh(scopeId)

    // Admit channel.message — all handleInbound does. URL-free descriptors persist
    // so the ingest sync knows files rode along; the real handles stay in-process.
    const channelArtifactId = discordArtifact(scopeId)
    const prior = await this.store.latestInChannel(scopeId)
    const attachmentMeta = m.attachments?.length
      ? m.attachments.map(a => ({ name: a.name, sizeBytes: a.sizeBytes, contentType: a.contentType }))
      : undefined
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
          // Stamp which bot this inbound is for so prompt-on-message routes to it
          // (two bots in one channel don't cross-handle); attachments ride along.
          args: {
            text: m.text,
            messageId: m.ref.id,
            targetAgent: this.key,
            ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
          },
        },
      },
      effect: 'external',
      caused_by: prior ? [prior.hash] : [],
    })
    if (inboundResult.kind !== 'admitted') return

    // Wake on first message (daemon/idle mode): this host just admitted a message, so all
    // the gates (allowlist, mention, rate, reply-claim/targeting) already decided it should
    // engage — promote it to active so it gets a pane. The turn then drives normally
    // (reply-claim → drive-turn → lazy session). Quiet by design: no chat message.
    if (!this.active) {
      this.active = true
      try { this.onWake?.(this.key) } catch {}
    }

    // Stash messaging context so sync-driven UX can react/edit the inbound later.
    const channelLabel = m.scopeLabel ?? `#${roomId}`
    const ackEmoji = cfg.ackReaction ?? access.ackReaction ?? '👀'
    // FIFO-bounded: markInboundOutcome no longer deletes (a 🔁 retry re-marks the same inbound).
    boundedMapSet(this.inboundByHash, inboundResult.interaction.hash, {
      ref: m.ref,
      ackEmoji,
      senderLabel: m.authorName,
      channelLabel,
      userPrompt: m.text,
      attachments: m.attachments,
    }, 500)

    this.ui.turnStart(this.key, {
      channel: { label: channelLabel },
      sender: { label: m.authorName, kind },
      text: m.text,
    })

    // Ack reaction (👀 = received/working); markInboundOutcome swaps it for an outcome glyph.
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
      // Reconcile with runTurnForChannel order-independently: attach directly if the
      // activeTurn exists, else stash for it to pick up. Synchronous after the await,
      // so exactly one of the two paths attaches the handle.
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

  /** Transition the inbound reactions when a turn winds down: drop the transient 👀
   *  and add a persistent outcome marker (done/failed/stopped). Called from
   *  runTurnForChannel for every outcome (a crash never reaches turn.replied). */
  private async markInboundOutcome(
    inboundHash: Hash,
    outcome: 'done' | 'failed' | 'stopped',
  ): Promise<void> {
    const side = this.inboundByHash.get(inboundHash)
    if (!side) return
    // Keep the side-table: a 🔁 retry re-runs this inbound and must re-mark its outcome.
    const glyph =
      outcome === 'stopped' ? GLYPHS.stopped : outcome === 'failed' ? GLYPHS.failed : GLYPHS.done
    // Drop the ack and any prior outcome glyph first, so a retried message never stacks two.
    void this.messaging.unreact(side.ref, side.ackEmoji).catch(() => {})
    for (const g of [GLYPHS.done, GLYPHS.failed, GLYPHS.stopped]) {
      if (g !== glyph) void this.messaging.unreact(side.ref, g).catch(() => {})
    }
    void this.messaging.react(side.ref, glyph).catch(() => {})
  }

  /** The session whose active turn matches this promptHash, if one exists yet. */
  private sessionForPrompt(promptHash: Hash): Session | undefined {
    for (const sess of this.sessions.values()) {
      if (sess.activeTurn?.promptHash === promptHash) return sess
    }
    return undefined
  }

  /** Stash a DM handle for runTurnForChannel to claim, FIFO-bounded. */
  private rememberPendingDm(promptHash: Hash, handle: DmTurnHandle): void {
    boundedMapSet(this.pendingDmByPrompt, promptHash, handle, 256)
  }

  // ─── Adapter driver (called by drive-turn via getDriveHandle) ─────────────

  /** The scope-resolved config overlay (thread ⊕ room), or {} if unresolved. The
   *  per-turn read seam: role, end-goal, loop-guard, timeout, model/thinking/effort, mode. */
  private channelConfigFor(scopeId: ChannelId): ChannelConfig {
    const roomId = this.roomForScope(scopeId)
    if (!roomId) return {}
    try {
      return resolveConfigFor(this.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId, scopeId)
    } catch {
      return {}
    }
  }

  /** The raw room overlay (no scope merge), for the inbound gate — which runs BEFORE
   *  a thread exists, so rate-cap/require-mention/mention/ack are room-keyed. */
  private roomConfigRaw(roomId: ChannelId): ChannelConfig {
    try {
      return configFor(this.engine.get<ConfigFoldState>(CONFIG_FOLD), roomId)
    } catch {
      return {}
    }
  }

  /** This scope's persona blocks (role + end-goal, each wrapped), joined, or undefined.
   *  Read fresh per turn so a `!config role/end-goal` change takes effect next turn. */
  private personaBlocksFor(scopeId: ChannelId): string | undefined {
    const cfg = this.channelConfigFor(scopeId)
    const blocks = [
      cfg.role ? wrapChannelRole(cfg.role) : undefined,
      cfg.endGoal ? wrapChannelGoal(cfg.endGoal) : undefined,
    ].filter(Boolean)
    return blocks.length ? blocks.join('\n\n') : undefined
  }

  /** This scope's approval timeout override (ms), or undefined for the default. */
  private approvalTimeoutFor(scopeId: ChannelId): number | undefined {
    return this.channelConfigFor(scopeId).approvalTimeoutMs
  }

  /** Owner `!delegate` → seed the task DAG. Parsed purely (cycles/dupes rejected),
   *  then each task admitted as an AGENT-role task.created (actor = this bot, relaying the
   *  owner's intent) on the scope's task artifact. The task-scheduler sync (U9) takes it
   *  from there. Agent-authored on purpose: it lets the task.created bridge over the
   *  no-Postgres mesh with the bot's directory provenance (so a peer can't forge a task
   *  with an attacker-controlled label = prompt injection); the role is inert for the
   *  task folds (they key on verb/id, never role), so this is unchanged on the Postgres path. */
  private async handleDelegateCommand(scope: ChannelId, text: string): Promise<void> {
    const parsed = parseDelegateCommand(text)
    if (!parsed) return
    if (!parsed.ok) {
      await this.discordSend(scope, `⚠️ ${parsed.error}`)
      return
    }
    for (const t of parsed.tasks) {
      await admit(this.store, {
        actor: this.key,
        role: 'agent',
        channel: scope,
        target: { artifactId: taskArtifact(scope), anchor: { kind: 'none' } },
        verb: 'task.created',
        patch: {
          kind: 'task',
          data: {
            id: t.id,
            label: t.label,
            dependsOn: t.dependsOn,
            ...(t.assignee ? { assignee: t.assignee } : {}),
          },
        },
        effect: 'pure',
        caused_by: [],
      })
    }
    const shape = parsed.tasks.map(t => (t.assignee ? `${t.id}→${t.assignee}` : t.id)).join(', ')
    await this.discordSend(scope, `📋 delegated ${parsed.tasks.length} task(s): ${shape}`)
  }

  /** A `<related-context>` block: the most relevant prior chat from OTHER threads
   *  in this room (R8). Candidate set is BOUNDED (recent messages from a few sibling
   *  scopes) before scoring, so this never scans the full log. Once-only per block. */
  private async relatedContextPrefixFor(
    scope: ChannelId,
    roomId: ChannelId,
    promptText: string,
  ): Promise<{ prefix?: string; key?: string }> {
    const siblings = [...this.scopeToRoom]
      .filter(([s, r]) => r === roomId && s !== scope)
      .map(([s]) => s)
      .slice(0, 5)
    if (siblings.length === 0) return {}
    const candidates: RetrievalCandidate[] = []
    for (const sib of siblings) {
      let rows
      try {
        rows = await this.store.listByChannel(sib)
      } catch {
        continue
      }
      for (const r of rows.slice(-20)) {
        if (r.verb !== 'channel.message' || r.patch.kind !== 'external') continue
        const text = String((r.patch.intent.args as { text?: unknown })?.text ?? '')
        if (text) candidates.push({ hash: r.hash, scope: sib, text, author: r.actor, createdAt: r.createdAt })
      }
    }
    if (candidates.length === 0) return {}
    const top = selectRelatedContext(
      candidates,
      { currentScope: scope, keywords: extractKeywords(promptText), participants: [], now: Date.now() },
      3,
    )
    const block = wrapRelatedContext(top.map(t => ({ scope: t.scope, author: t.author, text: t.text })))
    if (!block) return {}
    if ((this.relatedDelivered.get(scope) ?? new Set<string>()).has(block)) return {}
    return { prefix: block, key: block }
  }

  /** Mark a once-only delivery digest as delivered, bounding both the per-scope set
   *  (insertion-ordered trim) and the scope keyspace, so neither leaks over uptime. */
  private rememberDelivered(map: Map<ChannelId, Set<string>>, scope: ChannelId, key: string): void {
    const set = map.get(scope) ?? new Set<string>()
    set.add(key)
    if (set.size > 64) for (const k of [...set].slice(0, set.size - 64)) set.delete(k)
    boundedMapSet(map, scope, set, 500)
  }

  /** Is this agent's turn on `scopeId` live? Used by the task scheduler to gate
   *  claim renewal: when a turn ends (completion) or the relay dies (crash), there
   *  is no active turn, so the task claim lapses and another claimant fails it over.
   *  (Conservative v1: active-turn presence; finer progress-heartbeat stall
   *  detection for legitimately-long turns is a deferred refinement.) */
  isTurnLive(scopeId: ChannelId): boolean {
    return !!this.sessions.get(scopeId)?.activeTurn
  }

  /** A `<coordination>` block telling THIS agent what other agents in the scope are
   *  doing (Problem B). Once-only per distinct board content; confirmed after the
   *  turn succeeds. Returns the block + the dedupe key to confirm. */
  private coordinationPrefixFor(scopeId: ChannelId): { prefix?: string; key?: string } {
    let board
    try {
      board = boardFor(this.engine.get<CoordBoardFoldState>(COORD_BOARD_FOLD), scopeId)
    } catch {
      return {} // coordination-board fold not registered
    }
    const delivered = this.coordDelivered.get(scopeId) ?? new Set<string>()
    const { block, key } = pickFreshCoordination(board, delivered, this.key)
    return { prefix: block, key }
  }

  /** All bot identities in the shared directory (latest per agentKey), or [] if the
   *  fold isn't registered. Used to discover peers — co-resident and cross-machine. */
  private directoryIdentities(): ReturnType<typeof directoryFor> {
    try {
      return directoryFor(this.engine.get<AgentDirectoryFoldState>(AGENT_DIRECTORY_FOLD))
    } catch {
      return []
    }
  }

  /** Peer bots (others) that serve `roomId` on this platform, as participant entries to
   *  merge into the room's `participants` — so they're both addressable (roster) and
   *  heard (allowlist). */
  private peerParticipantsFor(roomId: ChannelId): Record<string, RoomParticipant> {
    return peerDirectoryParticipants(this.directoryIdentities(), this.key, roomId, this.platform)
  }

  /** The room config with auto-discovered peer bots merged into `participants` (static
   *  roster collaborators still win on a userId collision). */
  private roomWithPeers(roomId: ChannelId, room: RoomConfig): RoomConfig {
    const peers = this.peerParticipantsFor(roomId)
    if (Object.keys(peers).length === 0) return room
    return { ...room, participants: { ...peers, ...room.participants } }
  }

  /** A `<thread-recap>` block replaying this scope's prior messages — injected only
   *  for a COLD session (newly added bot, or a restart with no resume binding), so a
   *  fresh runtime catches up on the conversation instead of seeing only the latest
   *  message. Read from the durable channel transcript fold; the current inbound
   *  message is excluded (it already rides the envelope). One-shot: gated on
   *  `session.cold`, which the first completed turn clears. */
  private threadRecapPrefixFor(
    scopeId: ChannelId,
    session: Session,
    room: RoomConfig,
    liveAgent: AgentConfig,
    excludeHash: string,
  ): { prefix?: string } {
    if (!session.cold) return {}
    let state: ChannelFoldState
    try {
      state = this.engine.get<ChannelFoldState>(CHANNEL_FOLD)
    } catch {
      return {} // channel fold not registered
    }
    const entries = (state.get(scopeId) ?? []) as ReadonlyArray<RecapSource>
    const selected = selectThreadRecap(entries, { excludeHash })
    if (selected.length === 0) return {}
    const lines = selected.map(e => ({ who: this.recapLabel(room, liveAgent, e), text: e.text }))
    const block = wrapThreadRecap(lines)
    return block ? { prefix: block } : {}
  }

  /** Display label for a recap entry's author: the owner, a peer's roster name, this
   *  agent's own name for its replies, else the raw id. */
  private recapLabel(room: RoomConfig, liveAgent: AgentConfig, e: RecapSource): string {
    if (e.kind === 'reply') {
      if (e.agentKey === this.key) return liveAgent.name ?? room.participants[e.agentKey]?.name ?? e.agentKey
      return room.participants[e.agentKey]?.name ?? e.agentKey
    }
    if (e.role === 'owner') return 'owner'
    return room.participants[e.senderId]?.name ?? e.senderId
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
    // channelId is the task scope; roster/approver/profile come from the room.
    const roomId = this.roomForScope(channelId)
    const room = roomId ? liveAgent.rooms[roomId] : undefined
    if (!room || !roomId) return { chunks: [], error: 'no room' }

    const session = this.getOrCreateSession(channelId, liveAgent, room)
    const approverUserId = approverForAgent(liveAgent, roomId) ?? liveAgent.ownerUserId

    // Per-actor permission floor: the room profile is the OWNER floor; a peer/human
    // turn is narrowed by its tier. Resolved per turn, re-applied inside the serialized runTurn.
    const storedProfile = resolveRoomProfile(room.profile)
    // Per-thread `mode` applied ONLY to owner-prompted turns: it REPLACES allow/ask, so
    // applying it to a non-owner turn would auto-widen on someone else's behalf past the
    // room floor. Non-owner turns resolve from the base, then their tier narrows. (Deny always unions.)
    const mode = this.channelConfigFor(channelId).permissionPreset
    const base =
      mode && opts.senderKindKind === 'owner' ? applyModeToProfile(storedProfile, mode) : storedProfile
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
    // Claim the DM handle onTurnPrompted opened, if it ran first; else it attaches when
    // it resumes. get+delete and the activeTurn assignment are one synchronous block (race-free).
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

    // Inject freshly-imported session context; mark delivered only AFTER success
    // (below), so a failed/stopped turn re-offers it instead of swallowing it.
    const pendingCtx = this.sessionSharing.pendingContext(channelId)
    // Persona blocks (role + end-goal), read per-turn so a mid-session change applies next turn.
    const personaPrefix = this.personaBlocksFor(channelId)
    // Ingested files: an <attached-files> untrusted block; dropped only after success.
    const ingested = this.peekPendingIngested(channelId)
    const attachedFilesPrefix = ingested.files.length ? formatAttachedFilesBlock(ingested.files) : undefined
    // Coordination board: what peers are doing, injected once per distinct board.
    const coordCtx = this.coordinationPrefixFor(channelId)
    // Related prior chat from sibling threads (R8), bounded + once-only.
    const relatedCtx = await this.relatedContextPrefixFor(channelId, roomId, opts.promptText)
    // Thread recap: catch a COLD session up on this thread's prior messages (newly
    // added bot / restart with no resume binding). One-shot — gated on session.cold.
    const recapCtx = this.threadRecapPrefixFor(channelId, session, room, liveAgent, opts.inboundHash)
    const contextPrefix =
      [personaPrefix, recapCtx.prefix, coordCtx.prefix, relatedCtx.prefix, attachedFilesPrefix, pendingCtx.prefix]
        .filter(Boolean)
        .join('\n\n') || undefined

    // Per-turn runtime knobs (model/thinking/effort): claude-sdk honors them, ACP ignores them.
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

    // A 🛑 stop suppresses the partial reply in favour of a short note.
    const stopped = abort.signal.aborted
    const replyText = stopped
      ? '⏹ Stopped by owner.'
      : chunks.join('\n').trim() || undefined
    await recorder
      .finishTurn(replyText)
      .catch(err => this.ui.error(this.key, `ledger finish turn: ${err}`))

    // Finalize the DM transcript with any error (the reply text already landed in the Turn fold).
    void session.activeTurn?.dmHandle.finalize(turnError).catch(() => {})
    session.activeTurn = undefined

    // Transition the inbound reaction to a persistent outcome marker.
    let outcome: 'done' | 'failed' | 'stopped'
    if (stopped) outcome = 'stopped'
    else if (turnError || !replyText) outcome = 'failed'
    else outcome = 'done'
    void this.markInboundOutcome(opts.inboundHash, outcome).catch(() => {})

    // Mark context delivered only on genuine success: gating on `outcome` (not
    // `!turnError`) matters because driver.runTurn resolves adapter failures as
    // error-text chunks, so a failed turn re-injects the context next time.
    if (outcome === 'done') {
      this.sessionSharing.confirmDelivered(channelId, pendingCtx.freshHashes)
      this.confirmIngestedDelivered(channelId, ingested.freshHashes)
      if (coordCtx.key) this.rememberDelivered(this.coordDelivered, channelId, coordCtx.key)
      if (relatedCtx.key) this.rememberDelivered(this.relatedDelivered, channelId, relatedCtx.key)
      // The runtime now holds this scope: warm, so the recap is a one-shot.
      session.cold = false
      // Persist the runtime session id so a restart resumes the real conversation
      // (not just a text recap). Only for resume-capable runtimes; the workspace is
      // recorded so getOrCreateSession's rebind guard can reject a cross-workspace resume.
      const effectiveRuntime = room.runtime ?? liveAgent.runtime
      const sessRuntime = sessionRuntimeForAgent(effectiveRuntime)
      const sid = session.driver.currentSessionId
      if (sessRuntime && sid) {
        try {
          writeSessionBinding(this.key, channelId, {
            runtime: sessRuntime,
            sessionId: sid,
            workspace: room.workspace ?? liveAgent.workspace,
          })
        } catch (err) {
          this.ui.error(this.key, `persist session binding: ${err}`)
        }
      }
    }

    return { chunks, error: turnError }
  }

  // ─── Session management ───────────────────────────────────────────────────

  private getOrCreateSession(
    channelId: ChannelId,
    liveAgent: AgentConfig,
    room: AgentConfig['rooms'][string],
  ): Session {
    // Runtime resolves config-first: `!config agent` (owner-only) overrides the
    // per-channel Membership.runtime and the bot default. Resolve it before the cache
    // check so a chat-driven switch rebuilds the session instead of reusing a stale one.
    const runtime = this.channelConfigFor(channelId).runtime ?? room.runtime ?? liveAgent.runtime
    const existing = this.sessions.get(channelId)
    if (existing) {
      if (existing.runtime === runtime) return existing
      // Coding agent switched in chat: drop the stale session and its resume binding
      // (a foreign runtime can't resume — same guard as the rebind below) so a fresh
      // adapter is built for the new runtime.
      this.sessions.delete(channelId)
      clearSessionBinding(this.key, channelId)
      this.ui.note(this.key, `coding agent → ${runtime} in ${channelId} (new session)`)
    }

    // applyPolicy is the real enforcement point; resolveRoomProfile re-unions DENY_FLOOR
    // so a threaded session is floored the same as a top-level one even for older profiles.
    const profile = resolveRoomProfile(room.profile)
    // Workspace is membership-scoped (a bot is a portal); fall back to the bot default.
    const workspace = room.workspace ?? liveAgent.workspace
    // A Notion bot gets page-scoped read/write tools (claude-sdk only) so it can write
    // INTO the page instead of editing local files. The page IS the scope (channelId);
    // the token is the bot's transport token, resolved from its tokenEnv.
    const notionToken =
      liveAgent.platform === 'notion' ? process.env[liveAgent.tokenEnv] : undefined
    const adapter = makeAdapter(runtime, {
      workspace,
      watchTools: this.watchControl.toolsFor(channelId),
      ...(notionToken ? { notion: { token: notionToken, pageId: channelId } } : {}),
    })
    const ctx: PreambleContext = {
      identity: {
        name: liveAgent.name,
        ownerUserId: liveAgent.ownerUserId,
        blurb: liveAgent.blurb,
      },
      // Roster includes auto-discovered peer bots (co-resident + cross-machine) so the
      // agent has a real <@id> to address them with — and never has to address itself.
      rosterLines: buildRosterLinesForRoom(
        this.roomWithPeers(this.roomForScope(channelId) ?? channelId, room),
      ),
      canWatch: runtimeSelfArmsWatches(runtime),
      ...(notionToken
        ? {
            platformNote:
              'You are working on a Notion PAGE (not Discord). Your chat reply is posted as a COMMENT on the page. ' +
              'To change the page itself, use the notion tools: read_page to see current content, append_to_page to write ' +
              'paragraphs INTO the page body. When asked to add/write/describe something "in the page", use append_to_page — ' +
              'do NOT edit local files to satisfy a page-editing request.',
          }
        : {}),
    }
    const created: Session = {
      runtime,
      // Cold until proven warm: a fresh session has no runtime memory of this scope.
      // A valid resume binding (rebound below) clears it; so does the first completed turn.
      cold: true,
      driver: new Driver(
        adapter,
        channelId,
        profile,
        async req => {
          // Permission handler: post Discord prompt; wait on the ledger verdict.
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
          // Per-channel approval timeout override, else awaitVerdict's default.
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

    // Rebind a persisted resume binding so it survives a restart. Stale bindings are
    // cleared, not honored: a runtime change (can't resume a foreign runtime) or a
    // workspace change (would resume from the OLD workspace — a cross-workspace leak).
    const binding = readSessionBinding(this.key, channelId)
    if (binding) {
      const runtimeOk = sessionRuntimeForAgent(runtime) === binding.runtime
      const workspaceOk = !binding.workspace || binding.workspace === workspace
      if (runtimeOk && workspaceOk) {
        created.driver.bindSession(binding.sessionId)
        // The runtime resumes its own transcript, so it already holds this thread —
        // warm, no recap needed.
        created.cold = false
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

  /** Mention policy: directed at us if the platform addressed us, a mention pattern
   *  matches, or it replies to one of THIS host's recent messages (recentBotMsgIds
   *  cache first, then the adapter's authoredByBot fallback). */
  /** Is the bot already engaged in this (thread) scope? A live in-process session
   *  is the fast path; otherwise any prior admitted interaction in the scope means
   *  the bot was triggered here before (admission only happens past the mention
   *  gate), so the scope survives a restart. Used to let thread follow-ups run
   *  without a fresh @mention. */
  private async isEngagedThread(scope: ChannelId): Promise<boolean> {
    if (this.sessions.has(scope)) return true
    try {
      return Boolean(await this.store.latestInChannel(scope))
    } catch {
      return false
    }
  }

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

/** Tracks interactive choice prompts awaiting a text reply, per scope. At most a
 *  handful are live at once (one card/approval per scope), so plain Maps suffice;
 *  the per-scope inner map is keyed by the prompt's message id. */
class PendingChoicePrompts {
  private readonly byScope = new Map<ChannelId, Map<string, Choice[]>>()

  add(scope: ChannelId, messageId: string, choices: Choice[]): void {
    let inner = this.byScope.get(scope)
    if (!inner) {
      inner = new Map()
      this.byScope.set(scope, inner)
    }
    inner.set(messageId, choices)
  }

  remove(scope: ChannelId, messageId: string): void {
    const inner = this.byScope.get(scope)
    if (!inner) return
    inner.delete(messageId)
    if (inner.size === 0) this.byScope.delete(scope)
  }

  /** First pending prompt in `scope` whose choices `text` unambiguously selects.
   *  Most-recently-registered wins (insertion order, last first). */
  match(scope: ChannelId, text: string): { messageId: string; actionId: string } | undefined {
    const inner = this.byScope.get(scope)
    if (!inner) return undefined
    const entries = [...inner.entries()].reverse()
    for (const [messageId, choices] of entries) {
      const actionId = parseChoiceReply(text, choices)
      if (actionId) return { messageId, actionId }
    }
    return undefined
  }
}
