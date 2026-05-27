#!/usr/bin/env bun
/**
 * setup.ts — interactive setup wizard for knock-knock.
 *
 * Works for any coding agent (Codex, OpenCode, Gemini, Claude Code…) without
 * requiring Claude Code or its skills.
 *
 * Usage:
 *   bun setup.ts           First run → guided wizard; existing setup → action menu
 *
 * Writes to:
 *   STATE_DIR/access.json                                  (agent identities/rooms)
 *   STATE_DIR/.env                                         (bot tokens, chmod 600)
 *   STATE_DIR/rooms/<agentKey>/<channelId>.settings.json   (allow/ask/deny profile)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import * as p from '@clack/prompts'
import color from 'picocolors'
import { STATE_DIR, readAccessFileV2, saveAccessV2 } from './state.ts'
import type { AccessV2, AgentConfig, RoomConfig } from './lib.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')

const RUNTIMES = [
  { value: 'claude-sdk', label: 'Claude Code', hint: 'in-process SDK · no install · needs ANTHROPIC_API_KEY' },
  { value: 'codex', label: 'OpenAI Codex', hint: 'via ACP (npx) · needs OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', hint: 'via ACP · needs opencode installed' },
  { value: 'gemini', label: 'Gemini CLI', hint: 'via ACP · needs gemini installed' },
  { value: 'claude-acp', label: 'Claude Code (ACP)', hint: 'via ACP (npx) instead of in-process' },
  { value: 'acp', label: 'Other ACP agent', hint: 'set KNOCK_KNOCK_ACP_COMMAND yourself' },
]

const DEFAULT_PROFILE = {
  allow: ['Read(**)'],
  ask: ['Edit(**)', 'Write(**)', 'Bash(*)'],
  deny: ['Bash(rm -rf *)', 'Bash(sudo *)', 'Write(~/.claude/**)', 'Write(~/.ssh/**)'],
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function orCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
  return value as T
}

function banner(): string {
  return `${color.bgCyan(color.black(' knock-knock '))} ${color.dim('setup')}`
}

function deriveTokenEnv(key: string): string {
  return key === 'default'
    ? 'DISCORD_BOT_TOKEN'
    : `DISCORD_BOT_TOKEN_${key.toUpperCase().replace(/-/g, '_')}`
}

// ─── Validators (accept string | undefined per clack's validate signature) ───

function required(v: string | undefined): string | undefined {
  return (v ?? '').trim() ? undefined : 'Required.'
}

function validateAgentKey(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  if (!s) return 'Required.'
  if (!/^[a-z0-9-]+$/.test(s)) return 'Lowercase letters, digits, and hyphens only.'
  return undefined
}

function validateSnowflake(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  if (!s) return 'Required.'
  if (!/^\d{17,20}$/.test(s))
    return 'Discord IDs are 17–20 digits. Enable Developer Mode then right-click → Copy ID.'
  return undefined
}

function validateAbsPath(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  if (!s) return 'Required.'
  if (!isAbsolute(s)) return 'Must be an absolute path (starting with /).'
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
  try { chmodSync(ENV_FILE, 0o600) } catch {}
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

// ─── Pickers ─────────────────────────────────────────────────────────────────

async function pickAgentKey(access: AccessV2): Promise<string | null> {
  const keys = Object.keys(access.agents)
  if (keys.length === 0) {
    p.log.error('No agents configured yet — add one first.')
    return null
  }
  if (keys.length === 1) return keys[0]!
  return orCancel(await p.select({
    message: 'Which agent?',
    options: keys.map(k => ({ value: k, label: k, hint: access.agents[k]!.blurb })),
  }))
}

async function pickRoomId(agent: AgentConfig): Promise<string | null> {
  const ids = Object.keys(agent.rooms)
  if (ids.length === 0) {
    p.log.error('No rooms for this agent — add a room first.')
    return null
  }
  if (ids.length === 1) return ids[0]!
  return orCancel(await p.select({
    message: 'Which room?',
    options: ids.map(id => ({ value: id, label: id })),
  }))
}

// ─── Collectors ───────────────────────────────────────────────────────────────

async function collectAgent(access: AccessV2): Promise<string | null> {
  const hasAgents = Object.keys(access.agents).length > 0

  const key = orCancel(await p.text({
    message: 'Agent key (short slug)',
    placeholder: hasAgents ? 'research-bot' : 'default',
    initialValue: hasAgents ? '' : 'default',
    validate: validateAgentKey,
  })).trim()

  if (access.agents[key]) {
    const overwrite = orCancel(await p.confirm({
      message: `Agent "${key}" already exists. Overwrite?`,
      initialValue: false,
    }))
    if (!overwrite) { p.log.info('Left existing agent unchanged.'); return null }
  }

  const ownerUserId = orCancel(await p.text({
    message: 'Your Discord user ID (you own this agent — approval prompts ping you)',
    placeholder: '184695080709324800',
    validate: validateSnowflake,
  })).trim()

  const blurb = orCancel(await p.text({
    message: 'One-line description peers will see',
    placeholder: 'read-only research agent for project-x',
    validate: required,
  })).trim()

  const runtime = orCancel(await p.select({
    message: 'Which coding agent runs this bot?',
    options: RUNTIMES,
    initialValue: 'claude-sdk',
  }))

  const workspace = orCancel(await p.text({
    message: 'Workspace path (absolute)',
    placeholder: process.cwd(),
    initialValue: process.cwd(),
    validate: validateAbsPath,
  })).trim()
  if (!existsSync(workspace)) {
    p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
  }

  const tokenEnv = deriveTokenEnv(key)
  access.agents[key] = { ownerUserId, blurb, runtime, workspace, tokenEnv, rooms: {} }
  saveAccessV2(access)
  p.log.success(`Saved agent ${color.cyan(key)} ${color.dim(`· token env: ${tokenEnv}`)}`)
  return key
}

/** Collect a room, then chain inline peer registration + bulk human add. */
async function collectRoomFlow(access: AccessV2, agentKey: string): Promise<void> {
  const channelId = await collectRoom(access, agentKey)
  if (!channelId) return

  // Peer loop — add as many peers as needed without returning to menu
  let addPeer = orCancel(await p.confirm({
    message: 'Register a peer bot in this room?',
    initialValue: false,
  }))
  while (addPeer) {
    access = readAccessFileV2()
    await collectPeer(access, agentKey, channelId)
    addPeer = orCancel(await p.confirm({ message: 'Register another peer?', initialValue: false }))
  }

  // Bulk humans — comma-separated so multiple can be added in one prompt
  access = readAccessFileV2()
  await collectHumans(access, agentKey, channelId)
}

async function collectRoom(access: AccessV2, agentKey: string): Promise<string | null> {
  const agent = access.agents[agentKey]!

  const channelId = orCancel(await p.text({
    message: 'Room channel ID (right-click channel → Copy Channel ID)',
    placeholder: '846209781206941736',
    validate: validateSnowflake,
  })).trim()

  if (agent.rooms[channelId]) {
    const overwrite = orCancel(await p.confirm({
      message: `Room ${channelId} is already configured. Overwrite?`,
      initialValue: false,
    }))
    if (!overwrite) return null
  }

  const requireMention = orCancel(await p.confirm({
    message: 'Only respond when @mentioned?',
    initialValue: true,
  }))

  const sendableRaw = orCancel(await p.text({
    message: 'Sendable file roots (comma-separated absolute paths the agent may attach)',
    placeholder: agent.workspace,
    initialValue: agent.workspace,
  })).trim()
  const sendableRoots = sendableRaw.split(',').map(s => s.trim()).filter(Boolean)

  const room: RoomConfig = {
    requireMention,
    participants: {},
    humans: [],
    sendableRoots,
    approvalActorId: agent.ownerUserId,
  }
  agent.rooms[channelId] = room
  saveAccessV2(access)

  const dir = join(STATE_DIR, 'rooms', agentKey)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const profilePath = join(dir, `${channelId}.settings.json`)
  if (existsSync(profilePath)) {
    p.log.message(color.dim(`Kept existing permission profile: ${profilePath}`))
  } else {
    writeFileSync(profilePath, JSON.stringify(DEFAULT_PROFILE, null, 2) + '\n', { mode: 0o600 })
    p.log.message(color.dim(`Permission profile written: ${profilePath}`))
  }
  p.log.success(`Room ${color.cyan(channelId)} added to ${color.cyan(agentKey)}`)
  return channelId
}

async function collectPeer(access: AccessV2, agentKey?: string, channelId?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!
  const cid = channelId ?? (await pickRoomId(agent))
  if (!cid) return

  const peerBotId = orCancel(await p.text({
    message: "Peer bot's Discord user ID (right-click their bot → Copy User ID)",
    placeholder: '987654321098765432',
    validate: validateSnowflake,
  })).trim()

  const peerName = orCancel(await p.text({
    message: 'Peer name (optional)',
    placeholder: 'agent-b',
  })).trim()

  const peerBlurb = orCancel(await p.text({
    message: 'Peer description',
    placeholder: 'deploy + migration specialist',
    validate: required,
  })).trim()

  agent.rooms[cid]!.participants[peerBotId] = {
    ...(peerName ? { name: peerName } : {}),
    blurb: peerBlurb,
  }
  saveAccessV2(access)
  p.log.success(`Peer ${color.cyan(peerBotId)}${peerName ? ` (${peerName})` : ''} registered`)
  p.log.message(color.dim('Make sure they register your bot on their side too.'))
}

/** Bulk-add humans via comma-separated IDs. Called both from the room flow and
 *  the menu, so agentKey + channelId may come pre-picked or require prompts. */
async function collectHumans(access: AccessV2, agentKey?: string, channelId?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!
  const cid = channelId ?? (await pickRoomId(agent))
  if (!cid) return

  const raw = orCancel(await p.text({
    message: 'Allow humans to drive this agent? Discord user IDs, comma-separated (leave blank to skip)',
    placeholder: 'leave blank to skip',
  })).trim()
  if (!raw) return

  const all = raw.split(',').map(s => s.trim()).filter(Boolean)
  const invalid = all.filter(id => !/^\d{17,20}$/.test(id))
  if (invalid.length) p.log.warn(`Skipped invalid IDs: ${invalid.join(', ')}`)
  const valid = all.filter(id => /^\d{17,20}$/.test(id))
  if (!valid.length) return

  const room = agent.rooms[cid]!
  let added = 0
  for (const id of valid) {
    if (!room.humans.includes(id)) { room.humans.push(id); added++ }
  }
  if (added > 0) {
    saveAccessV2(access)
    p.log.success(`Added ${added} human${added > 1 ? 's' : ''} to room ${cid}`)
  } else {
    p.log.info('All provided user IDs were already in the room.')
  }
}

async function collectToken(access: AccessV2, agentKey?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const tokenEnv = access.agents[key]!.tokenEnv

  p.log.message(color.dim('Get it from: discord.com/developers → your app → Bot → Reset Token'))
  const token = orCancel(await p.password({
    message: `Bot token for ${color.cyan(key)}`,
    validate: (v: string | undefined) => ((v ?? '').trim() ? undefined : 'Required.'),
  })).trim()

  setToken(tokenEnv, token)
  p.log.success(`Saved to .env as ${tokenEnv} ${color.dim(`· ***${token.slice(-4)}`)}`)
}

// ─── Status ───────────────────────────────────────────────────────────────────

function statusReport(access: AccessV2): string {
  const agents = Object.entries(access.agents)
  if (agents.length === 0) return color.dim('No agents configured yet.')

  const lines: string[] = []
  for (const [key, agent] of agents) {
    const tokenMark = isTokenSet(agent.tokenEnv) ? color.green('✓') : color.red('✗ missing')
    lines.push(`${color.cyan(color.bold(key))}  ${agent.name ?? color.dim('(not connected yet)')}`)
    lines.push(`  ${color.dim('blurb    ')} ${agent.blurb}`)
    lines.push(`  ${color.dim('runtime  ')} ${agent.runtime}`)
    lines.push(`  ${color.dim('workspace')} ${agent.workspace || color.yellow('not set')}`)
    lines.push(`  ${color.dim('token    ')} ${agent.tokenEnv} ${tokenMark}`)
    const rooms = Object.entries(agent.rooms)
    if (rooms.length === 0) {
      lines.push(`  ${color.dim('rooms    ')} ${color.dim('(none)')}`)
    } else {
      for (const [cid, room] of rooms) {
        const peers = Object.keys(room.participants).length
        const mention = room.requireMention ? '' : color.dim(' · no @mention required')
        lines.push(`  ${color.dim('room     ')} ${cid}  ${color.dim(`${peers} peer(s)  ${room.humans.length} human(s)`)}${mention}`)
      }
    }
    lines.push('')
  }
  lines.push(color.dim(`State: ${STATE_DIR}`))
  return lines.join('\n')
}

function finishWithNextSteps(access: AccessV2): void {
  const tips: string[] = []
  const noToken = Object.entries(access.agents).filter(([, a]) => !isTokenSet(a.tokenEnv)).map(([k]) => k)
  const noRoom = Object.entries(access.agents).filter(([, a]) => Object.keys(a.rooms).length === 0).map(([k]) => k)
  if (noToken.length) tips.push(`${color.yellow('!')} Token missing for ${noToken.join(', ')} — run ${color.cyan('bun setup.ts')} and pick "Save token"`)
  if (noRoom.length) tips.push(`${color.yellow('!')} No room for ${noRoom.join(', ')} — run ${color.cyan('bun setup.ts')} and pick "Add a room"`)
  tips.push(`${color.green('→')} Start the relay: ${color.cyan('bun relay.ts')}`)
  p.note(tips.join('\n'), 'Next steps')
  p.outro(color.green('All done.'))
}

// ─── Main flows ───────────────────────────────────────────────────────────────

/** Guided linear wizard for a brand-new install. */
async function firstRunWizard(): Promise<void> {
  p.log.info("No agents yet — let's get you set up.")

  const access = readAccessFileV2()
  const key = await collectAgent(access)
  if (!key) { finishWithNextSteps(readAccessFileV2()); return }

  const addRoom = orCancel(await p.confirm({
    message: 'Add a room (Discord channel) now?',
    initialValue: true,
  }))
  if (addRoom) await collectRoomFlow(readAccessFileV2(), key)

  const addToken = orCancel(await p.confirm({
    message: 'Save the Discord bot token now?',
    initialValue: true,
  }))
  if (addToken) await collectToken(readAccessFileV2(), key)

  finishWithNextSteps(readAccessFileV2())
}

/** Action menu for existing setups — multiselect so several tasks run in one go. */
async function interactiveMenu(): Promise<void> {
  p.note(statusReport(readAccessFileV2()), 'Current setup')

  const TASK_ORDER = ['agent', 'room', 'peer', 'human', 'token'] as const
  type Task = typeof TASK_ORDER[number]

  let running = true
  while (running) {
    const tasks = orCancel(await p.multiselect<Task>({
      message: 'What would you like to do? (space to toggle, enter to run — nothing selected = done)',
      options: [
        { value: 'agent', label: 'Add another agent', hint: 'a second bot identity' },
        { value: 'room', label: 'Add a room', hint: 'register a channel (peers + humans follow inline)' },
        { value: 'peer', label: 'Register a peer bot', hint: 'in an existing room' },
        { value: 'human', label: 'Allow humans', hint: 'comma-separated Discord user IDs' },
        { value: 'token', label: 'Save / update a bot token' },
      ],
      required: false,
    }))

    if (tasks.length === 0) { running = false; break }

    // Execute in dependency order regardless of selection order
    const sorted = [...tasks].sort((a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b))
    for (const task of sorted) {
      const access = readAccessFileV2()
      if (task === 'agent') {
        await collectAgent(access)
      } else if (task === 'room') {
        const key = await pickAgentKey(access)
        if (key) await collectRoomFlow(access, key)
      } else if (task === 'peer') {
        await collectPeer(access)
      } else if (task === 'human') {
        await collectHumans(access)
      } else if (task === 'token') {
        await collectToken(access)
      }
    }
  }

  finishWithNextSteps(readAccessFileV2())
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  p.intro(banner())
  const access = readAccessFileV2()
  if (Object.keys(access.agents).length === 0) {
    await firstRunWizard()
  } else {
    await interactiveMenu()
  }
}

main().catch(e => {
  process.stderr.write(`setup: ${e}\n`)
  process.exit(1)
})
