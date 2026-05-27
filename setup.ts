#!/usr/bin/env bun
/**
 * setup.ts — interactive setup for knock-knock.
 *
 * Writes the same files relay.ts reads (via state.ts). Works for any coding
 * agent — codex, claude-sdk, opencode, gemini, etc. — without requiring Claude
 * Code or its skills.
 *
 * Run with no arguments for a guided wizard:
 *   bun setup.ts                   First run → wizard; otherwise → menu
 *
 * Or jump straight to one action (for scripting / power users):
 *   bun setup.ts status            Show agent/room status
 *   bun setup.ts agent add         Add a new agent identity
 *   bun setup.ts room add          Add a room to an agent
 *   bun setup.ts peer add          Register a peer bot in a room
 *   bun setup.ts human add         Allow a human to drive an agent in a room
 *   bun setup.ts configure         Save a Discord bot token
 *
 * Writes to:
 *   STATE_DIR/access.json                                   (agent identities/rooms)
 *   STATE_DIR/.env                                          (bot tokens, chmod 600)
 *   STATE_DIR/rooms/<agentKey>/<channelId>.settings.json    (allow/ask/deny profile)
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import * as p from '@clack/prompts'
import color from 'picocolors'
import { STATE_DIR, readAccessFileV2, saveAccessV2 } from './state.ts'
import type { AccessV2, AgentConfig, RoomConfig } from './lib.ts'

// ─── Constants ──────────────────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')

/** Selectable runtimes — mirrors the adapter factory in adapters/index.ts. */
const RUNTIMES: { value: string; label: string; hint: string }[] = [
  { value: 'claude-sdk', label: 'Claude Code', hint: 'in-process SDK · no install · ANTHROPIC_API_KEY or `claude login`' },
  { value: 'codex', label: 'OpenAI Codex', hint: 'via ACP (npx) · needs OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', hint: 'via ACP · needs `opencode` installed' },
  { value: 'gemini', label: 'Gemini CLI', hint: 'via ACP · needs `gemini`' },
  { value: 'claude-acp', label: 'Claude Code (ACP)', hint: 'via ACP (npx) instead of in-process' },
  { value: 'acp', label: 'Other ACP agent', hint: 'set KNOCK_KNOCK_ACP_COMMAND yourself' },
]

/** Safe-by-default allow/ask/deny profile, written flat so readRoomSettings
 *  loads it correctly (matches state.ts:readRoomSettings flat-key format). */
const DEFAULT_PROFILE = {
  allow: ['Read(**)'],
  ask: ['Edit(**)', 'Write(**)', 'Bash(*)'],
  deny: ['Bash(rm -rf *)', 'Bash(sudo *)', 'Write(~/.claude/**)', 'Write(~/.ssh/**)'],
}

// ─── clack helpers ──────────────────────────────────────────────────────────

/** Exit cleanly on Ctrl+C / Esc; otherwise narrow the value to its real type. */
function orCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled — no further changes saved.')
    process.exit(0)
  }
  return value as T
}

function banner(): string {
  return `${color.bgCyan(color.black(' knock-knock '))} ${color.dim('setup')}`
}

// ─── Validators ─────────────────────────────────────────────────────────────

function required(value: string): string | undefined {
  return value.trim() ? undefined : 'Required.'
}

function validateAgentKey(value: string): string | undefined {
  if (!value.trim()) return 'Required.'
  if (!/^[a-z0-9-]+$/.test(value)) return 'Lowercase letters, digits, and hyphens only.'
  return undefined
}

function validateSnowflake(value: string): string | undefined {
  if (!value.trim()) return 'Required.'
  if (!/^\d{17,20}$/.test(value.trim()))
    return 'Discord IDs are 17–20 digits. Enable Developer Mode, then right-click → Copy ID.'
  return undefined
}

function validateAbsPath(value: string): string | undefined {
  if (!value.trim()) return 'Required.'
  if (!isAbsolute(value.trim())) return 'Use an absolute path (starting with /).'
  return undefined
}

// ─── .env helpers ─────────────────────────────────────────────────────────────

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
  try {
    chmodSync(ENV_FILE, 0o600)
  } catch {}
}

function isTokenSet(tokenEnv: string): boolean {
  const v = readEnvVars().get(tokenEnv)
  return v !== undefined && v !== ''
}

function setToken(tokenEnv: string, token: string): void {
  const vars = readEnvVars()
  vars.set(tokenEnv, token)
  writeEnvVars(vars)
}

/** The env-var name that holds an agent's token. "default" keeps the legacy
 *  DISCORD_BOT_TOKEN; other agents get a suffixed, collision-free name. */
function deriveTokenEnv(key: string): string {
  return key === 'default'
    ? 'DISCORD_BOT_TOKEN'
    : `DISCORD_BOT_TOKEN_${key.toUpperCase().replace(/-/g, '_')}`
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

/** Choose an agent key: auto-select if there's only one, prompt if several. */
async function pickAgentKey(access: AccessV2): Promise<string | null> {
  const keys = Object.keys(access.agents)
  if (keys.length === 0) {
    p.log.error('No agents configured yet — add one first.')
    return null
  }
  if (keys.length === 1) return keys[0]!
  return orCancel(
    await p.select({
      message: 'Which agent?',
      options: keys.map(k => ({ value: k, label: k, hint: access.agents[k]!.blurb })),
    }),
  )
}

/** Choose a room (channel ID) within an agent: auto-select if only one. */
async function pickRoomId(agent: AgentConfig): Promise<string | null> {
  const ids = Object.keys(agent.rooms)
  if (ids.length === 0) {
    p.log.error('No rooms for this agent — add one first (room add).')
    return null
  }
  if (ids.length === 1) return ids[0]!
  return orCancel(
    await p.select({ message: 'Which room?', options: ids.map(id => ({ value: id, label: id })) }),
  )
}

// ─── Collectors (one prompt-flow each; save as they go) ───────────────────────

/** Prompt for and persist a new agent identity. Returns its key, or null. */
async function collectAgent(access: AccessV2): Promise<string | null> {
  const hasAgents = Object.keys(access.agents).length > 0

  const key = orCancel(
    await p.text({
      message: 'Agent key (short slug peers never see)',
      placeholder: 'research-bot',
      initialValue: hasAgents ? '' : 'default',
      validate: validateAgentKey,
    }),
  ).trim()

  if (access.agents[key]) {
    const overwrite = orCancel(
      await p.confirm({ message: `Agent "${key}" already exists. Overwrite it?`, initialValue: false }),
    )
    if (!overwrite) {
      p.log.info('Left existing agent unchanged.')
      return null
    }
  }

  const ownerUserId = orCancel(
    await p.text({
      message: 'Your Discord user ID (the human who owns this agent)',
      placeholder: '184695080709324800',
      validate: validateSnowflake,
    }),
  ).trim()

  const blurb = orCancel(
    await p.text({
      message: 'One-line description peers will see',
      placeholder: 'read-only research agent for project-x',
      validate: required,
    }),
  ).trim()

  const runtime = orCancel(
    await p.select({
      message: 'Which coding agent runs this bot?',
      options: RUNTIMES,
      initialValue: 'claude-sdk',
    }),
  )

  const workspace = orCancel(
    await p.text({
      message: 'Workspace path (absolute) the agent works in',
      placeholder: process.cwd(),
      initialValue: process.cwd(),
      validate: validateAbsPath,
    }),
  ).trim()
  if (!existsSync(workspace)) {
    p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
  }

  const tokenEnv = deriveTokenEnv(key)
  access.agents[key] = { ownerUserId, blurb, runtime, workspace, tokenEnv, rooms: {} }
  saveAccessV2(access)
  p.log.success(`Saved agent ${color.cyan(key)} ${color.dim(`· token env: ${tokenEnv}`)}`)
  return key
}

/** Prompt for and persist a room + its default permission profile. */
async function collectRoom(access: AccessV2, agentKey?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!

  const channelId = orCancel(
    await p.text({
      message: 'Room channel ID (right-click the channel → Copy Channel ID)',
      placeholder: '846209781206941736',
      validate: validateSnowflake,
    }),
  ).trim()

  if (agent.rooms[channelId]) {
    const overwrite = orCancel(
      await p.confirm({ message: `Room ${channelId} is already configured. Overwrite?`, initialValue: false }),
    )
    if (!overwrite) return
  }

  const requireMention = orCancel(
    await p.confirm({ message: 'Only respond when @mentioned?', initialValue: true }),
  )

  const sendableRaw = orCancel(
    await p.text({
      message: 'Sendable file roots (comma-separated absolute paths the agent may attach)',
      placeholder: agent.workspace,
      initialValue: agent.workspace,
    }),
  ).trim()
  const sendableRoots = sendableRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const room: RoomConfig = {
    requireMention,
    participants: {},
    humans: [],
    sendableRoots,
    approvalActorId: agent.ownerUserId,
  }
  agent.rooms[channelId] = room
  saveAccessV2(access)

  // Write the flat default profile — but never clobber a customised one.
  const dir = join(STATE_DIR, 'rooms', key)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const profilePath = join(dir, `${channelId}.settings.json`)
  if (existsSync(profilePath)) {
    p.log.message(color.dim(`Kept existing permission profile: ${profilePath}`))
  } else {
    writeFileSync(profilePath, JSON.stringify(DEFAULT_PROFILE, null, 2) + '\n', { mode: 0o600 })
    p.log.message(color.dim(`Permission profile: ${profilePath} (edit to customise)`))
  }
  p.log.success(`Room ${color.cyan(channelId)} added to ${color.cyan(key)}`)
}

/** Prompt for and persist a bot token in .env. */
async function collectToken(access: AccessV2, agentKey?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const tokenEnv = access.agents[key]!.tokenEnv

  p.log.message(
    color.dim('Get the token from: discord.com/developers/applications → your app → Bot → Reset Token'),
  )
  const token = orCancel(
    await p.password({
      message: `Paste the Discord bot token for ${color.cyan(key)}`,
      validate: v => (v.trim() ? undefined : 'Required.'),
    }),
  ).trim()

  setToken(tokenEnv, token)
  p.log.success(`Token saved to .env as ${tokenEnv} ${color.dim(`· ***${token.slice(-4)}`)}`)
}

/** Prompt for and persist a peer bot in a room's participants map. */
async function collectPeer(access: AccessV2): Promise<void> {
  const key = await pickAgentKey(access)
  if (!key) return
  const agent = access.agents[key]!
  const channelId = await pickRoomId(agent)
  if (!channelId) return
  const room = agent.rooms[channelId]!

  const peerBotId = orCancel(
    await p.text({
      message: "Peer bot's Discord user ID (right-click their bot → Copy User ID)",
      placeholder: '987654321098765432',
      validate: validateSnowflake,
    }),
  ).trim()

  const peerName = orCancel(
    await p.text({ message: 'Peer name (optional, e.g. "agent-b")', placeholder: 'agent-b' }),
  ).trim()

  const peerBlurb = orCancel(
    await p.text({
      message: 'Peer description',
      placeholder: 'deploy + migration specialist',
      validate: required,
    }),
  ).trim()

  room.participants[peerBotId] = { ...(peerName ? { name: peerName } : {}), blurb: peerBlurb }
  saveAccessV2(access)
  p.log.success(
    `Peer ${color.cyan(peerBotId)}${peerName ? ` (${peerName})` : ''} registered in room ${channelId}`,
  )
  p.log.message(color.dim('Make sure they register your bot on their side too.'))
}

/** Prompt for and persist a human allowed to drive an agent in a room. */
async function collectHuman(access: AccessV2): Promise<void> {
  const key = await pickAgentKey(access)
  if (!key) return
  const agent = access.agents[key]!
  const channelId = await pickRoomId(agent)
  if (!channelId) return
  const room = agent.rooms[channelId]!

  const userId = orCancel(
    await p.text({
      message: "Human's Discord user ID",
      placeholder: '184695080709324800',
      validate: validateSnowflake,
    }),
  ).trim()

  if (room.humans.includes(userId)) {
    p.log.info(`User ${userId} is already allowed here.`)
    return
  }
  room.humans.push(userId)
  saveAccessV2(access)
  p.log.success(`User ${color.cyan(userId)} may now drive ${color.cyan(key)} in room ${channelId}`)
}

// ─── Status ─────────────────────────────────────────────────────────────────

function statusReport(access: AccessV2): string {
  const agents = Object.entries(access.agents)
  if (agents.length === 0) return color.dim('No agents configured yet.')

  const lines: string[] = []
  for (const [key, agent] of agents) {
    const tokenMark = isTokenSet(agent.tokenEnv) ? color.green('✓ set') : color.red('✗ missing')
    lines.push(`${color.cyan(color.bold(key))}  ${agent.name ?? color.dim('(not connected yet)')}`)
    lines.push(`  ${color.dim('blurb    ')} ${agent.blurb}`)
    lines.push(`  ${color.dim('runtime  ')} ${agent.runtime}`)
    lines.push(`  ${color.dim('workspace')} ${agent.workspace || color.yellow('not set')}`)
    lines.push(`  ${color.dim('token    ')} ${agent.tokenEnv} ${tokenMark}`)
    const rooms = Object.entries(agent.rooms)
    if (rooms.length === 0) {
      lines.push(`  ${color.dim('rooms    ')} ${color.dim('(none)')}`)
    } else {
      for (const [channelId, room] of rooms) {
        const peers = Object.keys(room.participants).length
        const mention = room.requireMention ? '' : color.dim(' · no @mention required')
        lines.push(
          `  ${color.dim('room     ')} ${channelId} ${color.dim(`· ${peers} peer(s), ${room.humans.length} human(s)`)}${mention}`,
        )
      }
    }
    lines.push('')
  }
  lines.push(color.dim(`State dir: ${STATE_DIR}`))
  return lines.join('\n')
}

/** Closing note: flag anything still missing, then how to launch. */
function finishWithNextSteps(access: AccessV2): void {
  const tips: string[] = []
  const noToken = Object.entries(access.agents)
    .filter(([, a]) => !isTokenSet(a.tokenEnv))
    .map(([k]) => k)
  const noRoom = Object.entries(access.agents)
    .filter(([, a]) => Object.keys(a.rooms).length === 0)
    .map(([k]) => k)

  if (noToken.length) tips.push(`${color.yellow('•')} Token missing for ${noToken.join(', ')} → ${color.cyan('bun setup.ts configure')}`)
  if (noRoom.length) tips.push(`${color.yellow('•')} No room for ${noRoom.join(', ')} → ${color.cyan('bun setup.ts room add')}`)
  tips.push(`${color.green('•')} Start the relay: ${color.cyan('bun relay.ts')}`)

  p.note(tips.join('\n'), 'Next steps')
  p.outro(color.green('Done.'))
}

// ─── Interactive entry (no args / `setup`) ────────────────────────────────────

async function runInteractive(): Promise<void> {
  p.intro(banner())
  let access = readAccessFileV2()

  // First run → guided wizard.
  if (Object.keys(access.agents).length === 0) {
    p.log.info("No agents yet — let's set up your first one.")
    const key = await collectAgent(access)
    if (key) {
      const addRoom = orCancel(
        await p.confirm({ message: 'Add a room (Discord channel) for this agent now?', initialValue: true }),
      )
      if (addRoom) await collectRoom(access, key)

      const addToken = orCancel(
        await p.confirm({ message: 'Save the Discord bot token now?', initialValue: true }),
      )
      if (addToken) await collectToken(access, key)
    }
    finishWithNextSteps(readAccessFileV2())
    return
  }

  // Existing setup → status + action menu.
  p.note(statusReport(access), 'Current setup')
  let running = true
  while (running) {
    const action = orCancel(
      await p.select({
        message: 'What would you like to do?',
        options: [
          { value: 'agent', label: 'Add another agent', hint: 'a second bot identity' },
          { value: 'room', label: 'Add a room', hint: 'register a Discord channel' },
          { value: 'peer', label: 'Register a peer agent' },
          { value: 'human', label: 'Allow a human to drive an agent' },
          { value: 'token', label: 'Save / update a bot token' },
          { value: 'status', label: 'Show full status' },
          { value: 'done', label: 'Done' },
        ],
      }),
    )
    access = readAccessFileV2() // refresh in case files changed between actions
    switch (action) {
      case 'agent':
        await collectAgent(access)
        break
      case 'room':
        await collectRoom(access)
        break
      case 'peer':
        await collectPeer(access)
        break
      case 'human':
        await collectHuman(access)
        break
      case 'token':
        await collectToken(access)
        break
      case 'status':
        p.note(statusReport(readAccessFileV2()), 'Status')
        break
      case 'done':
        running = false
        break
    }
  }
  finishWithNextSteps(readAccessFileV2())
}

// ─── Direct subcommands ───────────────────────────────────────────────────────

async function runStatus(): Promise<void> {
  p.intro(banner())
  p.note(statusReport(readAccessFileV2()), 'Status')
  p.outro(color.dim('Run `bun setup.ts` for the interactive menu.'))
}

async function runAgentAdd(): Promise<void> {
  p.intro(banner())
  await collectAgent(readAccessFileV2())
  finishWithNextSteps(readAccessFileV2())
}

async function runRoomAdd(): Promise<void> {
  p.intro(banner())
  await collectRoom(readAccessFileV2())
  p.outro(color.green('Done.'))
}

async function runPeerAdd(): Promise<void> {
  p.intro(banner())
  await collectPeer(readAccessFileV2())
  p.outro(color.green('Done.'))
}

async function runHumanAdd(): Promise<void> {
  p.intro(banner())
  await collectHuman(readAccessFileV2())
  p.outro(color.green('Done.'))
}

async function runConfigure(): Promise<void> {
  p.intro(banner())
  await collectToken(readAccessFileV2())
  p.outro(color.green('Done.'))
}

function printHelp(): void {
  process.stdout.write(
    `${banner()}\n\n` +
      'Usage:\n' +
      `  bun setup.ts                   ${color.dim('Interactive wizard / menu')}\n` +
      `  bun setup.ts status            ${color.dim('Show agent/room status')}\n` +
      `  bun setup.ts agent add         ${color.dim('Add a new agent identity')}\n` +
      `  bun setup.ts room add          ${color.dim('Add a room to an agent')}\n` +
      `  bun setup.ts peer add          ${color.dim('Register a peer bot in a room')}\n` +
      `  bun setup.ts human add         ${color.dim('Allow a human to drive an agent')}\n` +
      `  bun setup.ts configure         ${color.dim('Save a Discord bot token')}\n`,
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2)

  if (cmd === undefined || cmd === 'setup') return runInteractive()
  if (cmd === 'status') return runStatus()
  if (cmd === 'configure') return runConfigure()
  if (cmd === 'agent' && sub === 'add') return runAgentAdd()
  if (cmd === 'room' && sub === 'add') return runRoomAdd()
  if (cmd === 'peer' && sub === 'add') return runPeerAdd()
  if (cmd === 'human' && sub === 'add') return runHumanAdd()
  printHelp()
}

main().catch(e => {
  process.stderr.write(`setup error: ${e}\n`)
  process.exit(1)
})
