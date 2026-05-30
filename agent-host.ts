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
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
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
  wrapSharedContext,
  pickFreshContext,
  classifyTool,
  parseWatchCommand,
  type WatchSpec,
} from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { makeAdapter, runtimeSelfArmsWatches } from './adapters/index.ts'
import { Approvals } from './approvals.ts'
import { ConsoleUI } from './console-ui.ts'
import { DmCourier, type TurnHandle as DmTurnHandle } from './dm-courier.ts'
import type { AgentEvent, WatchToolHandlers, WatchArmPartial } from './agent-adapter.ts'
import type { Ledger } from './ledger/capture.ts'
import type { Store } from './ledger/store.ts'
import type { FoldEngine } from './ledger/fold.ts'
import { admit, surfaceToInbox } from './ledger/admit.ts'
import { awaitVerdict, DEFAULT_VERDICT_TIMEOUT_MS } from './ledger/await-verdict.ts'
import { TurnRecorder } from './ledger/turn-recorder.ts'
import type { ChannelId, Hash } from './ledger/interaction.ts'
import type { DriveTurnHandle } from './ledger/synchronizations/drive-turn.ts'
import type { ConflictCardPost } from './ledger/synchronizations/conflict-card.ts'
import {
  GLYPHS,
  LETTERS,
  NUMBERS,
  renderWorkbench,
  workbenchEntries,
  rewindActionFor,
  renderRewindAck,
  renderSessionCard,
  renderSessionImported,
  renderSessionResumed,
  type RewindAction,
} from './ledger/render/surface.ts'
import { TURN_FOLD, type TurnFoldState } from './ledger/concepts/turn.ts'
import { WATCH_FOLD, liveWatches, type WatchFoldState } from './ledger/concepts/watch.ts'
import type { WatchRunEnv } from './watch-supervisor.ts'
import {
  KNOWLEDGE_FOLD,
  activeNotes,
  type KnowledgeFoldState,
} from './ledger/artifacts/knowledge.ts'
import {
  listAllSessions,
  makeSessionStore,
  sessionRuntimeForAgent,
  type SessionSummary,
} from './sessions/index.ts'
import { distill } from './sessions/distill.ts'

const RECENT_BOT_MSG_CAP = 200
/** §4.1 max one Workbench edit per channel per this window (Discord rate limit). */
const PILL_THROTTLE_MS = 1500

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
  /** §4.2 conflict card messageId → its branch hashes, for button resolution. */
  private readonly conflictCards = new Map<string, { branchHashes: Hash[]; channelId: ChannelId }>()
  /** Share/resume card messageId → the offered sessions + mode, for resolution. */
  private readonly sessionCards = new Map<
    string,
    { sessions: SessionSummary[]; channelId: ChannelId; mode: 'import' | 'resume' }
  >()
  /** Per-channel set of shared-context note hashes already injected into the
   *  live session, so each imported brief is delivered to the agent exactly
   *  once (re-derivable; resets on restart, which only re-shows context). */
  private readonly deliveredContext = new Map<ChannelId, Set<Hash>>()
  /** §4.1 per-channel pinned pill message id. */
  private readonly pillMsgByChannel = new Map<ChannelId, string>()
  /** §4.1 throttle: pending render timer + last render time per channel. */
  private readonly pillTimers = new Map<ChannelId, ReturnType<typeof setTimeout>>()
  private readonly pillLastRender = new Map<ChannelId, number>()
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
      } else if (interaction.customId.startsWith('cflt:')) {
        this.resolveConflict(interaction).catch(e =>
          this.ui.error(this.key, `conflict resolve error: ${e}`),
        )
      } else if (interaction.customId.startsWith('sess:')) {
        this.handleSessionPick(interaction).catch(e =>
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
    for (const t of this.pillTimers.values()) clearTimeout(t)
    this.pillTimers.clear()
    await this.client.destroy()
  }

  // ─── Synchronization callbacks (used by sync wiring in relay.ts) ──────────

  /** prompt-on-message asks "who responds on this channel?" */
  getAgentForChannel(channelId: ChannelId): { agentKey: string } | undefined {
    const access = this.getAccess()
    const agent = access.agents[this.key] ?? this.agent
    return agent.rooms[channelId] ? { agentKey: this.key } : undefined
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

  /**
   * §4.1 — request a refresh of this channel's pinned Workbench. Throttled to
   * at most one Discord edit per PILL_THROTTLE_MS per channel (tool events can
   * burst); the trailing render always reads the latest Turn fold state, so the
   * activity log stays current without tripping Discord's edit rate limit.
   */
  updatePill(channelId: ChannelId): void {
    if (!this.getAgentForChannel(channelId)) return
    if (this.pillTimers.has(channelId)) return // a render is already scheduled
    const since = Date.now() - (this.pillLastRender.get(channelId) ?? 0)
    const wait = Math.max(0, PILL_THROTTLE_MS - since)
    const timer = setTimeout(() => {
      this.pillTimers.delete(channelId)
      this.pillLastRender.set(channelId, Date.now())
      void this.renderWorkbenchNow(channelId)
    }, wait)
    this.pillTimers.set(channelId, timer)
  }

  /**
   * Render and edit-in-place the Workbench from the Turn fold (shared across
   * agents, so one host renders the whole channel). Created and pinned once;
   * best-effort — a missing Manage-Messages permission just means no pin.
   */
  private async renderWorkbenchNow(channelId: ChannelId): Promise<void> {
    let text: string
    try {
      const turns = this.engine.get<TurnFoldState>(TURN_FOLD)
      // Prompt text lives on the inbound message, not the Turn fold — pre-fetch
      // it for each agent's latest turn (working OR finished) so the workbench
      // header shows what was asked, kept as the trace after the turn ends.
      const latest = new Map<string, Hash>()
      const startedAt = new Map<string, string>()
      for (const t of turns.values()) {
        if (t.channel !== channelId || !t.inboundHash) continue
        const prev = startedAt.get(t.agentKey)
        if (!prev || t.startedAt > prev) {
          startedAt.set(t.agentKey, t.startedAt)
          latest.set(t.agentKey, t.inboundHash)
        }
      }
      const prompts = new Map<Hash, string>()
      for (const inboundHash of new Set(latest.values())) {
        const inbound = await this.store.getByHash(inboundHash)
        const txt =
          inbound?.patch.kind === 'external'
            ? (inbound.patch.intent.args as { text?: string } | undefined)?.text
            : undefined
        if (txt) prompts.set(inboundHash, txt)
      }
      const entries = workbenchEntries(turns, channelId, h => (h ? prompts.get(h) : undefined))
      text = renderWorkbench(entries, new Date().toISOString())
    } catch {
      return // Turn fold not registered — pill is off.
    }
    try {
      const ch = await this.client.channels.fetch(channelId).catch(() => null)
      if (!ch || !('send' in ch)) return
      const sendable = ch as { send: Function; messages: { fetch: (id: string) => Promise<any> } }
      const existing = this.pillMsgByChannel.get(channelId)
      if (existing) {
        const msg = await sendable.messages.fetch(existing).catch(() => null)
        if (msg) {
          await msg.edit(text).catch(() => {})
          return
        }
      }
      const sent = await sendable.send(text)
      this.pillMsgByChannel.set(channelId, sent.id)
      this.noteBotMsg(sent.id)
      void sent.pin?.().catch(() => {})
    } catch {}
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
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const ownerId = approverForAgent(liveAgent, channelId) ?? liveAgent.ownerUserId
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
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const ownerId = approverForAgent(liveAgent, channelId) ?? liveAgent.ownerUserId
    if (!ownerId || userId !== ownerId) return

    const channelArtifactId = `extp:discord/${channelId}`
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

  /**
   * §4.2 — post a conflict card with Take A / Take B / … / Write buttons. The
   * branch hashes are remembered against the message so a click resolves to a
   * merge.resolve. Returns the posted message id.
   */
  async postConflictCard(post: ConflictCardPost): Promise<string | undefined> {
    const ch = await this.client.channels.fetch(post.channelId).catch(() => null)
    if (!ch || !('send' in ch)) return undefined

    const buttons = post.branchHashes.slice(0, LETTERS.length).map((_, idx) =>
      new ButtonBuilder()
        .setCustomId(`cflt:take:${idx}`)
        .setLabel(`Take ${String.fromCharCode(65 + idx)}`)
        .setEmoji(LETTERS[idx]!)
        .setStyle(ButtonStyle.Secondary),
    )
    buttons.push(
      new ButtonBuilder()
        .setCustomId('cflt:write')
        .setLabel('Write my own')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
    )
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)

    const sent = await (ch as { send: Function }).send({ content: post.text, components: [row] })
    this.conflictCards.set(sent.id, { branchHashes: post.branchHashes, channelId: post.channelId })
    this.noteBotMsg(sent.id)
    return sent.id
  }

  /** Resolve a conflict-card button click into a merge.resolve (§4.2). */
  private async resolveConflict(interaction: ButtonInteraction): Promise<void> {
    const card = this.conflictCards.get(interaction.message.id)
    if (!card) {
      await interaction.reply({ content: 'This conflict is no longer open.', ephemeral: true }).catch(() => {})
      return
    }
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const ownerId = approverForAgent(liveAgent, card.channelId) ?? liveAgent.ownerUserId
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the owner can resolve this.', ephemeral: true }).catch(() => {})
      return
    }

    if (interaction.customId === 'cflt:write') {
      await interaction
        .reply({ content: 'Reply in this channel with your merge — it supersedes both drafts.', ephemeral: true })
        .catch(() => {})
      return
    }

    const m = /^cflt:take:(\d+)$/.exec(interaction.customId)
    if (!m) return
    const idx = Number(m[1])
    const chosen = card.branchHashes[idx]
    if (!chosen) return
    const losers = card.branchHashes.filter(h => h !== chosen)

    const winner = await this.store.getByHash(chosen)
    if (!winner) return

    // Journal the owner's decision, then flip lifecycles: chosen wins, the
    // rest are superseded (kept in the ledger, surfaced back via the inbox).
    const resolve = await this.ledger.record({
      actor: ownerId,
      role: 'owner',
      channel: card.channelId,
      target: winner.target,
      verb: 'merge.resolve',
      patch: { kind: 'none' },
      effect: 'pure',
      caused_by: [...card.branchHashes].sort(),
    })
    await this.store.updateLifecycle(chosen, 'applied')
    await this.store.updateLifecycle(resolve.hash, 'applied', { supersedes: losers })
    // Flip each loser to 'superseded' AND surface the drop to its inbox — same
    // surface-back the admission gate uses (admit.ts), so a draft dropped by an
    // owner *resolution* is no longer silent: the losing agent learns of it on
    // its next "what do I know" fold, and `dm-on-supersede` DMs that agent's
    // owner. caused_by links the loser to the owner's merge.resolve.
    for (const loser of losers) {
      await this.store.updateLifecycle(loser, 'superseded')
      const peer = await this.store.getByHash(loser)
      if (peer) {
        await surfaceToInbox(this.store, peer, {
          why: `superseded by owner conflict resolution ${resolve.hash.slice(0, 10)} (took ${LETTERS[idx]})`,
          winner: resolve.hash,
          channel: card.channelId,
        })
      }
    }

    this.conflictCards.delete(interaction.message.id)
    await interaction
      .update({ content: `${interaction.message.content}\n\n-# ✓ took ${LETTERS[idx]}`, components: [] })
      .catch(() => {})
  }

  // ─── Session sharing & resume (owner-only) ─────────────────────────────────

  /** Owner asked to share/resume a session: discover this agent's local sessions
   *  (workspace-filtered). For resume, keep only sessions whose runtime this
   *  agent can actually continue. Then post the selection card. */
  private async offerSessionShare(
    channelId: ChannelId,
    liveAgent: AgentConfig,
    ownerId: string | undefined,
    mode: 'import' | 'resume',
  ): Promise<void> {
    let sessions = await listAllSessions(liveAgent.workspace, { limit: NUMBERS.length * 2 })
    if (mode === 'resume') {
      const compatible = sessionRuntimeForAgent(liveAgent.runtime)
      sessions = sessions.filter(s => s.runtime === compatible)
    }
    await this.postSessionCard(channelId, sessions.slice(0, NUMBERS.length), ownerId, mode)
  }

  /**
   * Post the share/resume card. With sessions, attaches one numbered button per
   * entry (sess:pick:<idx> for import, sess:resume:<idx> for resume) plus a
   * Cancel; empty posts the empty-state. The offered set + mode are remembered
   * against the message id (analogue of postConflictCard / conflictCards).
   */
  private async postSessionCard(
    channelId: ChannelId,
    offered: SessionSummary[],
    ownerId: string | undefined,
    mode: 'import' | 'resume',
  ): Promise<string | undefined> {
    const ch = await this.client.channels.fetch(channelId).catch(() => null)
    if (!ch || !('send' in ch)) return undefined
    const text = renderSessionCard({
      ownerId,
      mode,
      sessions: offered.map(s => ({
        runtime: s.runtime,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
      })),
    })
    if (offered.length === 0) {
      const sent = await (ch as { send: (t: string) => Promise<{ id: string }> }).send(text)
      this.noteBotMsg(sent.id)
      return sent.id
    }
    const action = mode === 'resume' ? 'resume' : 'pick'
    const pickRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...offered.map((_, idx) =>
        new ButtonBuilder()
          .setCustomId(`sess:${action}:${idx}`)
          .setLabel(`${idx + 1}`)
          .setEmoji(NUMBERS[idx]!)
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sess:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )
    const sent = await (ch as { send: Function }).send({ content: text, components: [pickRow, cancelRow] })
    this.sessionCards.set(sent.id, { sessions: offered, channelId, mode })
    this.noteBotMsg(sent.id)
    return sent.id
  }

  /**
   * Resolve a share/resume button: owner-only. Cancel closes the card. An
   * 'import' pick reads + distills the session and admits an owner-role
   * knowledge.append to know:channel/<id>/shared-context (anchor:none → no
   * conflict card); the next turn injects it and on Postgres it syncs to peers.
   * A 'resume' pick binds the channel's Driver to that runtime session id.
   */
  private async handleSessionPick(interaction: ButtonInteraction): Promise<void> {
    const card = this.sessionCards.get(interaction.message.id)
    if (!card) {
      await interaction.reply({ content: 'This session menu is no longer open.', ephemeral: true }).catch(() => {})
      return
    }
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    // Owner-only, by ownerUserId (not a delegated room approver): sharing/resuming
    // your own local session is identity-bound, matching the trigger gate.
    const ownerId = liveAgent.ownerUserId
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the owner can share or resume a session.', ephemeral: true }).catch(() => {})
      return
    }

    if (interaction.customId === 'sess:cancel') {
      this.sessionCards.delete(interaction.message.id)
      await interaction
        .update({ content: `${interaction.message.content}\n\n-# ✖️ cancelled`, components: [] })
        .catch(() => {})
      return
    }

    const m = /^sess:(pick|resume):(\d+)$/.exec(interaction.customId)
    if (!m) return
    const summary = card.sessions[Number(m[2])]
    if (!summary) return

    if (card.mode === 'resume') {
      await this.resumeSession(interaction, card.channelId, liveAgent, summary)
      return
    }

    // import: read + distill the on-disk transcript (pure). File-based read is
    // the robust path; nothing in the live session is mutated.
    const store = makeSessionStore(summary.runtime)
    const transcript = store ? await store.read(summary.id) : undefined
    if (!transcript) {
      await interaction.reply({ content: 'Could not read that session anymore.', ephemeral: true }).catch(() => {})
      return
    }
    const { brief, tags } = distill(transcript)
    const cwd = transcript.cwd || summary.cwd
    const body = wrapSharedContext(
      { source: `${summary.runtime}:${summary.id.slice(0, 8)}`, cwd: cwd || undefined, savedBy: ownerId },
      brief,
    )

    const noteId = `session-${summary.runtime}-${summary.id.slice(0, 8)}-${Date.now()}`
    await admit(this.store, {
      actor: ownerId,
      role: 'owner',
      channel: card.channelId,
      target: {
        artifactId: `know:channel/${card.channelId}/shared-context`,
        anchor: { kind: 'none' },
      },
      verb: 'knowledge.append',
      patch: { kind: 'knowledge', append: { id: noteId, body, tags } },
      effect: 'pure',
      caused_by: [],
    }).catch(err => this.ui.error(this.key, `session import admit: ${err}`))

    this.sessionCards.delete(interaction.message.id)
    this.ui.note(
      this.key,
      `imported ${summary.runtime} session ${summary.id.slice(0, 8)} into ${card.channelId}`,
    )
    await interaction
      .update({ content: renderSessionImported({ runtime: summary.runtime, title: summary.title }), components: [] })
      .catch(() => {})
  }

  /**
   * Bind a channel's Driver to an existing runtime session and persist it so the
   * resume survives a relay restart. Only valid when the agent's runtime can
   * continue that session's runtime; otherwise fall the owner back to import.
   */
  private async resumeSession(
    interaction: ButtonInteraction,
    channelId: ChannelId,
    liveAgent: AgentConfig,
    summary: SessionSummary,
  ): Promise<void> {
    const room = liveAgent.rooms[channelId]
    if (!room || sessionRuntimeForAgent(liveAgent.runtime) !== summary.runtime) {
      await interaction
        .reply({
          content: `This agent (${liveAgent.runtime}) can't resume a ${summary.runtime} session — try "share session" to import its context instead.`,
          ephemeral: true,
        })
        .catch(() => {})
      return
    }
    const session = this.getOrCreateSession(channelId, liveAgent, room)
    session.driver.bindSession(summary.id)
    writeSessionBinding(this.key, channelId, { runtime: summary.runtime, sessionId: summary.id })
    this.sessionCards.delete(interaction.message.id)
    this.ui.note(this.key, `resuming ${summary.runtime} session ${summary.id.slice(0, 8)} in ${channelId}`)
    await interaction
      .update({ content: renderSessionResumed({ runtime: summary.runtime, title: summary.title }), components: [] })
      .catch(() => {})
  }

  /**
   * Shared-context to inject on the next turn in a channel: active
   * know:channel/<id>/shared-context notes not yet delivered to this host's live
   * session. Each note's body is already the wrapped <shared-context> block.
   * Marks them delivered so the agent sees each import exactly once.
   */
  private pendingSharedContext(channelId: ChannelId): string | undefined {
    let state: KnowledgeFoldState
    try {
      state = this.engine.get<KnowledgeFoldState>(KNOWLEDGE_FOLD)
    } catch {
      return undefined // knowledge fold not registered
    }
    const notes = activeNotes(state, `know:channel/${channelId}/shared-context`)
    const delivered = this.deliveredContext.get(channelId) ?? new Set<Hash>()
    const { prefix, freshHashes } = pickFreshContext(
      notes.map(n => ({ hash: n.hash, body: n.note.body })),
      delivered,
    )
    if (!prefix) return undefined
    for (const h of freshHashes) delivered.add(h)
    this.deliveredContext.set(channelId, delivered)
    return prefix
  }

  /** This host's agent key — relay uses it to map agentKey → owner. */
  get agentKey(): string {
    return this.key
  }

  /** Owner of this host's agent (live-read so setup changes apply). */
  get ownerUserId(): string | undefined {
    return (this.getAccess().agents[this.key] ?? this.agent).ownerUserId
  }

  /** Owner/approver for a channel this host serves, else undefined (§4.2). */
  getOwnerForChannel(channelId: ChannelId): string | undefined {
    if (!this.getAgentForChannel(channelId)) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    return approverForAgent(liveAgent, channelId) ?? liveAgent.ownerUserId
  }

  /**
   * Resolve workspace + permission for a watch the WatchSupervisor wants to run.
   * The command is classified through the same `classifyTool` path (and deny
   * floor) as any Bash call against this room's profile. Returns undefined if
   * this host doesn't serve the watch's channel.
   */
  resolveWatch(spec: WatchSpec): WatchRunEnv | undefined {
    if (!this.getAgentForChannel(spec.channel)) return undefined
    const liveAgent = this.getAccess().agents[this.key] ?? this.agent
    const profile = readRoomSettings(this.key, spec.channel)
    const decision = classifyTool(profile, { toolName: 'Bash', subject: spec.command })
    return { workspace: liveAgent.workspace, decision }
  }

  /**
   * The watch tool surface, bound to a channel. Shared by the owner `!watch`
   * command and the agent's `mcp__knock-knock__watch` tool (adapters/watch-mcp.ts),
   * so both paths arm through one permission-gated implementation.
   */
  private watchToolsFor(channelId: ChannelId): WatchToolHandlers {
    return {
      // The agent (via the MCP tool) is a proposer: an `ask`-tier command is
      // held for the owner's one-time approval, not auto-armed.
      arm: spec => this.armWatch(channelId, spec, { preApproved: false }),
      disarm: name => this.disarmWatch(channelId, name),
      list: async () => this.listWatchesText(channelId),
    }
  }

  /**
   * Arm a watch. The command is classified exactly like a Bash call:
   *   - `deny`  → refused (the hard floor — never armed, never run).
   *   - `allow` → armed immediately.
   *   - `ask`   → held: the owner gets one ✅/❌ for the exact command, and the
   *               watch arms only on approve. `preApproved` (the owner's own
   *               `!watch`) skips the prompt — typing the command IS the
   *               approval. See docs/knock-knock-watches.md §5.
   */
  private async armWatch(
    channelId: ChannelId,
    partial: WatchArmPartial,
    opts: { preApproved: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    if (!this.getAgentForChannel(channelId)) {
      return { ok: false, message: 'No agent serves this channel.' }
    }
    const spec: WatchSpec = { ...partial, channel: channelId, agentKey: this.key }
    const decision = classifyTool(readRoomSettings(this.key, channelId), {
      toolName: 'Bash',
      subject: spec.command,
    })

    if (decision === 'deny') {
      return {
        ok: false,
        message: `⛔ refused to arm «${spec.name}» — command \`${spec.command}\` hits the deny floor. Not armed.`,
      }
    }

    if (decision === 'ask' && !opts.preApproved) {
      const approved = await this.requestWatchApproval(channelId, spec)
      if (!approved.ok) return approved // denied or timed out — surface the reason
    }

    await this.admitWatchArmed(channelId, spec)
    return {
      ok: true,
      message: `⏳ watching «${spec.name}» — ${spec.fireOn.kind} on \`${spec.command}\``,
    }
  }

  /** Post the exact watch command to the owner and block on one ✅/❌. */
  private async requestWatchApproval(
    channelId: ChannelId,
    spec: WatchSpec,
  ): Promise<{ ok: boolean; message: string }> {
    // Anchor the approval on a `watch.requested` interaction (inert to the watch
    // fold). The owner's verdict admits tool.approved/denied caused_by its hash.
    const requested = await admit(this.store, {
      actor: this.key,
      role: 'agent',
      channel: channelId,
      target: { artifactId: `extp:discord/${channelId}`, anchor: { kind: 'none' } },
      verb: 'watch.requested',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.request', args: spec } },
      effect: 'pure',
      caused_by: [],
    })
    const anchor = requested.interaction.hash

    await this.approvals.postDiscord({
      channelId,
      toolRequestedHash: anchor,
      toolName: `watch «${spec.name}» (${spec.fireOn.kind})`,
      input: { command: spec.command },
    })
    const verdict = await awaitVerdict(this.store, anchor, DEFAULT_VERDICT_TIMEOUT_MS)
    if (verdict.behavior === 'allow') return { ok: true, message: 'approved' }
    return {
      ok: false,
      message: `⛔ watch «${spec.name}» not armed — ${verdict.message ?? 'denied'}.`,
    }
  }

  private async admitWatchArmed(channelId: ChannelId, spec: WatchSpec): Promise<void> {
    await admit(this.store, {
      actor: this.key,
      role: 'agent',
      channel: channelId,
      target: { artifactId: `extp:discord/${channelId}`, anchor: { kind: 'none' } },
      verb: 'watch.armed',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.arm', args: spec } },
      effect: 'pure',
      caused_by: [],
    })
  }

  private async disarmWatch(
    channelId: ChannelId,
    name: string,
  ): Promise<{ ok: boolean; message: string }> {
    await admit(this.store, {
      actor: this.key,
      role: 'agent',
      channel: channelId,
      target: { artifactId: `extp:discord/${channelId}`, anchor: { kind: 'none' } },
      verb: 'watch.disarmed',
      patch: {
        kind: 'external',
        intent: { channel: 'tool', op: 'watch.disarm', args: { name, reason: 'requested' } },
      },
      effect: 'pure',
      caused_by: [],
    })
    return { ok: true, message: `${GLYPHS.checkpoint} unwatched «${name}»` }
  }

  private listWatchesText(channelId: ChannelId): string {
    const state = this.engine.get<WatchFoldState>(WATCH_FOLD)
    const mine = liveWatches(state).filter(w => w.channel === channelId)
    return mine.length
      ? mine.map(w => `• \`${w.name}\` — ${w.fireOn.kind} — \`${w.command}\``).join('\n')
      : 'No active watches in this channel.'
  }

  /** Owner `!watch` / `!unwatch` / `!watch list` — the same core as the agent tool. */
  private async handleWatchCommand(channelId: ChannelId, text: string): Promise<void> {
    const parsed = parseWatchCommand(text)
    if (!parsed) {
      await this.discordSend(
        channelId,
        'Usage: `!watch <name> on-change|each-line|on-exit|match:<regex> [every=10s ttl=10m max=5 once] <command>`, `!watch list`, or `!unwatch <name>`',
      )
      return
    }
    if (parsed.action === 'list') {
      await this.discordSend(channelId, this.listWatchesText(channelId))
      return
    }
    const result =
      parsed.action === 'disarm'
        ? await this.disarmWatch(channelId, parsed.name)
        : // The owner typed the command — that IS the approval; skip the prompt.
          await this.armWatch(channelId, parsed.spec, { preApproved: true })
    await this.discordSend(channelId, result.message)
  }

  // ─── Inbound (skinny) ─────────────────────────────────────────────────────

  private async handleInbound(msg: Message): Promise<void> {
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent

    const channelId = msg.channel.isThread()
      ? msg.channel.parentId ?? msg.channelId
      : msg.channelId
    const room = liveAgent.rooms[channelId]
    if (!room) return

    if (msg.author.id === this.client.user?.id) return

    const ownerId = liveAgent.ownerUserId
    if (!guildSenderAllowed(room, msg.author.id, this.client.user?.id, ownerId)) return

    const now = Date.now()
    const recent = (this.inboundRate.get(msg.author.id) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= 10) return
    this.inboundRate.set(msg.author.id, [...recent, now])

    const requireMention = room.requireMention ?? true
    if (requireMention && !(await this.isMentioned(msg, access.mentionPatterns))) return

    if ('sendTyping' in msg.channel) {
      void (msg.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {})
    }

    const kind = senderKind(room, msg.author.id, ownerId)

    // ─── Owner share/resume-session command — short-circuit before any admit ─
    // Owner-only (kind==='owner'): list this agent's local sessions and post a
    // selection card. The command itself is NOT admitted as a channel.message,
    // so the agent is never prompted with it; config/sessions stay terminal-
    // and owner-driven (the prompt-injection invariant). A peer can't reach
    // here — senderKind only returns 'owner' for the agent's owner. 'import'
    // distills context; 'resume' continues the live session.
    if (kind === 'owner' && (isShareSessionCommand(msg.content) || isResumeSessionCommand(msg.content))) {
      const mode = isResumeSessionCommand(msg.content) ? 'resume' : 'import'
      await this.offerSessionShare(channelId, liveAgent, ownerId, mode).catch(e =>
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
      await this.handleWatchCommand(channelId, msg.content).catch(e =>
        this.ui.error(this.key, `watch command: ${e}`),
      )
      return
    }

    // ─── Admit channel.message — that's all handleInbound does in Phase 3 ───
    const channelArtifactId = `extp:discord/${channelId}`
    const prior = await this.store.latestInChannel(channelId)
    const inboundResult = await admit(this.store, {
      actor: msg.author.id,
      role: kind === 'unknown' ? 'agent' : kind,
      channel: channelId,
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
    const channelLabel = await this.describeChannel(msg).catch(() => `#${channelId}`)
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
    const room = liveAgent.rooms[channelId]
    if (!room) return { chunks: [], error: 'no room' }

    const session = this.getOrCreateSession(channelId, liveAgent, room)
    const approverUserId = approverForAgent(liveAgent, channelId) ?? liveAgent.ownerUserId
    const recorder = TurnRecorder.restore(
      this.ledger,
      {
        agentKey: this.key,
        approverUserId,
        channelId,
        channelArtifactId: `extp:discord/${channelId}`,
      },
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
    const contextPrefix = this.pendingSharedContext(channelId)

    let chunks: string[] = []
    let turnError: string | undefined
    try {
      chunks = await session.driver.runTurn(opts.promptText, meta, abort.signal, contextPrefix)
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
    const outcome: 'done' | 'failed' | 'stopped' = stopped
      ? 'stopped'
      : turnError || !replyText
        ? 'failed'
        : 'done'
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

    const profile = readRoomSettings(this.key, channelId)
    const adapter = makeAdapter(liveAgent.runtime, {
      workspace: liveAgent.workspace,
      watchTools: this.watchToolsFor(channelId),
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
