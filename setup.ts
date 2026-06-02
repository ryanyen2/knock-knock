#!/usr/bin/env bun
/**
 * setup.ts — interactive setup wizard for knock-knock.
 *
 * Works for any coding agent (Codex, OpenCode, Gemini, Claude Code…).
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
import {
  STATE_DIR,
  readAccessFile,
  saveAccess,
  readSettings,
  saveSettings,
  type PermissionProfile,
} from './state.ts'
import type { Access, AgentConfig, RoomConfig } from './lib.ts'
import { expandPreset, PRESET_MODES, PRESET_HINTS, DEFAULT_PRESET } from './lib.ts'

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

/** Messaging platforms an agent can speak. Discord is production-tested; the
 *  rest are walking skeletons pending live verification (docs/messaging-platforms.md). */
const PLATFORMS = [
  { value: 'discord', label: 'Discord', hint: 'production · threads, reactions, buttons, DMs' },
  { value: 'slack', label: 'Slack', hint: 'skeleton · xoxb- token + SLACK_APP_TOKEN (Socket Mode)' },
  { value: 'telegram', label: 'Telegram', hint: 'skeleton · BotFather token · whitelist reactions + inline keyboards' },
  { value: 'whatsapp', label: 'WhatsApp', hint: 'skeleton · Cloud API · phone-id + verify-token + public webhook' },
  { value: 'imessage', label: 'iMessage', hint: 'skeleton · macOS only · Full Disk Access · no token' },
]

/** Extra env vars a platform's adapter reads beyond the bot token (the token
 *  itself uses the agent's tokenEnv). Printed as a setup hint. */
const PLATFORM_EXTRA_ENV: Record<string, string[]> = {
  slack: ['SLACK_APP_TOKEN (xapp-… for Socket Mode)'],
  whatsapp: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_WEBHOOK_PORT (default 8787)'],
}

/** What a "room channel id" is on each platform — so the prompt + validation fit
 *  the platform (only Discord uses numeric snowflakes). */
const ROOM_ID_PROMPT: Record<string, { message: string; placeholder: string }> = {
  discord: { message: 'Room channel ID (right-click channel → Copy Channel ID)', placeholder: '846209781206941736' },
  slack: { message: 'Room Slack channel ID (channel → View details, e.g. C0123ABC)', placeholder: 'C0123ABC456' },
  telegram: { message: 'Room Telegram chat ID (negative for groups, e.g. -1001234567890)', placeholder: '-1001234567890' },
  whatsapp: { message: "Room = a contact's WhatsApp number in E.164", placeholder: '+15551234567' },
  imessage: { message: 'Room iMessage chat GUID', placeholder: 'iMessage;+;chat1234567890' },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pick a named permission preset (strict / ask-per-edit / auto / bypass). */
async function pickPreset(initial: string = DEFAULT_PRESET): Promise<string> {
  return orCancel(
    await p.select({
      message: 'Permission preset',
      options: Object.keys(PRESET_MODES).map(name => ({
        value: name,
        label: name,
        hint: PRESET_HINTS[name],
      })),
      initialValue: initial,
    }),
  )
}

/** The on-disk profile object: the expanded allow/ask/deny plus a `_mode` hint
 *  (ignored by parseProfile) so the chosen preset stays visible and re-pickable. */
function profileForPreset(mode: string, overrides?: Partial<PermissionProfile>): Record<string, unknown> {
  return { _mode: mode, ...expandPreset(mode, overrides) }
}

/** Split a comma-separated pattern list, trimming and dropping blanks. */
function splitPatterns(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

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

async function pickAgentKey(access: Access): Promise<string | null> {
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

async function collectAgent(access: Access): Promise<string | null> {
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

  const platform = orCancel(await p.select({
    message: 'Which messaging platform does this bot speak?',
    options: PLATFORMS,
    initialValue: 'discord',
  }))
  if (platform !== 'discord') {
    p.log.warn(`"${platform}" is a walking-skeleton adapter — verify it live with real credentials before relying on it.`)
  }

  const ownerUserId = orCancel(await p.text({
    message:
      platform === 'discord'
        ? 'Your Discord user ID (you own this agent — approval prompts ping you)'
        : `Your ${platform} user id / handle (you own this agent — approval prompts ping you)`,
    placeholder: platform === 'discord' ? '184695080709324800' : '',
    validate: platform === 'discord' ? validateSnowflake : required,
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

  // OS-level sandbox (ACP runtimes only — the in-process SDK can't be jailed).
  let sandbox: AgentConfig['sandbox']
  const inProcess = runtime === 'claude-sdk'
  const sandboxOn = orCancel(await p.confirm({
    message: inProcess
      ? 'Sandbox this agent? (note: the in-process Claude SDK can NOT be OS-sandboxed — pick "Claude Code (ACP)" for confinement)'
      : 'Sandbox this agent? Confine file writes to the workspace at the OS level.',
    initialValue: !inProcess,
  }))
  if (sandboxOn) {
    if (inProcess) {
      p.log.warn('Runtime is in-process (claude-sdk) — the OS sandbox will be skipped; only the deny floor applies.')
    }
    const allowNet = orCancel(await p.confirm({
      message: 'Allow network access inside the sandbox?',
      initialValue: true,
    }))
    sandbox = { fs: 'workspace', network: allowNet ? 'allow' : 'deny' }
  }

  const tokenEnv = deriveTokenEnv(key)
  access.agents[key] = {
    ownerUserId,
    blurb,
    runtime,
    workspace,
    tokenEnv,
    rooms: {},
    // Omit when discord (the default) so access.json stays clean for the common case.
    ...(platform !== 'discord' ? { platform } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
  saveAccess(access)
  p.log.success(`Saved agent ${color.cyan(key)} ${color.dim(`· token env: ${tokenEnv}`)}`)
  const extraEnv = PLATFORM_EXTRA_ENV[platform]
  if (extraEnv?.length) {
    p.log.info(`${platform} also reads from .env: ${extraEnv.join(', ')}`)
  }
  return key
}

/**
 * Edit an existing agent's fields in place — platform / owner / blurb / runtime /
 * workspace / sandbox — without re-adding it (which would wipe its rooms). The
 * agent key and its `tokenEnv` are immutable here; changing those is effectively
 * a new agent. Only the fields you pick are prompted, each pre-filled with the
 * current value.
 */
async function collectReconfigure(access: Access): Promise<void> {
  const key = await pickAgentKey(access)
  if (!key) return
  const agent = access.agents[key]!
  const curPlatform = agent.platform ?? 'discord'

  type Field = 'platform' | 'owner' | 'blurb' | 'runtime' | 'workspace' | 'sandbox'
  const fields = orCancel(await p.multiselect<Field>({
    message: `Reconfigure ${color.cyan(key)} — pick fields to change (space to toggle, enter to apply; none = cancel)`,
    options: [
      { value: 'platform', label: 'Messaging platform', hint: curPlatform },
      { value: 'owner', label: 'Owner user id / handle', hint: agent.ownerUserId },
      { value: 'blurb', label: 'Blurb', hint: agent.blurb },
      { value: 'runtime', label: 'Runtime', hint: agent.runtime },
      { value: 'workspace', label: 'Workspace', hint: agent.workspace },
      {
        value: 'sandbox',
        label: 'Sandbox',
        hint: agent.sandbox ? `fs:${agent.sandbox.fs} · net:${agent.sandbox.network}` : 'off',
      },
    ],
    required: false,
  }))
  if (fields.length === 0) { p.log.info('No changes.'); return }
  const set = new Set<Field>(fields)

  // Platform first, so owner validation knows the effective platform.
  let platform = curPlatform
  if (set.has('platform')) {
    platform = orCancel(await p.select({
      message: 'Which messaging platform does this bot speak?',
      options: PLATFORMS,
      initialValue: curPlatform,
    }))
    if (platform !== 'discord') {
      p.log.warn(`"${platform}" is a walking-skeleton adapter — verify it live before relying on it.`)
    }
  }

  if (set.has('owner')) {
    agent.ownerUserId = orCancel(await p.text({
      message: platform === 'discord' ? 'Owner Discord user ID' : `Owner ${platform} user id / handle`,
      initialValue: agent.ownerUserId,
      validate: platform === 'discord' ? validateSnowflake : required,
    })).trim()
  }

  if (set.has('blurb')) {
    agent.blurb = orCancel(await p.text({
      message: 'One-line description peers will see',
      initialValue: agent.blurb,
      validate: required,
    })).trim()
  }

  if (set.has('runtime')) {
    agent.runtime = orCancel(await p.select({
      message: 'Which coding agent runs this bot?',
      options: RUNTIMES,
      initialValue: agent.runtime,
    }))
  }

  if (set.has('workspace')) {
    agent.workspace = orCancel(await p.text({
      message: 'Workspace path (absolute)',
      initialValue: agent.workspace,
      validate: validateAbsPath,
    })).trim()
    if (!existsSync(agent.workspace)) {
      p.log.warn(`${agent.workspace} doesn't exist yet — create it before launching the relay.`)
    }
  }

  if (set.has('sandbox')) {
    const inProcess = agent.runtime === 'claude-sdk'
    const sandboxOn = orCancel(await p.confirm({
      message: inProcess
        ? 'Sandbox this agent? (the in-process Claude SDK can NOT be OS-sandboxed — pick "Claude Code (ACP)" for confinement)'
        : 'Sandbox this agent? Confine file writes to the workspace at the OS level.',
      initialValue: !!agent.sandbox,
    }))
    if (sandboxOn) {
      const allowNet = orCancel(await p.confirm({
        message: 'Allow network access inside the sandbox?',
        initialValue: agent.sandbox?.network !== 'deny',
      }))
      agent.sandbox = { fs: 'workspace', network: allowNet ? 'allow' : 'deny' }
    } else {
      delete agent.sandbox
    }
  }

  // Apply platform last; omit the field when discord so access.json stays clean.
  if (set.has('platform')) {
    if (platform === 'discord') delete agent.platform
    else agent.platform = platform
  }

  saveAccess(access)
  p.log.success(`Updated agent ${color.cyan(key)}`)
  if (set.has('platform') && platform !== curPlatform) {
    p.log.warn(
      `Platform changed ${curPlatform} → ${platform}. The bot token differs per platform — ` +
        `run "Save / update a bot token" to set it.`,
    )
    const extraEnv = PLATFORM_EXTRA_ENV[platform]
    if (extraEnv?.length) p.log.info(`${platform} also reads from .env: ${extraEnv.join(', ')}`)
  }
}

/** Collect a room, then chain inline peer registration + bulk human add. */
async function collectRoomFlow(access: Access, agentKey: string): Promise<void> {
  const channelId = await collectRoom(access, agentKey)
  if (!channelId) return

  // Peer loop — add as many peers as needed without returning to menu
  let addPeer = orCancel(await p.confirm({
    message: 'Register a peer bot in this room?',
    initialValue: false,
  }))
  while (addPeer) {
    access = readAccessFile()
    await collectPeer(access, agentKey, channelId)
    addPeer = orCancel(await p.confirm({ message: 'Register another peer?', initialValue: false }))
  }

  // Bulk humans — comma-separated so multiple can be added in one prompt
  access = readAccessFile()
  await collectHumans(access, agentKey, channelId)
}

async function collectRoom(access: Access, agentKey: string): Promise<string | null> {
  const agent = access.agents[agentKey]!
  const platform = agent.platform ?? 'discord'
  const prompt = ROOM_ID_PROMPT[platform] ?? { message: 'Room channel ID', placeholder: '' }

  const channelId = orCancel(await p.text({
    message: prompt.message,
    placeholder: prompt.placeholder,
    // Only Discord ids are numeric snowflakes; other platforms use letters,
    // negative numbers, GUIDs, or phone numbers — accept any non-empty id.
    validate: platform === 'discord' ? validateSnowflake : required,
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

  const room: RoomConfig = {
    requireMention,
    participants: {},
    humans: [],
    approvalActorId: agent.ownerUserId,
  }
  agent.rooms[channelId] = room
  saveAccess(access)

  const dir = join(STATE_DIR, 'rooms', agentKey)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const profilePath = join(dir, `${channelId}.settings.json`)
  if (existsSync(profilePath)) {
    p.log.message(color.dim(`Kept existing permission profile: ${profilePath}`))
  } else {
    const mode = await pickPreset()
    writeFileSync(profilePath, JSON.stringify(profileForPreset(mode), null, 2) + '\n', { mode: 0o600 })
    p.log.message(color.dim(`Permission profile (${mode}) written: ${profilePath}`))
  }
  p.log.success(`Room ${color.cyan(channelId)} added to ${color.cyan(agentKey)}`)
  return channelId
}

/** Re-stamp a room's permission profile from a preset (+ optional extra
 *  patterns). Besides collectRoom, the only writer of these profile files —
 *  so all permission edits stay terminal-only (prompt-injection safe). */
async function collectPermissions(access: Access, agentKey?: string, channelId?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!
  const cid = channelId ?? (await pickRoomId(agent))
  if (!cid) return

  const mode = await pickPreset()

  const extraAllow = orCancel(await p.text({
    message: 'Extra allow patterns (comma-separated, optional)',
    placeholder: 'e.g. Bash(bun *), WebFetch(**)',
  })).trim()
  const extraDeny = orCancel(await p.text({
    message: 'Extra deny patterns (comma-separated, optional) — only tightens the floor',
    placeholder: 'e.g. Bash(git push *)',
  })).trim()

  const overrides: Partial<PermissionProfile> = {
    allow: splitPatterns(extraAllow),
    deny: splitPatterns(extraDeny),
  }

  // Optional per-actor tiers: narrow what a peer/human may do on this agent's
  // behalf (e.g. peers get read-only). Each tier is itself a preset expansion,
  // stored under its actor key ('agent' | 'human' | 'peer:<botId>').
  const tiers: Record<string, PermissionProfile> = {}
  let addTier = orCancel(await p.confirm({
    message: 'Add a per-actor permission tier (e.g. peers get read-only)?',
    initialValue: false,
  }))
  while (addTier) {
    const who = orCancel(await p.select({
      message: 'Whose turns does this tier govern?',
      options: [
        { value: 'agent', label: 'All peer agents', hint: 'any registered peer bot' },
        { value: 'human', label: 'Non-owner humans', hint: 'listed humans (not you)' },
        { value: 'peer', label: 'A specific peer', hint: 'one bot by Discord user ID' },
      ],
    }))
    let tierKey: string = who
    if (who === 'peer') {
      const tierPlatform = agent.platform ?? 'discord'
      const peerId = orCancel(await p.text({
        message: tierPlatform === 'discord' ? "Peer bot's Discord user ID" : `Peer bot's ${tierPlatform} user id`,
        validate: tierPlatform === 'discord' ? validateSnowflake : required,
      })).trim()
      tierKey = `peer:${peerId}`
    }
    const tierMode = await pickPreset('strict')
    tiers[tierKey] = expandPreset(tierMode)
    p.log.success(`Tier ${color.cyan(tierKey)} → ${color.cyan(tierMode)}`)
    addTier = orCancel(await p.confirm({ message: 'Add another tier?', initialValue: false }))
  }

  const profileObj = profileForPreset(mode, overrides)
  if (Object.keys(tiers).length > 0) profileObj.tiers = tiers

  const dir = join(STATE_DIR, 'rooms', key)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const profilePath = join(dir, `${cid}.settings.json`)
  writeFileSync(profilePath, JSON.stringify(profileObj, null, 2) + '\n', { mode: 0o600 })
  p.log.success(`Permissions for room ${color.cyan(cid)} set to ${color.cyan(mode)}`)
  p.log.message(color.dim(profilePath))
}

/** Choose the ledger backend: local SQLite or remote Postgres. Remote is the
 *  recommended default (cross-machine collaboration); a blank URL ⇒ local. The
 *  connection string lives in settings.json (chmod 600), never from chat. */
async function collectLedger(): Promise<void> {
  const settings = readSettings()
  const choice = orCancel(await p.select({
    message: 'Where should the shared ledger live?',
    options: [
      { value: 'postgres', label: 'Remote (Postgres)', hint: 'recommended · cross-machine collaboration' },
      { value: 'sqlite', label: 'Local (SQLite)', hint: 'single machine · no extra setup' },
    ],
    initialValue: settings.ledger?.backend ?? 'postgres',
  }))

  if (choice === 'sqlite') {
    saveSettings({ ...settings, ledger: { backend: 'sqlite' } })
    p.log.success('Ledger set to local SQLite.')
    return
  }

  p.log.message(color.dim('Neon/Postgres connection string — get it from your provider dashboard.'))
  const url = orCancel(await p.password({
    message: 'Postgres connection string (blank to use local instead)',
    validate: (v: string | undefined) => {
      const s = (v ?? '').trim()
      if (!s) return undefined // blank → fall back to local
      if (!/^postgres(ql)?:\/\//.test(s)) return 'Must start with postgres:// or postgresql://'
      return undefined
    },
  })).trim()

  if (!url) {
    saveSettings({ ...settings, ledger: { backend: 'sqlite' } })
    p.log.info('No connection string given — using local SQLite for now.')
    return
  }
  saveSettings({ ...settings, ledger: { backend: 'postgres', url } })
  p.log.success(`Ledger set to remote Postgres ${color.dim(`· ${url.replace(/:[^:@]+@/, ':***@')}`)}`)
}

async function collectPeer(access: Access, agentKey?: string, channelId?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!
  const cid = channelId ?? (await pickRoomId(agent))
  if (!cid) return

  const peerPlatform = agent.platform ?? 'discord'
  const peerBotId = orCancel(await p.text({
    message:
      peerPlatform === 'discord'
        ? "Peer bot's Discord user ID (right-click their bot → Copy User ID)"
        : `Peer bot's ${peerPlatform} user id`,
    placeholder: peerPlatform === 'discord' ? '987654321098765432' : '',
    validate: peerPlatform === 'discord' ? validateSnowflake : required,
  })).trim()

  const peerName = orCancel(await p.text({
    message: 'Peer name (optional)',
    placeholder: 'agent-b',
  })).trim()

  const peerBlurb = orCancel(await p.text({
    message: 'Peer description',
    placeholder: 'deploy specialist',
    validate: required,
  })).trim()

  agent.rooms[cid]!.participants[peerBotId] = {
    ...(peerName ? { name: peerName } : {}),
    blurb: peerBlurb,
  }
  saveAccess(access)
  p.log.success(`Peer ${color.cyan(peerBotId)}${peerName ? ` (${peerName})` : ''} registered`)
  p.log.message(color.dim('Make sure they register your bot on their side too.'))
}

/** Bulk-add humans via comma-separated IDs. Called both from the room flow and
 *  the menu, so agentKey + channelId may come pre-picked or require prompts. */
async function collectHumans(access: Access, agentKey?: string, channelId?: string): Promise<void> {
  const key = agentKey ?? (await pickAgentKey(access))
  if (!key) return
  const agent = access.agents[key]!
  const cid = channelId ?? (await pickRoomId(agent))
  if (!cid) return

  const platform = agent.platform ?? 'discord'
  const raw = orCancel(await p.text({
    message:
      platform === 'discord'
        ? 'Allow humans to drive this agent? Discord user IDs, comma-separated (leave blank to skip)'
        : `Allow humans to drive this agent? ${platform} user ids / handles, comma-separated (leave blank to skip)`,
    placeholder: 'leave blank to skip',
  })).trim()
  if (!raw) return

  // Only Discord ids are numeric snowflakes; other platforms use letters, phones,
  // or emails — accept any non-empty id there.
  const isValidId = (id: string): boolean => (platform === 'discord' ? /^\d{17,20}$/.test(id) : id.length > 0)
  const all = raw.split(',').map(s => s.trim()).filter(Boolean)
  const valid = all.filter(isValidId)
  const invalid = all.filter(id => !isValidId(id))
  if (invalid.length) p.log.warn(`Skipped invalid IDs: ${invalid.join(', ')}`)
  if (!valid.length) return

  const room = agent.rooms[cid]!
  let added = 0
  for (const id of valid) {
    if (!room.humans.includes(id)) { room.humans.push(id); added++ }
  }
  if (added > 0) {
    saveAccess(access)
    p.log.success(`Added ${added} human${added > 1 ? 's' : ''} to room ${cid}`)
  } else {
    p.log.info('All provided user IDs were already in the room.')
  }
}

async function collectToken(access: Access, agentKey?: string): Promise<void> {
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

function statusReport(access: Access): string {
  const agents = Object.entries(access.agents)
  if (agents.length === 0) return color.dim('No agents configured yet.')

  const lines: string[] = []
  for (const [key, agent] of agents) {
    const tokenMark = isTokenSet(agent.tokenEnv) ? color.green('✓') : color.red('✗ missing')
    lines.push(`${color.cyan(color.bold(key))}  ${agent.name ?? color.dim('(not connected yet)')}`)
    lines.push(`  ${color.dim('blurb    ')} ${agent.blurb}`)
    if (agent.platform && agent.platform !== 'discord') {
      lines.push(`  ${color.dim('platform ')} ${color.yellow(agent.platform)} ${color.dim('(skeleton)')}`)
    }
    lines.push(`  ${color.dim('runtime  ')} ${agent.runtime}`)
    lines.push(`  ${color.dim('workspace')} ${agent.workspace || color.yellow('not set')}`)
    if (agent.sandbox) {
      lines.push(`  ${color.dim('sandbox  ')} fs:${agent.sandbox.fs} · network:${agent.sandbox.network}`)
    }
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
  const ledger = readSettings().ledger
  const ledgerLabel = ledger?.backend === 'postgres'
    ? `remote Postgres ${color.dim(`· ${(ledger.url ?? '').replace(/:[^:@]+@/, ':***@')}`)}`
    : ledger?.backend === 'sqlite'
      ? 'local SQLite'
      : color.dim('local SQLite (default — run "Choose ledger backend" to use Postgres)')
  lines.push(`${color.dim('ledger   ')} ${ledgerLabel}`)
  lines.push(color.dim(`State: ${STATE_DIR}`))
  return lines.join('\n')
}

function finishWithNextSteps(access: Access): void {
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

  const access = readAccessFile()
  const key = await collectAgent(access)
  if (!key) { finishWithNextSteps(readAccessFile()); return }

  const addRoom = orCancel(await p.confirm({
    message: 'Add a room (Discord channel) now?',
    initialValue: true,
  }))
  if (addRoom) await collectRoomFlow(readAccessFile(), key)

  const addToken = orCancel(await p.confirm({
    message: 'Save the Discord bot token now?',
    initialValue: true,
  }))
  if (addToken) await collectToken(readAccessFile(), key)

  const setupLedger = orCancel(await p.confirm({
    message: 'Set up the shared ledger now? (recommended: remote Postgres for collaboration)',
    initialValue: true,
  }))
  if (setupLedger) await collectLedger()

  finishWithNextSteps(readAccessFile())
}

/** Action menu for existing setups — multiselect so several tasks run in one go. */
async function interactiveMenu(): Promise<void> {
  p.note(statusReport(readAccessFile()), 'Current setup')

  const TASK_ORDER = ['agent', 'reconfigure', 'room', 'peer', 'human', 'permissions', 'token', 'ledger'] as const
  type Task = typeof TASK_ORDER[number]

  let running = true
  while (running) {
    const tasks = orCancel(await p.multiselect<Task>({
      message: 'What would you like to do? (space to toggle, enter to run — nothing selected = done)',
      options: [
        { value: 'agent', label: 'Add another agent', hint: 'a second bot identity' },
        { value: 'reconfigure', label: 'Reconfigure an agent', hint: 'change platform / runtime / workspace / blurb / owner' },
        { value: 'room', label: 'Add a room', hint: 'register a channel (peers + humans follow inline)' },
        { value: 'peer', label: 'Register a peer bot', hint: 'in an existing room' },
        { value: 'human', label: 'Allow humans', hint: 'comma-separated Discord user IDs' },
        { value: 'permissions', label: 'Set room permissions', hint: 'pick a preset (strict/auto/bypass/…)' },
        { value: 'token', label: 'Save / update a bot token' },
        { value: 'ledger', label: 'Choose ledger backend', hint: 'local SQLite or remote Postgres' },
      ],
      required: false,
    }))

    if (tasks.length === 0) { running = false; break }

    // Execute in dependency order regardless of selection order
    const sorted = [...tasks].sort((a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b))
    for (const task of sorted) {
      const access = readAccessFile()
      if (task === 'agent') {
        await collectAgent(access)
      } else if (task === 'reconfigure') {
        await collectReconfigure(access)
      } else if (task === 'room') {
        const key = await pickAgentKey(access)
        if (key) await collectRoomFlow(access, key)
      } else if (task === 'peer') {
        await collectPeer(access)
      } else if (task === 'human') {
        await collectHumans(access)
      } else if (task === 'permissions') {
        await collectPermissions(access)
      } else if (task === 'token') {
        await collectToken(access)
      } else if (task === 'ledger') {
        await collectLedger()
      }
    }
  }

  finishWithNextSteps(readAccessFile())
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  p.intro(banner())
  const access = readAccessFile()
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
