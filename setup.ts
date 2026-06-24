#!/usr/bin/env bun
/**
 * setup.ts — interactive setup for knock-knock.
 *
 * Channel-centric: you declare the BOTS you run, the CHANNELS (projects) they work
 * in, and a ROSTER of people/peer bots you collaborate with — entered once and
 * picked from a list thereafter. A channel is a permission boundary: each member
 * bot gets its own workspace folder + permission preset *for that project*.
 *
 * Works for any coding agent (Codex, OpenCode, Gemini, Claude Code…) and any
 * platform (Discord is production-tested; the rest are experimental skeletons).
 *
 * Usage:
 *   bun setup.ts           First run → guided wizard; existing setup → action menu
 *
 * Writes to:
 *   STATE_DIR/access.json   (normalized: me / bots / channels / roster)
 *   STATE_DIR/.env          (bot tokens, chmod 600)
 *   STATE_DIR/settings.json (ledger backend)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import * as p from '@clack/prompts'
import color from 'picocolors'
import {
  STATE_DIR,
  readAuthoringAccess,
  saveAuthoringAccess,
  readSettings,
  saveSettings,
} from './state.ts'
import type {
  AuthoringAccess,
  Bot,
  Channel,
  Membership,
  Person,
  Peer,
  Platform,
  RoomProfile,
} from './lib.ts'
import {
  channelKey,
  expandPreset,
  PRESET_MODES,
  PRESET_HINTS,
  DEFAULT_PRESET,
  resolveLedgerConfig,
} from './lib.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')

// Mirror the relay: load the state-dir .env into process.env (without clobbering
// vars Bun already auto-loaded) so token/ledger status reflects what the relay sees.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

const RUNTIMES = [
  { value: 'claude-sdk', label: 'Claude Code', hint: 'in-process SDK · no install · needs ANTHROPIC_API_KEY' },
  { value: 'codex', label: 'OpenAI Codex', hint: 'via ACP (npx) · needs OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', hint: 'via ACP · needs opencode installed' },
  { value: 'gemini', label: 'Gemini CLI', hint: 'via ACP · needs gemini installed' },
  { value: 'claude-acp', label: 'Claude Code (ACP)', hint: 'via ACP (npx) instead of in-process' },
  { value: 'acp', label: 'Other ACP agent', hint: 'set KNOCK_KNOCK_ACP_COMMAND yourself' },
]

/** What auth each coding agent needs beyond the platform bot token. The agent runs
 *  in the relay's process env (loaded once from ~/.knock-knock/.env), so saving the
 *  key there makes it available to EVERY bot/channel using that runtime — set once,
 *  reused everywhere, regardless of which folder you launch from. */
const RUNTIME_AUTH: Record<string, { envVar?: string; hint: string }> = {
  'claude-sdk': { envVar: 'ANTHROPIC_API_KEY', hint: 'or an existing `claude` login' },
  'claude-acp': { envVar: 'ANTHROPIC_API_KEY', hint: 'or an existing `claude` login' },
  codex: { envVar: 'OPENAI_API_KEY', hint: 'your OpenAI API key' },
  gemini: { hint: 'run `gemini` once to log in — no env var needed' },
  opencode: { hint: 'configure opencode auth per its docs' },
  acp: { hint: 'auth is handled by your KNOCK_KNOCK_ACP_COMMAND agent' },
}

/** Offer to save a coding agent's API key into ~/.knock-knock/.env when it isn't
 *  already set. A shared key (e.g. ANTHROPIC_API_KEY) is asked once, then reused. */
async function ensureRuntimeAuth(runtime: string, force = false): Promise<void> {
  const auth = RUNTIME_AUTH[runtime]
  if (!auth) return
  if (!auth.envVar) { p.log.info(`${runtime}: ${auth.hint}.`); return }
  if (isTokenSet(auth.envVar) && !force) { p.log.success(`${auth.envVar} already set ${color.dim('✓')}`); return }
  const save = force || orCancel(await p.confirm({
    message: `${runtime} needs ${auth.envVar} (${auth.hint}). Save it to .env now?`,
    initialValue: true,
  }))
  if (!save) { p.log.info(`Set ${auth.envVar} before starting the relay (${auth.hint}).`); return }
  const val = orCancel(await p.password({ message: auth.envVar, validate: required })).trim()
  setToken(auth.envVar, val)
  p.log.success(`Saved ${auth.envVar} to .env ${color.dim(`· ***${val.slice(-4)}`)}`)
}

/** All coding-agent API-key env vars in use (bot defaults + per-channel overrides). */
function runtimeKeysInUse(a: AuthoringAccess): Array<{ runtime: string; envVar: string }> {
  const runtimes = new Set<string>()
  for (const b of Object.values(a.bots)) runtimes.add(b.runtime)
  for (const ch of Object.values(a.channels)) for (const m of ch.members) if (m.runtime) runtimes.add(m.runtime)
  const out: Array<{ runtime: string; envVar: string }> = []
  for (const r of runtimes) {
    const v = RUNTIME_AUTH[r]?.envVar
    if (v && !out.some(o => o.envVar === v)) out.push({ runtime: r, envVar: v })
  }
  return out
}

/** Menu action: save/update a coding-agent API key in ~/.knock-knock/.env. */
async function saveCodingAgentKey(a: AuthoringAccess): Promise<void> {
  const keys = runtimeKeysInUse(a)
  if (keys.length === 0) { p.log.info('No coding agent in use needs an API key (they use their own login).'); return }
  const runtime = keys.length === 1 ? keys[0]!.runtime : (orCancel(await p.select({
    message: 'Save the API key for which coding agent?',
    options: keys.map(k => ({ value: k.runtime, label: k.runtime, hint: `${k.envVar}${isTokenSet(k.envVar) ? ' ✓' : ' ✗ missing'}` })),
  })) as string)
  await ensureRuntimeAuth(runtime, true)
}

/** Messaging platforms a bot can speak. Discord is production-tested; the rest are
 *  walking skeletons pending live verification (docs/messaging-platforms.md). */
const PLATFORMS: Array<{ value: Platform; label: string; hint: string }> = [
  { value: 'discord', label: 'Discord', hint: 'production · threads, reactions, buttons, DMs' },
  { value: 'slack', label: 'Slack', hint: 'skeleton · xoxb- token + SLACK_APP_TOKEN (Socket Mode)' },
  { value: 'telegram', label: 'Telegram', hint: 'skeleton · BotFather token' },
  { value: 'whatsapp', label: 'WhatsApp', hint: 'skeleton · Cloud API · phone-id + verify-token' },
  { value: 'imessage', label: 'iMessage', hint: 'skeleton · macOS only · Full Disk Access · no token' },
]

const PLATFORM_EXTRA_ENV: Record<string, string[]> = {
  slack: ['SLACK_APP_TOKEN (xapp-… for Socket Mode)'],
  whatsapp: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_WEBHOOK_PORT (default 8787)'],
}

/** What a channel id looks like on each platform — so prompts/validation fit. */
const CHANNEL_ID_PROMPT: Record<string, { message: string; placeholder: string }> = {
  discord: { message: 'Channel ID (right-click channel → Copy Channel ID)', placeholder: '846209781206941736' },
  slack: { message: 'Slack channel ID (channel → View details, e.g. C0123ABC)', placeholder: 'C0123ABC456' },
  telegram: { message: 'Telegram chat ID (negative for groups)', placeholder: '-1001234567890' },
  whatsapp: { message: "Contact's WhatsApp number (E.164)", placeholder: '+15551234567' },
  imessage: { message: 'iMessage chat GUID', placeholder: 'iMessage;+;chat1234567890' },
}

const TOKEN_ENV_PREFIX: Record<string, string> = {
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
  whatsapp: 'WHATSAPP_TOKEN',
  imessage: 'IMESSAGE_TOKEN',
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

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

/** A stable kebab-case local id from a label/handle, made unique against `taken`. */
function slugify(s: string, taken: Set<string> = new Set()): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/** Env-var name for a bot's token: the bare friendly name unless another same-
 *  platform bot already claims it, in which case suffix with the bot key. */
function deriveTokenEnv(key: string, platform: Platform, a: AuthoringAccess): string {
  const prefix = TOKEN_ENV_PREFIX[platform] ?? 'BOT_TOKEN'
  const suffixed = `${prefix}_${key.toUpperCase().replace(/-/g, '_')}`
  const bareTaken = Object.entries(a.bots).some(([k, b]) => k !== key && b.tokenEnv === prefix)
  return bareTaken ? suffixed : prefix
}

// ─── Validators ─────────────────────────────────────────────────────────────────

function required(v: string | undefined): string | undefined {
  return (v ?? '').trim() ? undefined : 'Required.'
}

function validateBotKey(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  if (!s) return 'Required.'
  if (!/^[a-z0-9-]+$/.test(s)) return 'Lowercase letters, digits, and hyphens only.'
  return undefined
}

/** Per-platform user/channel id validator (only Discord uses numeric snowflakes). */
function idValidatorFor(platform: Platform): (v: string | undefined) => string | undefined {
  if (platform !== 'discord') return required
  return v => {
    const s = (v ?? '').trim()
    if (!s) return 'Required.'
    if (!/^\d{17,20}$/.test(s)) return 'Discord IDs are 17–20 digits (Developer Mode → Copy ID).'
    return undefined
  }
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
  const fromFile = readEnvVars().get(tokenEnv)
  if (fromFile !== undefined && fromFile !== '') return true
  const fromProc = process.env[tokenEnv]
  return fromProc !== undefined && fromProc !== ''
}

function setToken(tokenEnv: string, token: string): void {
  const vars = readEnvVars()
  vars.set(tokenEnv, token)
  writeEnvVars(vars)
}

// ─── Owner identity (set once per platform) ───────────────────────────────────

/** Ensure `me[platform]` is known — the owner whose approvals get pinged. Asked
 *  ONCE per platform, then reused for every bot/channel on it. */
async function ensureMe(a: AuthoringAccess, platform: Platform): Promise<string> {
  const existing = a.me?.[platform]
  if (existing) return existing
  const id = orCancel(await p.text({
    message:
      platform === 'discord'
        ? 'Your Discord user ID (you own these bots — approval prompts ping you)'
        : `Your ${platform} user id / handle (you own these bots — approvals ping you)`,
    placeholder: platform === 'discord' ? '184695080709324800' : '',
    validate: idValidatorFor(platform),
  })).trim()
  a.me = { ...(a.me ?? {}), [platform]: id }
  return id
}

// ─── Permission preset picker ──────────────────────────────────────────────────

async function pickPreset(initial: string = DEFAULT_PRESET): Promise<string> {
  return orCancel(await p.select({
    message: 'Permission preset for this bot in this channel',
    options: Object.keys(PRESET_MODES).map(name => ({ value: name, label: name, hint: PRESET_HINTS[name] })),
    initialValue: initial,
  }))
}

/** Expand a preset name into the inline RoomProfile stored on a membership. */
function profileFromPreset(name: string): RoomProfile {
  return expandPreset(name)
}

// ─── Bots ───────────────────────────────────────────────────────────────────────

/** Add a bot identity. Name/avatar live on the platform (not typed here). */
async function addBot(a: AuthoringAccess): Promise<string | null> {
  const has = Object.keys(a.bots).length > 0
  const key = orCancel(await p.text({
    message: 'Bot key (a short local nickname — the platform name is fetched on connect)',
    placeholder: has ? 'reviewer' : 'assistant',
    initialValue: has ? '' : 'assistant',
    validate: v => {
      const e = validateBotKey(v)
      if (e) return e
      if (a.bots[(v ?? '').trim()]) return 'A bot with that key already exists.'
      return undefined
    },
  })).trim()

  const platform = orCancel(await p.select({
    message: 'Which messaging platform is this bot on?',
    options: PLATFORMS,
    initialValue: 'discord' as Platform,
  })) as Platform
  if (platform !== 'discord') {
    const proceed = orCancel(await p.confirm({
      message: `"${platform}" is an experimental walking-skeleton adapter — use it anyway?`,
      initialValue: false,
    }))
    if (!proceed) { p.log.info('Cancelled — Discord is the supported surface.'); return null }
  }

  await ensureMe(a, platform)

  const runtime = orCancel(await p.select({
    message: 'Which coding agent powers this bot? (its default — switchable per channel)',
    options: RUNTIMES,
    initialValue: 'claude-sdk',
  }))
  await ensureRuntimeAuth(runtime)

  const blurb = orCancel(await p.text({
    message: 'One-line description peers see (optional)',
    placeholder: 'read-only research agent',
  })).trim()

  // OS-level sandbox (ACP runtimes only — the in-process SDK can't be jailed).
  let sandbox: Bot['sandbox']
  const inProcess = runtime === 'claude-sdk'
  const sandboxOn = orCancel(await p.confirm({
    message: inProcess
      ? 'Sandbox this bot? (note: in-process claude-sdk can NOT be OS-sandboxed — pick "Claude Code (ACP)" for confinement)'
      : 'Sandbox this bot? Confine file writes to its workspace at the OS level.',
    initialValue: !inProcess,
  }))
  if (sandboxOn) {
    if (inProcess) p.log.warn('Runtime is in-process — the OS sandbox is skipped; only the deny floor applies.')
    const allowNet = orCancel(await p.confirm({ message: 'Allow network inside the sandbox?', initialValue: true }))
    sandbox = { fs: 'workspace', network: allowNet ? 'allow' : 'deny' }
  }

  const tokenEnv = deriveTokenEnv(key, platform, a)
  let appTokenEnv: string | undefined
  if (platform === 'slack') {
    appTokenEnv = (orCancel(await p.text({
      message: 'Env var holding this Slack app-level token (xapp-…, Socket Mode)',
      placeholder: 'SLACK_APP_TOKEN',
      defaultValue: 'SLACK_APP_TOKEN',
    })) as string).trim() || 'SLACK_APP_TOKEN'
  }

  a.bots[key] = {
    platform,
    tokenEnv,
    runtime,
    ...(blurb ? { blurb } : {}),
    ...(appTokenEnv ? { appTokenEnv } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
  saveAuthoringAccess(a)
  p.log.success(`Saved bot ${color.cyan(key)} ${color.dim(`· ${platform} · token env: ${tokenEnv}`)}`)
  const extra = PLATFORM_EXTRA_ENV[platform]
  if (extra?.length) p.log.info(`${platform} also reads from .env: ${extra.join(', ')}`)
  return key
}

// ─── Roster (people + peer bots, entered once) ─────────────────────────────────

/** Add a human to the roster. Returns the new roster id. */
async function addPerson(a: AuthoringAccess, platform: Platform): Promise<string | null> {
  const label = orCancel(await p.text({ message: 'Name / label for this person', placeholder: 'alice' })).trim()
  const userId = orCancel(await p.text({
    message: platform === 'discord' ? "Their Discord user ID" : `Their ${platform} user id / handle`,
    placeholder: platform === 'discord' ? '184695080709324800' : '',
    validate: idValidatorFor(platform),
  })).trim()
  const id = slugify(label || userId, new Set(Object.keys(a.roster.people)))
  const person: Person = { platform, userId, ...(label ? { label } : {}) }
  a.roster.people[id] = person
  saveAuthoringAccess(a)
  p.log.success(`Added person ${color.cyan(label || userId)} to the roster`)
  return id
}

/** Add a peer bot to the roster. Returns the new roster id. */
async function addPeer(a: AuthoringAccess, platform: Platform): Promise<string | null> {
  const label = orCancel(await p.text({ message: 'Name / label for this peer bot', placeholder: 'deploy-bot' })).trim()
  const userId = orCancel(await p.text({
    message: platform === 'discord' ? "Peer bot's Discord user ID" : `Peer bot's ${platform} user id`,
    placeholder: platform === 'discord' ? '987654321098765432' : '',
    validate: idValidatorFor(platform),
  })).trim()
  const blurb = orCancel(await p.text({ message: 'What does this peer do?', placeholder: 'deploy specialist', validate: required })).trim()
  const id = slugify(label || userId, new Set(Object.keys(a.roster.peers)))
  const peer: Peer = { platform, userId, blurb, ...(label ? { label } : {}) }
  a.roster.peers[id] = peer
  saveAuthoringAccess(a)
  p.log.success(`Added peer ${color.cyan(label || userId)} to the roster`)
  return id
}

/** Pick collaborators (humans + peers) for a channel from the roster, with an
 *  inline "+ add new" so an unknown id is added to the roster once and reused. */
async function pickCollaborators(a: AuthoringAccess, platform: Platform, ch: Channel): Promise<void> {
  const ADD_PERSON = ' +person'
  const ADD_PEER = ' +peer'
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const people = Object.entries(a.roster.people).filter(([, x]) => x.platform === platform)
    const peers = Object.entries(a.roster.peers).filter(([, x]) => x.platform === platform)
    const have = new Set(ch.collaborators.map(c => `${c.kind}:${c.id}`))
    const options = [
      ...people.map(([id, x]) => ({ value: `human:${id}`, label: `👤 ${x.label ?? x.userId}`, hint: x.userId })),
      ...peers.map(([id, x]) => ({ value: `peer:${id}`, label: `🤖 ${x.label ?? x.userId}`, hint: x.blurb })),
      { value: ADD_PERSON, label: color.dim('+ add a new person to the roster') },
      { value: ADD_PEER, label: color.dim('+ add a new peer bot to the roster') },
    ]
    const picked = orCancel(await p.multiselect({
      message: 'Collaborators in this channel (space to toggle; pick "+ add" to register a new one)',
      options,
      initialValues: [...have],
      required: false,
    })) as string[]

    // Persist the real selections first, so they survive a round-trip through
    // "+ add a new …" (which loops to re-render with the new roster entry).
    ch.collaborators = picked
      .filter(v => v !== ADD_PERSON && v !== ADD_PEER)
      .map(v => {
        const [kind, id] = v.split(':') as ['human' | 'peer', string]
        return { kind, id }
      })
    if (picked.includes(ADD_PERSON)) { await addPerson(a, platform); continue }
    if (picked.includes(ADD_PEER)) { await addPeer(a, platform); continue }
    return
  }
}

// ─── Channels (projects = permission boundaries) ────────────────────────────────

/** Add a channel and wire its members + collaborators. */
async function addChannel(a: AuthoringAccess): Promise<void> {
  const botKeys = Object.keys(a.bots)
  if (botKeys.length === 0) { p.log.error('Add a bot first — a channel needs at least one member bot.'); return }

  // The platform is determined by the member bots; pick from the platforms you have.
  const platforms = [...new Set(Object.values(a.bots).map(b => b.platform))]
  const platform = platforms.length === 1
    ? platforms[0]!
    : (orCancel(await p.select({
        message: 'Which platform is this channel on?',
        options: PLATFORMS.filter(pl => platforms.includes(pl.value)),
      })) as Platform)

  const idPrompt = CHANNEL_ID_PROMPT[platform] ?? CHANNEL_ID_PROMPT.discord!
  const channelId = orCancel(await p.text({
    message: idPrompt.message,
    placeholder: idPrompt.placeholder,
    validate: idValidatorFor(platform),
  })).trim()

  const ck = channelKey(platform, channelId)
  const existing = a.channels[ck]
  const label = orCancel(await p.text({
    message: 'Friendly project name for this channel (optional)',
    placeholder: '#infra-prod',
    initialValue: existing?.label ?? '',
  })).trim()

  const ch: Channel = existing ?? { platform, channelId, members: [], collaborators: [] }
  if (label) ch.label = label

  // Members: which of my bots (on this platform) work here, each with a workspace + preset.
  const eligible = botKeys.filter(k => a.bots[k]!.platform === platform)
  const memberKeys = orCancel(await p.multiselect({
    message: 'Which of your bots are members of this channel?',
    options: eligible.map(k => ({ value: k, label: k, hint: a.bots[k]!.blurb })),
    initialValues: ch.members.map(m => m.bot).filter(b => eligible.includes(b)),
    required: true,
  })) as string[]

  const members: Membership[] = []
  for (const botKey of memberKeys) {
    const prev = ch.members.find(m => m.bot === botKey)
    p.log.step(`${color.cyan(botKey)} in ${label || `#${channelId}`}`)
    const workspace = orCancel(await p.text({
      message:
        `Workspace folder for ${botKey} in THIS channel (absolute) ` +
        (prev ? color.dim('(saved)') : color.dim('(new member — defaulting to cwd)')),
      placeholder: process.cwd(),
      initialValue: prev?.workspace ?? process.cwd(),
      validate: validateAbsPath,
    })).trim()
    if (!existsSync(workspace)) p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
    const preset = await pickPreset(prev?.preset ?? DEFAULT_PRESET)
    // The bot is a portal: pick which local coding agent drives it HERE. Default
    // is the bot's own runtime; override to use a different agent in this project.
    const botDefault = a.bots[botKey]!.runtime
    const runtime = orCancel(await p.select({
      message: `Coding agent for ${botKey} in THIS channel`,
      options: RUNTIMES,
      initialValue: prev?.runtime ?? botDefault,
    }))
    if (runtime !== botDefault) await ensureRuntimeAuth(runtime)
    members.push({
      bot: botKey,
      workspace,
      preset,
      profile: profileFromPreset(preset),
      // Store only when it differs from the bot default, to keep access.json clean.
      ...(runtime !== botDefault ? { runtime } : {}),
    })
  }
  ch.members = members

  // File exchange (see docs/file-exchange.md): the preset already governs outbound
  // sharing via FileShare (ask by default, deny under strict, allow under bypass),
  // and the credential floor (.env / keys / .ssh / …) can be neither read NOR
  // shared under ANY preset — it's in the deny floor and isn't disableable here.
  if (members.length > 0) {
    p.log.info(
      'File sharing: outbound shares follow FileShare (ask by default); credential files (.env, keys) can never be read or shared, regardless of preset.',
    )
  }

  await pickCollaborators(a, platform, ch)

  ch.requireMention = orCancel(await p.confirm({
    message: 'Require an @mention before a bot responds here?',
    initialValue: ch.requireMention ?? true,
  }))

  a.channels[ck] = ch
  saveAuthoringAccess(a)
  p.log.success(`Saved channel ${color.cyan(label || channelId)} ${color.dim(`· ${members.length} bot(s) · ${ch.collaborators.length} collaborator(s)`)}`)
}

/** Remove a channel. */
async function removeChannel(a: AuthoringAccess): Promise<void> {
  const keys = Object.keys(a.channels)
  if (keys.length === 0) { p.log.info('No channels to remove.'); return }
  const ck = orCancel(await p.select({
    message: 'Remove which channel?',
    options: keys.map(k => ({ value: k, label: a.channels[k]!.label ?? k })),
  })) as string
  const confirm = orCancel(await p.confirm({ message: `Remove ${ck}? (bots/roster are kept)`, initialValue: false }))
  if (!confirm) return
  delete a.channels[ck]
  saveAuthoringAccess(a)
  p.log.success(`Removed channel ${ck}`)
}

/** Edit a bot's mutable fields (runtime / blurb / sandbox). Platform + tokenEnv are
 *  immutable — changing those is effectively a new bot. */
async function editBot(a: AuthoringAccess): Promise<void> {
  const keys = Object.keys(a.bots)
  if (keys.length === 0) { p.log.info('No bots to edit.'); return }
  const key = keys.length === 1 ? keys[0]! : (orCancel(await p.select({
    message: 'Edit which bot?',
    options: keys.map(k => ({ value: k, label: k, hint: `${a.bots[k]!.platform} · ${a.bots[k]!.runtime}` })),
  })) as string)
  const bot = a.bots[key]!

  type Field = 'runtime' | 'blurb' | 'sandbox'
  const fields = orCancel(await p.multiselect<Field>({
    message: `Edit ${color.cyan(key)} — pick fields to change (space to toggle; none = cancel)`,
    options: [
      { value: 'runtime', label: 'Runtime', hint: bot.runtime },
      { value: 'blurb', label: 'Blurb', hint: bot.blurb ?? '(none)' },
      { value: 'sandbox', label: 'Sandbox', hint: bot.sandbox ? `fs:${bot.sandbox.fs} · net:${bot.sandbox.network}` : 'off' },
    ],
    required: false,
  }))
  if (fields.length === 0) { p.log.info('No changes.'); return }
  const set = new Set<Field>(fields)

  if (set.has('runtime')) bot.runtime = orCancel(await p.select({ message: 'Runtime', options: RUNTIMES, initialValue: bot.runtime }))
  if (set.has('blurb')) {
    const b = orCancel(await p.text({ message: 'One-line description (blank to clear)', initialValue: bot.blurb ?? '' })).trim()
    if (b) bot.blurb = b
    else delete bot.blurb
  }
  if (set.has('sandbox')) {
    const inProcess = bot.runtime === 'claude-sdk'
    const on = orCancel(await p.confirm({ message: 'Sandbox this bot (confine writes to its workspace)?', initialValue: !!bot.sandbox }))
    if (!on) delete bot.sandbox
    else {
      if (inProcess) p.log.warn('Runtime is in-process (claude-sdk) — the OS sandbox is skipped; only the deny floor applies.')
      const allowNet = orCancel(await p.confirm({ message: 'Allow network inside the sandbox?', initialValue: bot.sandbox?.network !== 'deny' }))
      bot.sandbox = { fs: 'workspace', network: allowNet ? 'allow' : 'deny' }
    }
  }
  saveAuthoringAccess(a)
  p.log.success(`Updated bot ${color.cyan(key)}`)
}

/** Remove a person/peer from the roster (and drop it from every channel's collaborators). */
async function removeRosterEntry(a: AuthoringAccess): Promise<void> {
  const opts = [
    ...Object.entries(a.roster.people).map(([id, x]) => ({ value: `human:${id}`, label: `👤 ${x.label ?? x.userId}`, hint: x.userId })),
    ...Object.entries(a.roster.peers).map(([id, x]) => ({ value: `peer:${id}`, label: `🤖 ${x.label ?? x.userId}`, hint: x.blurb })),
  ]
  if (opts.length === 0) { p.log.info('Roster is empty.'); return }
  const picked = orCancel(await p.select({ message: 'Remove which roster entry?', options: opts })) as string
  const [kind, id] = picked.split(':') as ['human' | 'peer', string]
  const confirm = orCancel(await p.confirm({ message: `Remove ${picked}? (also drops it from every channel)`, initialValue: false }))
  if (!confirm) return
  if (kind === 'human') delete a.roster.people[id]
  else delete a.roster.peers[id]
  for (const ch of Object.values(a.channels)) {
    ch.collaborators = ch.collaborators.filter(c => !(c.kind === kind && c.id === id))
  }
  saveAuthoringAccess(a)
  p.log.success(`Removed ${picked} from the roster`)
}

/** Remove a bot (and drop it from every channel's members). */
async function removeBot(a: AuthoringAccess): Promise<void> {
  const keys = Object.keys(a.bots)
  if (keys.length === 0) { p.log.info('No bots to remove.'); return }
  const key = orCancel(await p.select({ message: 'Remove which bot?', options: keys.map(k => ({ value: k, label: k })) })) as string
  const confirm = orCancel(await p.confirm({ message: `Remove bot ${key}?`, initialValue: false }))
  if (!confirm) return
  delete a.bots[key]
  for (const ch of Object.values(a.channels)) ch.members = ch.members.filter(m => m.bot !== key)
  saveAuthoringAccess(a)
  p.log.success(`Removed bot ${key}`)
}

// ─── Tokens ─────────────────────────────────────────────────────────────────────

async function saveBotToken(a: AuthoringAccess, botKey?: string): Promise<void> {
  const keys = Object.keys(a.bots)
  if (keys.length === 0) { p.log.error('Add a bot first.'); return }
  const key = botKey ?? (keys.length === 1 ? keys[0]! : (orCancel(await p.select({
    message: 'Save a token for which bot?',
    options: keys.map(k => ({ value: k, label: k, hint: isTokenSet(a.bots[k]!.tokenEnv) ? '✓ set' : '✗ missing' })),
  })) as string))
  const bot = a.bots[key]!
  p.log.message(color.dim(bot.platform === 'discord' ? 'Get it from: discord.com/developers → your app → Bot → Reset Token' : `Get the ${bot.platform} bot token from its developer console.`))
  const token = orCancel(await p.password({ message: `Bot token for ${color.cyan(key)}`, validate: required })).trim()
  setToken(bot.tokenEnv, token)
  p.log.success(`Saved to .env as ${bot.tokenEnv} ${color.dim(`· ***${token.slice(-4)}`)}`)
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

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
  p.log.message(color.dim('Neon/Postgres connection string — from your provider dashboard.'))
  const url = orCancel(await p.password({
    message: 'Postgres connection string (blank to use local instead)',
    validate: v => {
      const s = (v ?? '').trim()
      if (!s) return undefined
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

// ─── Status dashboard ─────────────────────────────────────────────────────────

function statusReport(a: AuthoringAccess): string {
  const bots = Object.entries(a.bots)
  const channels = Object.entries(a.channels)
  const collabCount = Object.keys(a.roster.people).length + Object.keys(a.roster.peers).length
  if (bots.length === 0) return color.dim('Nothing configured yet.')

  const lines: string[] = []
  lines.push(color.dim(`${bots.length} bot(s) · ${channels.length} channel(s) · ${collabCount} collaborator(s)`))
  lines.push('')
  lines.push(color.bold('BOTS'))
  for (const [key, bot] of bots) {
    const mark = isTokenSet(bot.tokenEnv) ? color.green('●') : color.red('○')
    const name = bot.displayName ?? color.dim('(name from platform on connect)')
    const skel = bot.platform !== 'discord' ? color.yellow(` ${bot.platform} (skeleton)`) : ` ${bot.platform}`
    lines.push(`  ${mark} ${color.cyan(key)}  ${name}  ${color.dim(skel)}  ${color.dim(bot.runtime)}${bot.sandbox ? color.dim(` · sandbox`) : ''}`)
  }
  lines.push('')
  lines.push(color.bold('CHANNELS') + color.dim('  (project = permission boundary)'))
  if (channels.length === 0) lines.push(color.dim('  (none — add one)'))
  for (const [, ch] of channels) {
    const head = `  ${color.cyan(ch.label ?? `#${ch.channelId}`)}  ${color.dim(ch.platform)}${ch.requireMention === false ? color.dim(' · no @mention') : ''}`
    lines.push(head)
    for (const m of ch.members) {
      const agentNote = m.runtime ? color.dim(` · ${m.runtime}`) : ''
      lines.push(`      ${m.bot}  ${color.dim(`·${m.preset ?? DEFAULT_PRESET}·`)}  ${color.dim(m.workspace)}${agentNote}`)
    }
    if (ch.collaborators.length) {
      const names = ch.collaborators.map(c => {
        const r = c.kind === 'human' ? a.roster.people[c.id] : a.roster.peers[c.id]
        return (c.kind === 'human' ? '👤' : '🤖') + (r?.label ?? r?.userId ?? c.id)
      })
      lines.push(`      ${color.dim('collab:')} ${names.join(' ')}`)
    }
  }
  if (collabCount > 0) {
    lines.push('')
    lines.push(color.bold('ROSTER'))
    const people = Object.values(a.roster.people).map(x => x.label ?? x.userId)
    const peers = Object.values(a.roster.peers).map(x => x.label ?? x.userId)
    if (people.length) lines.push(`  ${color.dim('people')} ${people.join(', ')}`)
    if (peers.length) lines.push(`  ${color.dim('peers ')} ${peers.join(', ')}`)
  }

  const authKeys = runtimeKeysInUse(a)
  if (authKeys.length > 0) {
    lines.push('')
    lines.push(color.bold('CODING-AGENT AUTH') + color.dim('  (one key per agent, shared by all bots)'))
    for (const k of authKeys) {
      const mark = isTokenSet(k.envVar) ? color.green('✓') : color.red('✗ missing')
      lines.push(`  ${color.dim(k.runtime.padEnd(11))} ${k.envVar} ${mark}`)
    }
  }

  lines.push('')
  const settingsLedger = readSettings().ledger
  const resolved = resolveLedgerConfig(process.env, readSettings())
  let ledgerLabel: string
  if (resolved.backend === 'postgres') {
    ledgerLabel = `remote Postgres ${color.dim(`· ${(resolved.url ?? '').replace(/:[^:@]+@/, ':***@')}`)}`
  } else {
    ledgerLabel = settingsLedger?.backend === 'sqlite' ? 'local SQLite' : color.dim('local SQLite (default)')
  }
  lines.push(`${color.dim('ledger ')} ${ledgerLabel}`)
  lines.push(color.dim(`state  ${STATE_DIR}`))
  return lines.join('\n')
}

function finishWithNextSteps(a: AuthoringAccess): void {
  const tips: string[] = []
  const noToken = Object.entries(a.bots).filter(([, b]) => !isTokenSet(b.tokenEnv)).map(([k]) => k)
  const memberOf = new Set(Object.values(a.channels).flatMap(c => c.members.map(m => m.bot)))
  const noChannel = Object.keys(a.bots).filter(k => !memberOf.has(k))
  if (noToken.length) tips.push(`${color.yellow('!')} Token missing for ${noToken.join(', ')} — run setup → "Save a bot token"`)
  if (noChannel.length) tips.push(`${color.yellow('!')} ${noChannel.join(', ')} isn't a member of any channel — add it to one`)
  const noKey = runtimeKeysInUse(a).filter(k => !isTokenSet(k.envVar))
  if (noKey.length) tips.push(`${color.yellow('!')} API key missing: ${noKey.map(k => k.envVar).join(', ')} — run setup → "Save a coding-agent API key" (or use the agent's own login)`)
  tips.push(`${color.green('→')} Start the relay: ${color.cyan('bun relay.ts')} ${color.dim('(prints who listens where)')}`)
  tips.push(`${color.green('→')} Tune a thread in-chat (owner): ${color.cyan('!config role <text>')} — ${color.cyan('!config help')}`)
  p.note(tips.join('\n'), 'Next steps')
  p.outro(color.green('All done.'))
}

// ─── Main flows ───────────────────────────────────────────────────────────────

/** Guided linear wizard for a brand-new install: bot → channel → token → ledger. */
async function firstRunWizard(): Promise<void> {
  p.log.info("Let's set up your first bot and a channel for it to work in.")
  let a = readAuthoringAccess()
  const key = await addBot(a)
  if (!key) { finishWithNextSteps(readAuthoringAccess()); return }

  a = readAuthoringAccess()
  const addCh = orCancel(await p.confirm({ message: 'Add a channel (project) for this bot now?', initialValue: true }))
  if (addCh) { await addChannel(a); a = readAuthoringAccess() }

  const addTok = orCancel(await p.confirm({ message: 'Save the bot token now?', initialValue: true }))
  if (addTok) { await saveBotToken(readAuthoringAccess(), key) }

  const setLedger = orCancel(await p.confirm({ message: 'Set up the shared ledger now? (Postgres for collaboration)', initialValue: true }))
  if (setLedger) await collectLedger()

  finishWithNextSteps(readAuthoringAccess())
}

/** Action menu for existing setups. */
async function interactiveMenu(): Promise<void> {
  p.note(statusReport(readAuthoringAccess()), 'Current setup')

  const TASK_ORDER = ['bot', 'bot-edit', 'channel', 'channel-remove', 'person', 'peer', 'roster-remove', 'token', 'api-key', 'ledger', 'bot-remove'] as const
  type Task = typeof TASK_ORDER[number]

  let running = true
  while (running) {
    const tasks = orCancel(await p.multiselect<Task>({
      message: 'What would you like to do? (space to toggle, enter to run — nothing selected = done)',
      options: [
        { value: 'bot', label: 'Add a bot', hint: 'a bot identity you run' },
        { value: 'bot-edit', label: 'Edit a bot', hint: 'runtime / blurb / sandbox' },
        { value: 'channel', label: 'Add / edit a channel', hint: 'project: members + workspaces + collaborators' },
        { value: 'channel-remove', label: 'Remove a channel' },
        { value: 'person', label: 'Add a person to the roster' },
        { value: 'peer', label: 'Add a peer bot to the roster' },
        { value: 'roster-remove', label: 'Remove a roster entry', hint: 'person or peer (drops it from channels too)' },
        { value: 'token', label: 'Save / update a bot token' },
        { value: 'api-key', label: 'Save / update a coding-agent API key', hint: 'e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY' },
        { value: 'ledger', label: 'Choose ledger backend', hint: 'local SQLite or remote Postgres' },
        { value: 'bot-remove', label: 'Remove a bot' },
      ],
      required: false,
    }))
    if (tasks.length === 0) { running = false; break }

    const sorted = [...tasks].sort((x, y) => TASK_ORDER.indexOf(x) - TASK_ORDER.indexOf(y))
    for (const task of sorted) {
      const a = readAuthoringAccess()
      if (task === 'bot') await addBot(a)
      else if (task === 'bot-edit') await editBot(a)
      else if (task === 'channel') await addChannel(a)
      else if (task === 'channel-remove') await removeChannel(a)
      else if (task === 'person') {
        const platform = await pickRosterPlatform(a)
        if (platform) await addPerson(a, platform)
      } else if (task === 'peer') {
        const platform = await pickRosterPlatform(a)
        if (platform) await addPeer(a, platform)
      } else if (task === 'roster-remove') await removeRosterEntry(a)
      else if (task === 'token') await saveBotToken(a)
      else if (task === 'api-key') await saveCodingAgentKey(a)
      else if (task === 'ledger') await collectLedger()
      else if (task === 'bot-remove') await removeBot(a)
    }
    p.note(statusReport(readAuthoringAccess()), 'Current setup')
  }
  finishWithNextSteps(readAuthoringAccess())
}

/** Pick the platform a new roster entry is on (defaults to the only platform). */
async function pickRosterPlatform(a: AuthoringAccess): Promise<Platform | null> {
  const platforms = [...new Set(Object.values(a.bots).map(b => b.platform))]
  if (platforms.length === 0) return 'discord'
  if (platforms.length === 1) return platforms[0]!
  return orCancel(await p.select({
    message: 'Which platform is this collaborator on?',
    options: PLATFORMS.filter(pl => platforms.includes(pl.value)),
  })) as Platform
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  p.intro(banner())
  const a = readAuthoringAccess()
  if (Object.keys(a.bots).length === 0) await firstRunWizard()
  else await interactiveMenu()
}

main().catch(e => {
  process.stderr.write(`setup: ${e}\n`)
  process.exit(1)
})
