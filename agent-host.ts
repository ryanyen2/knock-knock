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

import {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  type Message,
  type ThreadChannel,
  type Interaction,
  type ButtonInteraction,
} from 'discord.js'
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
  resolveProfileForActor,
  threadNameFromPrompt,
  type WatchSpec,
} from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { makeAdapter, runtimeSelfArmsWatches } from './adapters/index.ts'
import { Approvals } from './approvals.ts'
import { ConsoleUI } from './console-ui.ts'
import { DmCourier, type TurnHandle as DmTurnHandle } from './dm-courier.ts'
import type { AgentEvent } from './agent-adapter.ts'
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
import { ConflictUI } from './host/conflict-ui.ts'
import { WatchControl } from './host/watch-control.ts'
import { SessionSharing } from './host/session-sharing.ts'

const RECENT_BOT_MSG_CAP = 200

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
 *  inbound-related Discord state (ack reactions, DmCourier headers). */
type InboundSideTable = {
  msg: Message
  ackEmoji: string
  senderLabel: string
  channelLabel: string
  userPrompt: string
}

export class AgentHost {
  private readonly client: Client
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
  /** Scope (a thread id, or a plain channel id) → the room (parent channel) it
   *  belongs to. The single seam between the task scope the ledger keys on and
   *  the room that permission profiles / roster / routing key on. Populated on
   *  inbound and on thread creation. */
  private readonly scopeToRoom = new Map<ChannelId, ChannelId>()
  /** §4.1 per-scope pinned activity log. */
  private readonly workbench: Workbench
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
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Message, Partials.Reaction, Partials.Channel],
    })

    const liveAgentGetter = () => getAccess().agents[this.key] ?? this.agent

    this.approvals = new Approvals(
      this.client,
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
      this.client,
      this.engine,
      () => liveAgentGetter().ownerUserId,
      reason => this.ui.note(this.key, reason),
    )

    // The shared capabilities the UI collaborators reach back into. Built once;
    // bundles only what they need so none holds a back-reference to the host.
    const ctx: HostContext = {
      key: this.key,
      client: this.client,
      store: this.store,
      engine: this.engine,
      ledger: this.ledger,
      ui: this.ui,
      getAccess: () => this.getAccess(),
      roomForScope: id => this.roomForScope(id),
      getOwnerForChannel: id => this.getOwnerForChannel(id),
      discordSend: (id, text) => this.discordSend(id, text),
      noteBotMsg: id => this.noteBotMsg(id),
    }
    this.workbench = new Workbench(ctx)
    this.conflictUI = new ConflictUI(ctx)
    this.watchControl = new WatchControl(ctx, this.approvals)
    this.sessionSharing = new SessionSharing(ctx, (interaction, scopeId, summary) =>
      this.resumeSession(interaction, scopeId, summary),
    )

    this.client.once('clientReady', c => {
      this.ui.connected(this.key, c.user.tag)
    })

    this.client.on('messageCreate', (msg: Message) => {
      this.handleInbound(msg).catch(e =>
        this.ui.error(this.key, `handleInbound error: ${e}`),
      )
    })

    this.client.on('interactionCreate', (interaction: Interaction) => {
      if (!interaction.isButton()) return
      if (interaction.customId.startsWith('appr:')) {
        this.approvals.resolveInteraction(interaction).catch(e =>
          this.ui.error(this.key, `interaction error: ${e}`),
        )
      } else if (this.conflictUI.handles(interaction)) {
        this.conflictUI.resolve(interaction).catch(e =>
          this.ui.error(this.key, `conflict resolve error: ${e}`),
        )
      } else if (this.sessionSharing.handles(interaction)) {
        this.sessionSharing.handlePick(interaction).catch(e =>
          this.ui.error(this.key, `session pick error: ${e}`),
        )
      }
    })

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user.bot) return
      const emoji = reaction.emoji.name
      if (!emoji) return
      if (emoji === '✅' || emoji === '❌') {
        this.approvals.resolveReaction(reaction.message.id, emoji, user.id).catch(e =>
          this.ui.error(this.key, `reaction error: ${e}`),
        )
        return
      }
      if (emoji === GLYPHS.stop) {
        this.handleStop(reaction.message.channelId, user.id).catch(e =>
          this.ui.error(this.key, `stop error: ${e}`),
        )
        return
      }
      const action = rewindActionFor(emoji)
      if (action) {
        this.handleRewind(reaction.message.id, reaction.message.channelId, user.id, action).catch(
          e => this.ui.error(this.key, `rewind error: ${e}`),
        )
      }
    })

    this.client.on('error', err => {
      this.ui.error(this.key, `client error: ${err}`)
    })

    // Side-effect subscriber: turn.prompted → start the DmCourier. The
    // 👀→done/failed reaction transition is owned by runTurnForChannel (it
    // knows the turn's outcome, including failures that never reach
    // turn.replied). Ledger-driven work; only Discord bookkeeping lives here.
    this.storeUnsub = this.store.subscribe(i => {
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return
      if (i.verb === 'turn.prompted') void this.onTurnPrompted(i.hash, i.caused_by[0])
    })
  }

  async start(token: string): Promise<void> {
    await this.client.login(token)
  }

  async stop(): Promise<void> {
    this.storeUnsub?.()
    this.workbench.stop()
    await this.client.destroy()
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
    const roomId = resolveRoomForScope(scopeId, liveAgent.rooms, this.scopeToRoom, id => {
      const ch = this.client.channels.cache.get(id) as { parentId?: string | null } | undefined
      return ch?.parentId ?? undefined
    })
    // Memoize a freshly-probed thread→parent mapping so the next lookup is cheap.
    if (roomId && roomId !== scopeId) this.scopeToRoom.set(scopeId, roomId)
    return roomId
  }

  /** prompt-on-message asks "who responds on this scope?" — yes iff this host
   *  serves the room the scope belongs to. */
  getAgentForChannel(scopeId: ChannelId): { agentKey: string } | undefined {
    return this.roomForScope(scopeId) ? { agentKey: this.key } : undefined
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

  /** post-on-reply sends a chunk; we return the resulting Discord message id. */
  async discordSend(channelId: ChannelId, text: string): Promise<string | undefined> {
    const ch = await this.client.channels.fetch(channelId).catch(() => null)
    if (!ch || !('send' in ch)) return undefined
    const sent = await (ch as { send: (t: string) => Promise<{ id: string }> }).send(text)
    this.noteBotMsg(sent.id)
    return sent.id
  }

  /** Relay subscriber → refresh this scope's pinned Workbench (throttled). */
  updatePill(scopeId: ChannelId): void {
    this.workbench.updatePill(scopeId)
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
    try {
      const user = await this.client.users.fetch(userId)
      const dm = await user.createDM()
      const sent = await dm.send(text)
      return sent.id
    } catch {
      return undefined
    }
  }

  /** §4.2 — the conflict-card synchronization posts a card for a held conflict. */
  async postConflictCard(post: ConflictCardPost): Promise<string | undefined> {
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
    interaction: ButtonInteraction,
    scopeId: ChannelId,
    summary: SessionSummary,
  ): Promise<void> {
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const roomId = this.roomForScope(scopeId)
    const room = roomId ? liveAgent.rooms[roomId] : undefined
    if (!room || sessionRuntimeForAgent(liveAgent.runtime) !== summary.runtime) {
      await interaction
        .reply({
          content: `This agent (${liveAgent.runtime}) can't resume a ${summary.runtime} session — try "share session" to import its context instead.`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {})
      return
    }
    const session = this.getOrCreateSession(scopeId, liveAgent, room)
    session.driver.bindSession(summary.id)
    writeSessionBinding(this.key, scopeId, { runtime: summary.runtime, sessionId: summary.id })
    this.ui.note(this.key, `resuming ${summary.runtime} session ${summary.id.slice(0, 8)} in ${scopeId}`)
    await interaction
      .update({ content: renderSessionResumed({ runtime: summary.runtime, title: summary.title }), components: [] })
      .catch(() => {})
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

  // ─── Inbound (skinny) ─────────────────────────────────────────────────────

  /**
   * Get or create the task thread for a top-level message. Race-tolerant: if a
   * concurrent handler already started the thread, the loser catches and
   * refetches the message to pick up the winner's thread. Returns null if a
   * thread can't be created (e.g. missing permission), so the caller falls back
   * to running the task at the channel level.
   */
  private async ensureTaskThread(msg: Message): Promise<ThreadChannel | null> {
    if (msg.hasThread) return (msg.thread as ThreadChannel | null) ?? null
    try {
      return (await msg.startThread({
        name: threadNameFromPrompt(msg.content),
        autoArchiveDuration: 1440,
      })) as ThreadChannel
    } catch {
      const fresh = await msg.fetch().catch(() => null)
      return (fresh?.thread as ThreadChannel | null) ?? null
    }
  }

  private async handleInbound(msg: Message): Promise<void> {
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent

    // Room = the parent text channel: permission profile, roster, allowlist.
    // A message in a thread inherits its parent's room.
    const roomId = msg.channel.isThread()
      ? (msg.channel.parentId ?? msg.channelId)
      : msg.channelId
    const room = liveAgent.rooms[roomId]
    if (!room) return

    if (msg.author.id === this.client.user?.id) return

    const ownerId = liveAgent.ownerUserId
    if (!guildSenderAllowed(room, msg.author.id, this.client.user?.id, ownerId)) return

    const now = Date.now()
    const recent = (this.inboundRate.get(msg.author.id) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= 10) return
    this.inboundRate.set(msg.author.id, [...recent, now])

    const requireMention = room.requireMention ?? true
    const mentioned = await this.isMentioned(msg, access.mentionPatterns)
    if (requireMention && !mentioned) return

    if ('sendTyping' in msg.channel) {
      void (msg.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {})
    }

    const kind = senderKind(room, msg.author.id, ownerId)

    // Owner control commands operate at the scope they're TYPED in and never
    // spawn a task thread (they're control, not work): a command typed inside a
    // thread targets that thread; at top level it targets the channel itself.
    const controlScope = msg.channel.isThread() ? msg.channelId : roomId

    // ─── Owner share/resume-session command — short-circuit before any admit ─
    // Owner-only (kind==='owner'): list this agent's local sessions and post a
    // selection card. The command itself is NOT admitted as a channel.message,
    // so the agent is never prompted with it; config/sessions stay terminal-
    // and owner-driven (the prompt-injection invariant). A peer can't reach
    // here — senderKind only returns 'owner' for the agent's owner. 'import'
    // distills context; 'resume' continues the live session.
    if (kind === 'owner' && (isShareSessionCommand(msg.content) || isResumeSessionCommand(msg.content))) {
      this.scopeToRoom.set(controlScope, roomId)
      const mode = isResumeSessionCommand(msg.content) ? 'resume' : 'import'
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
    if (kind === 'owner' && (msg.content.startsWith('!watch') || msg.content.startsWith('!unwatch'))) {
      this.scopeToRoom.set(controlScope, roomId)
      await this.watchControl.handleCommand(controlScope, msg.content).catch(e =>
        this.ui.error(this.key, `watch command: ${e}`),
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
    if (msg.channel.isThread()) {
      scopeId = msg.channelId
    } else if (mentioned) {
      const thread = await this.ensureTaskThread(msg)
      scopeId = thread?.id ?? msg.channelId
    } else {
      scopeId = msg.channelId
    }
    this.scopeToRoom.set(scopeId, roomId)

    // ─── Admit channel.message — that's all handleInbound does in Phase 3 ───
    const channelArtifactId = discordArtifact(scopeId)
    const prior = await this.store.latestInChannel(scopeId)
    const inboundResult = await admit(this.store, {
      actor: msg.author.id,
      role: kind === 'unknown' ? 'agent' : kind,
      channel: scopeId,
      target: { artifactId: channelArtifactId, anchor: { kind: 'none' } },
      verb: 'channel.message',
      patch: {
        kind: 'external',
        intent: {
          channel: 'discord',
          op: 'received',
          args: { text: msg.content, messageId: msg.id },
        },
      },
      effect: 'external',
      caused_by: prior ? [prior.hash] : [],
    })
    if (inboundResult.kind !== 'admitted') return

    // Side-table: stash Discord context so synchronization-driven UX can
    // use the live Message object (ack reaction, DmCourier header).
    const channelLabel = await this.describeChannel(msg).catch(() => `#${roomId}`)
    const ackEmoji = access.ackReaction ?? '👀'
    this.inboundByHash.set(inboundResult.interaction.hash, {
      msg,
      ackEmoji,
      senderLabel: msg.author.username ?? msg.author.id,
      channelLabel,
      userPrompt: msg.content,
    })

    this.ui.turnStart(this.key, {
      channel: { label: channelLabel },
      sender: { label: msg.author.username ?? msg.author.id, kind },
      text: msg.content,
    })

    // Ack reaction (👀 = received/working). Swapped for a persistent 🏁 done /
    // 🛑 failed by markInboundOutcome when the turn ends. If the loop-guard
    // denies the turn, the ack stays until a TTL sweep (Phase 3.1).
    void msg.react(ackEmoji).catch(() => {})
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
      // Attach to the active turn so drive-turn can finalize the DM later.
      const session = this.sessions.get(this.channelOfPrompt(promptHash, inboundHash))
      if (session?.activeTurn?.promptHash === promptHash) {
        session.activeTurn.dmHandle = dmHandle
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
    this.inboundByHash.delete(inboundHash)
    const botId = this.client.user?.id ?? ''
    void side.msg.reactions.cache.get(side.ackEmoji)?.users.remove(botId).catch(() => {})
    const glyph =
      outcome === 'stopped' ? GLYPHS.stopped : outcome === 'failed' ? GLYPHS.failed : GLYPHS.done
    void side.msg.react(glyph).catch(() => {})
  }

  /** Looking up a session's channel from a promptHash; usually it's just
   *  the prompted interaction's `channel` field, but we may not have that
   *  in scope. Resolve via the store and fall back if needed. */
  private channelOfPrompt(_promptHash: Hash, inboundHash: Hash): ChannelId {
    // The inbound side-table is per-channel.message; we don't actually need
    // a separate lookup — the session for the same channel is what holds
    // the active turn. Resolve by scanning sessions for the matching hash.
    for (const [chanId, sess] of this.sessions.entries()) {
      if (sess.activeTurn?.promptHash === _promptHash) return chanId
    }
    // Fall back: any session whose recorder.inboundHash matches.
    for (const [chanId, sess] of this.sessions.entries()) {
      if (sess.activeTurn?.recorder.inboundHash === inboundHash) return chanId
    }
    return '' // No active turn yet — the DmCourier attach is a best-effort no-op.
  }

  // ─── Adapter driver (called by drive-turn via getDriveHandle) ─────────────

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
    // classify-on-tool-request sync keeps reading the base floor — safe because
    // tiers only ADD deny, so its pre-deny is always a subset of the enforced one.
    const storedProfile = readRoomSettings(this.key, roomId)
    const turnProfile = resolveProfileForActor(
      storedProfile,
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
    // No-op DM handle as a placeholder; replaced by onTurnPrompted's call.
    const abort = new AbortController()
    session.activeTurn = { promptHash: opts.promptHash, recorder, dmHandle: noopDm(), abort }

    const meta: TurnMeta = {
      senderId: opts.senderId,
      kind: opts.senderKindKind,
      messageId: opts.messageId,
      ts: opts.ts,
      channelId,
    }

    // Inject any freshly-imported session context once, ahead of this turn.
    const contextPrefix = this.sessionSharing.pendingContext(channelId)

    let chunks: string[] = []
    let turnError: string | undefined
    try {
      chunks = await session.driver.runTurn(opts.promptText, meta, abort.signal, contextPrefix, turnProfile)
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
          return awaitVerdict(this.store, toolReqHash)
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
    // Stale bindings (the agent's runtime changed) are cleared, not honored.
    const binding = readSessionBinding(this.key, channelId)
    if (binding) {
      if (sessionRuntimeForAgent(liveAgent.runtime) === binding.runtime) {
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

  private async isMentioned(msg: Message, mentionPatterns?: string[]): Promise<boolean> {
    if (this.client.user && msg.mentions.has(this.client.user)) return true

    const refId = msg.reference?.messageId
    if (refId) {
      if (this.recentBotMsgIds.has(refId)) return true
      try {
        const ref = await msg.fetchReference()
        if (ref.author.id === this.client.user?.id) return true
      } catch {}
    }

    for (const pat of mentionPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(msg.content)) return true
      } catch {}
    }
    return false
  }

  private async describeChannel(msg: Message): Promise<string> {
    const ch = msg.channel as { name?: string; isThread?: () => boolean; parent?: { name?: string } }
    if (msg.channel.isThread?.() && ch.parent?.name) {
      return `#${ch.parent.name} › ${ch.name ?? 'thread'}`
    }
    if (ch.name) return `#${ch.name}`
    if (msg.channel.isDMBased?.()) return 'DM'
    return `#${msg.channelId}`
  }
}

function noopDm(): DmTurnHandle {
  return { finalize: async () => {} }
}
