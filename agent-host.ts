/**
 * AgentHost — one Discord bot identity + one agent runtime. The supervisor
 * (relay.ts) instantiates one per configured agent in a single process. Each
 * host owns its own Discord client (gateway connection + token), its driver map
 * (one Driver per channel/session), its Approvals service, its DM courier, and
 * its rate-limit + recent-message state. It selects a runtime through
 * makeAdapter; it never imports an agent SDK directly.
 *
 * Visibility: as a turn runs, the host fans adapter AgentEvents to two sinks:
 * the operator terminal renderer (ConsoleUI) and the owner's DM transcript
 * (DmCourier). Both are best-effort; failures never block the turn.
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
  type LoopGuardState,
  guildSenderAllowed,
  senderKind,
  buildRosterLinesForRoom,
  loopGuard,
} from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { makeAdapter } from './adapters/index.ts'
import { Approvals } from './approvals.ts'
import { ConsoleUI } from './console-ui.ts'
import { DmCourier, type TurnHandle } from './dm-courier.ts'
import type { AgentEvent } from './agent-adapter.ts'

const RECENT_BOT_MSG_CAP = 200

/** Per-session bookkeeping the host owns alongside each Driver. */
type Session = {
  driver: Driver
  /** Set by handleInbound before each turn; consumed by the adapter event handler. */
  activeTurn?: {
    consoleAgentKey: string
    dmHandle: TurnHandle
  }
}

export class AgentHost {
  private readonly client: Client
  private readonly approvals: Approvals
  private readonly courier: DmCourier
  private readonly sessions = new Map<string, Session>()
  private readonly inboundRate = new Map<string, number[]>()
  private readonly recentBotMsgIds = new Set<string>()
  /** Per-channel loop-guard state: consecutive agent-triggered turns + last reply timestamp. */
  private readonly loopState = new Map<string, LoopGuardState>()

  constructor(
    private readonly key: string,
    private readonly agent: AgentConfig,
    private readonly getAccess: () => Access,
    private readonly ui: ConsoleUI,
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

    this.approvals = new Approvals(this.client, liveAgentGetter, info => {
      if (info.destination === 'channel' && info.reason) {
        this.ui.note(this.key, `approval fell back to channel — ${info.reason}`)
      } else {
        this.ui.note(this.key, `approval prompt sent to ${info.destination}`)
      }
    })

    this.courier = new DmCourier(
      this.client,
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
  }

  async start(token: string): Promise<void> {
    await this.client.login(token)
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }

  // ─── Private ────────────────────────────────────────────────────────────────

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

  private async handleInbound(msg: Message): Promise<void> {
    // Re-read the live access file on each message so room/peer config changes
    // from the setup CLI take effect without restarting the relay.
    const access = this.getAccess()
    const liveAgent = access.agents[this.key] ?? this.agent

    // Resolve the base channel id (threads → parent)
    const channelId = msg.channel.isThread()
      ? msg.channel.parentId ?? msg.channelId
      : msg.channelId

    // Only handle channels registered in this agent's rooms
    const room = liveAgent.rooms[channelId]
    if (!room) return

    // Self-loop guard
    if (msg.author.id === this.client.user?.id) return

    // Sender gate + priority classification key off the agent's real owner. The
    // approval actor (who may click Allow/Deny) is a separate role resolved by
    // Approvals via approverForAgent, so a delegated approver never locks the
    // owner out of driving their own agent.
    const ownerId = liveAgent.ownerUserId
    if (!guildSenderAllowed(room, msg.author.id, this.client.user?.id, ownerId)) return

    // Rate cap: max 10 inbound per sender per 60s
    const now = Date.now()
    const recent = (this.inboundRate.get(msg.author.id) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= 10) return
    this.inboundRate.set(msg.author.id, [...recent, now])

    // Mention check (default: require @mention or reply-to-bot)
    const requireMention = room.requireMention ?? true
    if (requireMention && !(await this.isMentioned(msg, access.mentionPatterns))) return

    // Typing indicator (best-effort)
    if ('sendTyping' in msg.channel) {
      void (msg.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {})
    }

    const kind = senderKind(room, msg.author.id, ownerId)
    const meta: TurnMeta = {
      senderId: msg.author.id,
      kind,
      messageId: msg.id,
      ts: msg.createdAt.toISOString(),
      channelId,
    }

    // ─── Agent↔agent loop guard ──────────────────────────────────────────────
    // Suppress auto-response when two bots are ping-ponging beyond the threshold.
    // Owner/human messages always pass and reset the counter (they break the loop).
    const lg = this.loopState.get(channelId) ?? { consecutiveAgentTurns: 0, lastAgentReplyAt: 0 }
    const { decision: lgDecision, next: lgNext } = loopGuard(lg, kind, now)
    this.loopState.set(channelId, lgNext)
    if (!lgDecision.allow) {
      this.ui.note(this.key, `loop guard skipped a reply in ${channelId} (${lgDecision.reason})`)
      return
    }

    // Session key is channelId within this host; globally unique via the per-host
    // sessions map (agentKey is implicit — different hosts have separate maps).
    const sessionKey = channelId

    // Find or create the session (driver + event fanout)
    let session = this.sessions.get(sessionKey)
    if (!session) {
      const profile = readRoomSettings(this.key, channelId)
      const adapter = makeAdapter(liveAgent.runtime, { workspace: liveAgent.workspace })
      // Collaborative context: inject identity + roster into the first-turn preamble
      // and wrap every message in a <channel kind=…> envelope. Roster is snapshotted
      // at session creation; add a peer then restart to refresh the preamble.
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
          sessionKey,
          profile,
          req => this.approvals.request({ channelId, toolName: req.toolName, input: req.input }),
          ctx,
        ),
      }
      // Fan adapter events into the console + the DM transcript for the in-flight turn.
      adapter.onEvent((event: AgentEvent) => {
        this.ui.event(this.key, event)
        created.activeTurn?.dmHandle.onEvent(event)
      })
      session = created
      this.sessions.set(sessionKey, session)
    }

    // Build the operator-visible context for this turn.
    const channelLabel = await this.describeChannel(msg).catch(() => `#${channelId}`)
    const senderLabel = msg.author.username ?? msg.author.id
    this.ui.turnStart(this.key, {
      channel: { label: channelLabel },
      sender: { label: senderLabel, kind },
      text: msg.content,
    })

    const dmHandle = await this.courier.beginTurn({
      senderLabel,
      channelLabel,
      userPrompt: msg.content,
    })
    session.activeTurn = { consoleAgentKey: this.key, dmHandle }

    // ─── Presence: 👀 while working ─────────────────────────────────────────
    // React with ackReaction (default 👀) to signal "received and working."
    // Never use ✅/❌ — they're reserved for the approval reaction listener.
    const ackEmoji = access.ackReaction ?? '👀'
    void msg.react(ackEmoji).catch(() => {})

    let chunks: string[] = []
    let turnError: string | undefined
    try {
      chunks = await session.driver.runTurn(msg.content, meta)
    } catch (e) {
      turnError = e instanceof Error ? e.message : String(e)
      this.ui.error(this.key, `turn failed: ${turnError}`)
    }

    // Remove the ack reaction now that the response is ready.
    void msg.reactions.cache
      .get(ackEmoji)
      ?.users.remove(this.client.user?.id ?? '')
      .catch(() => {})

    // Finalize the DM transcript with the response text (or error).
    const finalText = chunks.join('\n').trim() || undefined
    void dmHandle.finalize(finalText, turnError).catch(() => {})
    session.activeTurn = undefined

    // Post each chunk to the originating channel / thread
    if ('send' in msg.channel) {
      for (const text of chunks) {
        const sent = await (msg.channel as { send: (t: string) => Promise<{ id: string }> }).send(
          text,
        )
        this.noteBotMsg(sent.id)
      }
    }
  }

  /** Best-effort human-friendly channel label for the operator console + DM. */
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
