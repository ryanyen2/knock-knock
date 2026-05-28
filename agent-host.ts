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
  type Message,
  type Interaction,
} from 'discord.js'
import { readRoomSettings } from './state.ts'
import {
  type AgentConfig,
  type Access,
  type PreambleContext,
  guildSenderAllowed,
  senderKind,
  buildRosterLinesForRoom,
  approverForAgent,
} from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { makeAdapter } from './adapters/index.ts'
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
import type { ChannelId, Hash } from './ledger/interaction.ts'
import type { DriveTurnHandle } from './ledger/synchronizations/drive-turn.ts'

const RECENT_BOT_MSG_CAP = 200

/** A per-channel session: the live adapter + driver + per-turn state. */
type Session = {
  driver: Driver
  /** Per-channel mailbox of in-flight turn metadata for adapter event fanout. */
  activeTurn?: {
    promptHash: Hash
    recorder: TurnRecorder
    dmHandle: DmTurnHandle
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

    this.client.once('ready', c => {
      this.ui.connected(this.key, c.user.tag)
    })

    this.client.on('messageCreate', (msg: Message) => {
      this.handleInbound(msg).catch(e =>
        this.ui.error(this.key, `handleInbound error: ${e}`),
      )
    })

    this.client.on('interactionCreate', (interaction: Interaction) => {
      if (!interaction.isButton()) return
      if (!interaction.customId.startsWith('appr:')) return
      this.approvals.resolveInteraction(interaction).catch(e =>
        this.ui.error(this.key, `interaction error: ${e}`),
      )
    })

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user.bot) return
      const emoji = reaction.emoji.name
      if (!emoji || (emoji !== '✅' && emoji !== '❌')) return
      this.approvals.resolveReaction(reaction.message.id, emoji, user.id).catch(e =>
        this.ui.error(this.key, `reaction error: ${e}`),
      )
    })

    this.client.on('error', err => {
      this.ui.error(this.key, `client error: ${err}`)
    })

    // Side-effect subscribers: turn.prompted → start DmCourier; turn.replied
    // → remove ack reaction. These are the UX touches that need Discord
    // context the synchronizer chain doesn't have. The work itself is
    // ledger-driven; only the Discord-side bookkeeping lives here.
    this.storeUnsub = this.store.subscribe(i => {
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return
      if (i.verb === 'turn.prompted') void this.onTurnPrompted(i.hash, i.caused_by[0])
      else if (i.verb === 'turn.replied') void this.onTurnReplied(i)
    })
  }

  async start(token: string): Promise<void> {
    await this.client.login(token)
  }

  async stop(): Promise<void> {
    this.storeUnsub?.()
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

    // Ack reaction — removed by onTurnReplied below when the synchronizer
    // chain finishes. If the loop-guard denies the turn, the ack stays
    // until the side-table entry is cleaned by a TTL sweep (Phase 3.1).
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

  private async onTurnReplied(replied: { hash: Hash; caused_by: Hash[]; channel: ChannelId }): Promise<void> {
    // turn.replied.caused_by = [turn.prompted, ...tool.executeds]; the prompt
    // is the first parent. The inbound is the prompt's first parent — we
    // can resolve it via the store.
    const promptHash = replied.caused_by[0]
    if (!promptHash) return
    const prompt = await this.store.getByHash(promptHash)
    if (!prompt) return
    const inboundHash = prompt.caused_by[0]
    if (!inboundHash) return
    const side = this.inboundByHash.get(inboundHash)
    if (!side) return

    void side.msg.reactions.cache
      .get(side.ackEmoji)
      ?.users.remove(this.client.user?.id ?? '')
      .catch(() => {})

    // Side-table cleanup — the turn has fully wound down.
    this.inboundByHash.delete(inboundHash)
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
    session.activeTurn = { promptHash: opts.promptHash, recorder, dmHandle: noopDm() }

    const meta: TurnMeta = {
      senderId: opts.senderId,
      kind: opts.senderKindKind,
      messageId: opts.messageId,
      ts: opts.ts,
      channelId,
    }

    let chunks: string[] = []
    let turnError: string | undefined
    try {
      chunks = await session.driver.runTurn(opts.promptText, meta)
    } catch (e) {
      turnError = e instanceof Error ? e.message : String(e)
      this.ui.error(this.key, `turn failed: ${turnError}`)
    }

    const replyText = chunks.join('\n').trim() || undefined
    await recorder
      .finishTurn(replyText)
      .catch(err => this.ui.error(this.key, `ledger finish turn: ${err}`))

    // Finalize the DM transcript with any error; the reply text already
    // landed in the Turn fold which the courier subscribes to.
    void session.activeTurn?.dmHandle.finalize(turnError).catch(() => {})
    session.activeTurn = undefined

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
    const adapter = makeAdapter(liveAgent.runtime, { workspace: liveAgent.workspace })
    const ctx: PreambleContext = {
      identity: {
        name: liveAgent.name,
        ownerUserId: liveAgent.ownerUserId,
        blurb: liveAgent.blurb,
      },
      rosterLines: buildRosterLinesForRoom(room),
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
