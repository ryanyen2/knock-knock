#!/usr/bin/env bun
/**
 * relay.ts — Phase 0 host process.
 *
 * The relay is the switchboard: it owns the Discord client, gates inbound
 * messages, routes each to the right Driver (one per session), and posts
 * responses back. Tool-permission requests are routed through the Approvals
 * service, which posts Allow/Deny buttons to the room channel.
 *
 * Start with:  bun relay.ts   (or npm run relay)
 * Requires:    DISCORD_BOT_TOKEN, KNOCK_KNOCK_WORKSPACE, and a room set up via
 *              /knock-knock:room in Claude Code.
 */

import { readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type Interaction,
} from 'discord.js'
import { STATE_DIR, readAccessFile, readRoomSettings } from './state.ts'
import { guildSenderAllowed, senderKind } from './lib.ts'
import { Driver, type TurnMeta } from './driver.ts'
import { ClaudeSdkAdapter } from './adapters/claude-sdk.ts'
import { Approvals } from './approvals.ts'

// ─── Load .env from state dir (same as server.ts) ────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

// ─── Validate required env ────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN
const WORKSPACE = process.env.KNOCK_KNOCK_WORKSPACE

if (!TOKEN) {
  process.stderr.write(
    `relay: DISCORD_BOT_TOKEN is required\n` +
      `  set it in ${ENV_FILE} or export it before running\n`,
  )
  process.exit(1)
}

if (!WORKSPACE) {
  process.stderr.write(
    `relay: KNOCK_KNOCK_WORKSPACE is required\n` +
      `  set it to an absolute path of the agent's working directory\n`,
  )
  process.exit(1)
}

// ─── Validate access config ───────────────────────────────────────────────────

const bootAccess = readAccessFile()
const roomChannelId = bootAccess.self?.roomChannelId
if (!roomChannelId) {
  process.stderr.write(
    `relay: no roomChannelId configured — run /knock-knock:room setup in Claude Code first\n`,
  )
  process.exit(1)
}

// ─── Session routing ──────────────────────────────────────────────────────────

/**
 * Composite-ready session key. Phase 0: one channel → one session.
 * Phase 1+: incorporate agentId and threadId here without re-plumbing the relay.
 */
function sessionKeyFor(meta: { channelId: string }): string {
  return meta.channelId
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction],
})

// ─── Services ─────────────────────────────────────────────────────────────────

const drivers = new Map<string, Driver>()
const approvals = new Approvals(client, readAccessFile)

// ─── Rate limiting ────────────────────────────────────────────────────────────

const inboundRate = new Map<string, number[]>()

// Track bot message IDs so "reply to bot" satisfies requireMention
const recentBotMsgIds = new Set<string>()
const RECENT_BOT_MSG_CAP = 200

function noteBotMsg(id: string): void {
  recentBotMsgIds.add(id)
  if (recentBotMsgIds.size > RECENT_BOT_MSG_CAP) {
    const first = recentBotMsgIds.values().next().value
    if (first) recentBotMsgIds.delete(first)
  }
}

// ─── Mention check ────────────────────────────────────────────────────────────

async function isMentioned(msg: Message, mentionPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  const refId = msg.reference?.messageId
  if (refId) {
    if (recentBotMsgIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }

  for (const pat of mentionPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(msg.content)) return true
    } catch {}
  }
  return false
}

// ─── Inbound handler ──────────────────────────────────────────────────────────

client.on('messageCreate', (msg: Message) => {
  handleInbound(msg).catch(e => process.stderr.write(`relay: handleInbound error: ${e}\n`))
})

async function handleInbound(msg: Message): Promise<void> {
  const access = readAccessFile()

  // Resolve the base channel id (threads → parent)
  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId

  // Only handle the configured room channel
  const room = access.rooms[channelId]
  if (!room) return

  // Self-loop guard
  if (msg.author.id === client.user?.id) return

  // Sender gate: owner, registered participant, or listed human
  const ownerId = room.approvalActorId ?? access.self?.ownerUserId
  if (!guildSenderAllowed(room, msg.author.id, client.user?.id, ownerId)) return

  // Rate cap: max 10 inbound per sender per 60s
  const now = Date.now()
  const recent = (inboundRate.get(msg.author.id) ?? []).filter(t => now - t < 60_000)
  if (recent.length >= 10) return
  inboundRate.set(msg.author.id, [...recent, now])

  // Mention check (default: require @mention or reply-to-bot)
  const requireMention = room.requireMention ?? true
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) return

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

  const sessionKey = sessionKeyFor(meta)

  // Find or create driver for this session
  let driver = drivers.get(sessionKey)
  if (!driver) {
    const profile = readRoomSettings(channelId)
    const adapter = new ClaudeSdkAdapter(WORKSPACE!)
    driver = new Driver(adapter, sessionKey, profile, req =>
      approvals.request({ sessionKey, channelId, toolName: req.toolName, input: req.input }),
    )
    drivers.set(sessionKey, driver)
  }

  const chunks = await driver.runTurn(msg.content, meta)

  // Post each chunk to the channel
  if ('send' in msg.channel) {
    for (const text of chunks) {
      const sent = await (msg.channel as { send: (t: string) => Promise<{ id: string }> }).send(text)
      noteBotMsg(sent.id)
    }
  }
}

// ─── Button interaction handler (Allow/Deny) ──────────────────────────────────

client.on('interactionCreate', (interaction: Interaction) => {
  if (!interaction.isButton()) return
  if (!interaction.customId.startsWith('appr:')) return
  approvals.resolveInteraction(interaction).catch(e => {
    process.stderr.write(`relay: interaction error: ${e}\n`)
  })
})

// ─── Reaction handler (✅/❌ as alternative to buttons) ───────────────────────

client.on('messageReactionAdd', (reaction, user) => {
  if (user.bot) return
  const emoji = reaction.emoji.name
  if (!emoji || (emoji !== '✅' && emoji !== '❌')) return
  approvals.resolveReaction(reaction.message.id, emoji, user.id).catch(e => {
    process.stderr.write(`relay: reaction error: ${e}\n`)
  })
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

client.once('ready', c => {
  process.stderr.write(`relay: connected as ${c.user.tag}\n`)
})

client.on('error', err => {
  process.stderr.write(`relay: client error: ${err}\n`)
})

process.on('unhandledRejection', err => {
  process.stderr.write(`relay: unhandled rejection: ${err}\n`)
})

process.on('uncaughtException', err => {
  process.stderr.write(`relay: uncaught exception: ${err}\n`)
})

function shutdown(): void {
  process.stderr.write('relay: shutting down\n')
  void client.destroy()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.login(TOKEN).catch(err => {
  process.stderr.write(`relay: login failed: ${err}\n`)
  process.exit(1)
})
