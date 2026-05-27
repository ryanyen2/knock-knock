#!/usr/bin/env bun
/**
 * setup.ts — standalone setup CLI for knock-knock.
 *
 * Writes the same files that relay.ts reads (via state.ts). Setup works for
 * any coding agent — codex, claude-sdk, opencode, gemini, etc. — without
 * requiring Claude Code or its skills.
 *
 * Usage:
 *   bun setup.ts                   Show agent/room status
 *   bun setup.ts status            Show agent/room status
 *   bun setup.ts configure         Save a Discord bot token
 *   bun setup.ts agent add         Add a new agent identity
 *   bun setup.ts room add          Add a room to an agent
 *   bun setup.ts peer add          Register a peer bot in a room
 *   bun setup.ts human add         Allow a human to drive an agent in a room
 *
 * Writes to:
 *   STATE_DIR/access.json                                   (agent identities/rooms)
 *   STATE_DIR/.env                                          (bot tokens, chmod 600)
 *   STATE_DIR/rooms/<agentKey>/<channelId>.settings.json    (allow/ask/deny profile)
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import * as readline from 'readline'
import { STATE_DIR, readAccessFileV2, saveAccessV2 } from './state.ts'
import type { AgentConfig, RoomConfig } from './lib.ts'

// ─── Readline helpers ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue !== undefined ? `${question} [${defaultValue}]: ` : `${question}: `
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim() || defaultValue || ''))
  })
}

function close(): void {
  rl.close()
}

function print(msg: string): void {
  process.stdout.write(msg + '\n')
}

function warn(msg: string): void {
  process.stderr.write(`setup: ${msg}\n`)
}

// ─── .env helpers ─────────────────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')

function readEnvVars(): Map<string, string> {
  const vars = new Map<string, string>()
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) vars.set(m[1]!, m[2]!)
    }
  } catch {}
  return vars
}

function writeEnvVars(vars: Map<string, string>): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const content = [...vars.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(ENV_FILE, content, { mode: 0o600 })
  try { chmodSync(ENV_FILE, 0o600) } catch {}
}

function isTokenSet(tokenEnv: string): boolean {
  const vars = readEnvVars()
  const v = vars.get(tokenEnv)
  return v !== undefined && v !== ''
}

function setToken(tokenEnv: string, token: string): void {
  const vars = readEnvVars()
  vars.set(tokenEnv, token)
  writeEnvVars(vars)
}

// ─── Default permission profile ───────────────────────────────────────────────

/** Safe-by-default allow/ask/deny profile written flat so readRoomSettings
 *  loads it correctly (matches state.ts:readRoomSettings flat-key format). */
const DEFAULT_PROFILE = {
  allow: ['Read(**)'],
  ask: ['Bash(*)'],
  deny: ['Bash(rm -rf *)', 'Bash(sudo *)', 'Write(~/.claude/**)', 'Write(~/.ssh/**)'],
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const access = readAccessFileV2()
  const agents = Object.entries(access.agents)
  if (agents.length === 0) {
    print('No agents configured.')
    print('  Add one with:  bun setup.ts agent add')
    return
  }
  print(`\n${agents.length} agent(s) configured:\n`)
  for (const [key, agent] of agents) {
    const tokenMark = isTokenSet(agent.tokenEnv) ? '✅' : '❌ MISSING'
    print(`  [${key}]  ${agent.name ?? '(not connected yet)'}  —  ${agent.blurb}`)
    print(`           runtime:  ${agent.runtime}`)
    print(`           workspace: ${agent.workspace || '⚠️  not set'}`)
    print(`           token:    ${agent.tokenEnv}  ${tokenMark}`)
    const rooms = Object.entries(agent.rooms)
    if (rooms.length === 0) {
      print(`           rooms:    (none) — add one with: bun setup.ts room add`)
    } else {
      for (const [channelId, room] of rooms) {
        const peers = Object.keys(room.participants).length
        const humans = room.humans.length
        print(
          `           room ${channelId}: ${peers} peer(s), ${humans} human(s)` +
            `${room.requireMention ? '' : '  [no @mention required]'}`,
        )
      }
    }
    print('')
  }
  print(`State dir: ${STATE_DIR}`)
}

async function cmdConfigure(): Promise<void> {
  print('\n── Configure Discord bot token ──')
  print('You get this from: discord.com/developers/applications → your app → Bot → Reset Token')
  print('')

  const access = readAccessFileV2()
  const agentKeys = Object.keys(access.agents)

  let agentKey: string
  if (agentKeys.length === 0) {
    print('No agents configured yet. Token will be stored for the "default" key.')
    print('Run `bun setup.ts agent add` to set up an agent.')
    agentKey = 'default'
  } else {
    print(`Agents: ${agentKeys.join(', ')}`)
    agentKey = await ask('Agent key to configure token for')
    if (!agentKey) { warn('Agent key is required.'); return }
  }

  const existingTokenEnv = access.agents[agentKey]?.tokenEnv
  const defaultTokenEnv =
    existingTokenEnv ??
    (agentKey === 'default'
      ? 'DISCORD_BOT_TOKEN'
      : `DISCORD_BOT_TOKEN_${agentKey.toUpperCase().replace(/-/g, '_')}`)

  const tokenEnv = await ask('Env var name for this token', defaultTokenEnv)
  const token = await ask('Bot token (input is visible — paste carefully)')
  if (!token) { warn('Token is required.'); return }

  setToken(tokenEnv, token)
  print(`\n✅  Token saved to ${ENV_FILE} as ${tokenEnv}=***${token.slice(-4)}`)

  // Update tokenEnv in the agent config if the agent exists
  if (access.agents[agentKey]) {
    access.agents[agentKey]!.tokenEnv = tokenEnv
    saveAccessV2(access)
    print(`    Updated agent "${agentKey}" tokenEnv → ${tokenEnv}`)
  }
}

async function cmdAgentAdd(): Promise<void> {
  print('\n── Add a new agent ──')
  print('Each agent = one Discord bot (one token, one bot identity in the room).')
  print('')

  const access = readAccessFileV2()

  const agentKey = await ask('Agent key (short slug, e.g. "research-bot")')
  if (!agentKey) { warn('Agent key is required.'); return }
  if (!/^[a-z0-9-]+$/.test(agentKey)) {
    warn('Agent key must be lowercase letters, digits, and hyphens only.')
    return
  }
  if (access.agents[agentKey]) {
    const overwrite = await ask(`Agent "${agentKey}" already exists. Overwrite?`, 'n')
    if (!overwrite.toLowerCase().startsWith('y')) return
  }

  const ownerUserId = await ask('Your Discord user ID (right-click yourself → Copy User ID)')
  if (!ownerUserId) { warn('Owner Discord user ID is required.'); return }

  const blurb = await ask('One-line description peers will see (e.g. "read-only research agent")')
  if (!blurb) { warn('Description is required.'); return }

  const runtime = await ask('Agent runtime', 'claude-sdk')
  const workspace = await ask('Workspace path (absolute, e.g. /Users/you/repos/project)')
  if (!workspace) { warn('Workspace path is required.'); return }

  const tokenEnvDefault = `DISCORD_BOT_TOKEN_${agentKey.toUpperCase().replace(/-/g, '_')}`
  const tokenEnv = await ask('Env var name for this bot\'s Discord token', tokenEnvDefault)

  const agent: AgentConfig = {
    ownerUserId,
    blurb,
    runtime,
    workspace,
    tokenEnv,
    rooms: {},
  }
  access.agents[agentKey] = agent
  saveAccessV2(access)

  print(`\n✅  Agent "${agentKey}" added.`)
  print(`    Next steps:`)
  print(`      bun setup.ts configure         # save the Discord bot token`)
  print(`      bun setup.ts room add          # add a room to this agent`)
}

async function cmdRoomAdd(): Promise<void> {
  print('\n── Add a room to an agent ──')
  print('You need the Discord channel ID (right-click the channel → Copy Channel ID).')
  print('')

  const access = readAccessFileV2()
  const agentKeys = Object.keys(access.agents)
  if (agentKeys.length === 0) {
    print('No agents configured. Run `bun setup.ts agent add` first.')
    return
  }

  print(`Agents: ${agentKeys.join(', ')}`)
  const agentKey = await ask('Agent key')
  if (!agentKey || !access.agents[agentKey]) {
    warn(`Agent "${agentKey}" not found.`)
    return
  }

  const agent = access.agents[agentKey]!

  const channelId = await ask('Room channel ID')
  if (!channelId) { warn('Channel ID is required.'); return }
  if (agent.rooms[channelId]) {
    const overwrite = await ask(`Room ${channelId} already configured. Overwrite?`, 'n')
    if (!overwrite.toLowerCase().startsWith('y')) return
  }

  const requireMention = !(await ask('Only respond when @mentioned?', 'y')).toLowerCase().startsWith('n')
  const approvalActorId = await ask('Approval actor Discord user ID', agent.ownerUserId)

  print('Sendable file roots: absolute paths this agent may attach as files to the channel.')
  const sendableRaw = await ask('Sendable roots (comma-separated)', agent.workspace)
  const sendableRoots = sendableRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const room: RoomConfig = {
    requireMention,
    participants: {},
    humans: [],
    sendableRoots,
    approvalActorId: approvalActorId || agent.ownerUserId,
  }
  agent.rooms[channelId] = room
  saveAccessV2(access)

  // Write the flat default permission profile
  const settingsDir = join(STATE_DIR, 'rooms', agentKey)
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
  const settingsPath = join(settingsDir, `${channelId}.settings.json`)
  writeFileSync(settingsPath, JSON.stringify(DEFAULT_PROFILE, null, 2) + '\n', { mode: 0o600 })

  print(`\n✅  Room ${channelId} added to agent "${agentKey}".`)
  print(`    Default allow/ask/deny profile written to:`)
  print(`      ${settingsPath}`)
  print(`    Edit that file to customise the permission profile.`)
  print(`    To register peers: bun setup.ts peer add`)
}

async function cmdPeerAdd(): Promise<void> {
  print('\n── Register a peer bot ──')
  print('The peer\'s bot user ID lets this agent recognise messages from their bot.')
  print('They do the same on their side (registering your bot\'s user ID).')
  print('')

  const access = readAccessFileV2()
  const agentKeys = Object.keys(access.agents)
  if (agentKeys.length === 0) { print('No agents configured.'); return }

  print(`Agents: ${agentKeys.join(', ')}`)
  const agentKey = await ask('Your agent key')
  const agent = access.agents[agentKey]
  if (!agent) { warn(`Agent "${agentKey}" not found.`); return }

  const roomIds = Object.keys(agent.rooms)
  if (roomIds.length === 0) {
    warn('No rooms configured for this agent. Run `bun setup.ts room add` first.')
    return
  }

  print(`Rooms: ${roomIds.join(', ')}`)
  const channelId = await ask('Room channel ID')
  const room = agent.rooms[channelId]
  if (!room) { warn(`Room "${channelId}" not found.`); return }

  const peerBotId = await ask('Peer bot\'s Discord user ID (right-click their bot → Copy User ID)')
  if (!peerBotId) { warn('Peer bot user ID is required.'); return }

  const peerName = await ask('Peer name (optional, e.g. "agent-b")')
  const peerBlurb = await ask('Peer description (e.g. "deploy specialist")')
  if (!peerBlurb) { warn('Peer description is required.'); return }

  room.participants[peerBotId] = {
    ...(peerName ? { name: peerName } : {}),
    blurb: peerBlurb,
  }
  saveAccessV2(access)

  print(`\n✅  Peer ${peerBotId}${peerName ? ` (${peerName})` : ''} registered in room ${channelId}.`)
  print(`    Make sure they register your bot on their side too.`)
}

async function cmdHumanAdd(): Promise<void> {
  print('\n── Allow a human to drive this agent ──')
  print('Humans listed here may @mention the agent and receive responses.')
  print('')

  const access = readAccessFileV2()
  const agentKeys = Object.keys(access.agents)
  if (agentKeys.length === 0) { print('No agents configured.'); return }

  print(`Agents: ${agentKeys.join(', ')}`)
  const agentKey = await ask('Agent key')
  const agent = access.agents[agentKey]
  if (!agent) { warn(`Agent "${agentKey}" not found.`); return }

  const roomIds = Object.keys(agent.rooms)
  if (roomIds.length === 0) { warn('No rooms configured.'); return }

  print(`Rooms: ${roomIds.join(', ')}`)
  const channelId = await ask('Room channel ID')
  const room = agent.rooms[channelId]
  if (!room) { warn(`Room "${channelId}" not found.`); return }

  const userId = await ask('Human\'s Discord user ID')
  if (!userId) { warn('User ID is required.'); return }

  if (room.humans.includes(userId)) {
    print(`User ${userId} is already listed.`)
  } else {
    room.humans.push(userId)
    saveAccessV2(access)
    print(`\n✅  User ${userId} may now drive agent "${agentKey}" in room ${channelId}.`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? 'status'
  const sub = args[1]

  if (cmd === 'status' || cmd === '') {
    await cmdStatus()
  } else if (cmd === 'configure') {
    await cmdConfigure()
  } else if (cmd === 'agent' && sub === 'add') {
    await cmdAgentAdd()
  } else if (cmd === 'room' && sub === 'add') {
    await cmdRoomAdd()
  } else if (cmd === 'peer' && sub === 'add') {
    await cmdPeerAdd()
  } else if (cmd === 'human' && sub === 'add') {
    await cmdHumanAdd()
  } else {
    print('knock-knock setup CLI\n')
    print('Usage:')
    print('  bun setup.ts                   Show agent/room status')
    print('  bun setup.ts status            Show agent/room status')
    print('  bun setup.ts configure         Save a Discord bot token')
    print('  bun setup.ts agent add         Add a new agent identity')
    print('  bun setup.ts room add          Add a room to an agent')
    print('  bun setup.ts peer add          Register a peer bot in a room')
    print('  bun setup.ts human add         Allow a human to drive an agent')
  }
}

main().catch(e => {
  process.stderr.write(`setup error: ${e}\n`)
  process.exit(1)
}).finally(() => close())
