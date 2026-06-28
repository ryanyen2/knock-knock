#!/usr/bin/env bun
/**
 * setup.ts — interactive, channel-centric setup. Declare bots, channels (projects =
 * permission boundaries), and a roster; writes access.json / .env / settings.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import * as p from '@clack/prompts'
import color from 'picocolors'
import {
  STATE_DIR,
  readAuthoringAccess,
  saveAuthoringAccess,
  readSettings,
  saveSettings,
  readPending,
  writePending,
  readTrustAnchors,
  addTombstone,
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
  Proposal,
  Need,
} from './lib.ts'
import {
  channelKey,
  expandPreset,
  renameBot,
  PRESET_MODES,
  PRESET_HINTS,
  DEFAULT_PRESET,
  resolveLedgerConfig,
  resolveGaps,
  applyConfirmedProposal,
  confirmedIdentitiesFor,
  detectCollision,
  driftedSincePropose,
  makeNonce,
  nonceMatch,
  renderClaimedPeer,
  tombstoneForProposal,
} from './lib.ts'
import { assembleSnapshot, connectDiscoveryAdapter, itemsOf } from './discovery.ts'
import type { MessagingAdapter } from './messaging-adapter.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const ENV_FILE = join(STATE_DIR, '.env')

// Load the state-dir .env into process.env (without clobbering) so status reflects the relay.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

const RUNTIMES = [
  { value: 'claude-sdk', label: 'Claude Code', hint: 'in-process SDK · no install · local login or API key' },
  { value: 'codex', label: 'OpenAI Codex', hint: 'via ACP (npx) · ChatGPT login or OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', hint: 'via ACP · run opencode → /connect to configure auth' },
  { value: 'gemini', label: 'Gemini CLI', hint: 'via ACP · Google account login or GEMINI_API_KEY' },
  { value: 'claude-acp', label: 'Claude Code (ACP)', hint: 'via ACP (npx) · local login or API key' },
  { value: 'acp', label: 'Other ACP agent', hint: 'set KNOCK_KNOCK_ACP_COMMAND yourself' },
]

/** What auth each coding agent needs beyond the bot token. Saved to ~/.knock-knock/.env,
 *  so it's available to every bot/channel using that runtime — set once, reused.
 *  `optional: true` means the envVar is one of several valid auth methods — existing
 *  login or gateway credentials also work and are detected before asking. */
const RUNTIME_AUTH: Record<string, { envVar?: string; hint: string; optional?: boolean }> = {
  'claude-sdk': {
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'optional — existing `claude` login or LLM gateway (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) also work',
    optional: true,
  },
  'claude-acp': {
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'optional — existing `claude` login or LLM gateway (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) also work',
    optional: true,
  },
  codex: { envVar: 'OPENAI_API_KEY', hint: 'or run the agent once to log in with ChatGPT' },
  gemini: {
    envVar: 'GEMINI_API_KEY',
    hint: 'optional — Google account login also works; run `gemini` once to sign in',
    optional: true,
  },
  opencode: { hint: 'run opencode → /connect to set up auth (stored in ~/.local/share/opencode/auth.json)' },
  acp: { hint: 'auth is handled by your KNOCK_KNOCK_ACP_COMMAND agent' },
}

/** Detect non-envVar auth already configured for optional runtimes.
 *  Returns a human-readable description of the auth found, or null when none detected. */
function hasAlternateAuth(runtime: string): string | null {
  if (runtime === 'claude-sdk' || runtime === 'claude-acp') {
    if (isTokenSet('ANTHROPIC_AUTH_TOKEN')) return 'ANTHROPIC_AUTH_TOKEN (LLM gateway) already set'
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    if (existsSync(join(dir, '.credentials.json'))) return '`claude` local login found — no API key needed'
    try {
      const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
        env?: Record<string, unknown>
      }
      const e = s?.env ?? {}
      if (typeof e.ANTHROPIC_API_KEY === 'string' && e.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY configured in ~/.claude/settings.json'
      if (typeof e.ANTHROPIC_AUTH_TOKEN === 'string' && e.ANTHROPIC_AUTH_TOKEN) return 'ANTHROPIC_AUTH_TOKEN (gateway) configured in ~/.claude/settings.json'
    } catch {}
    return null
  }
  if (runtime === 'gemini') {
    if (existsSync(join(homedir(), '.gemini'))) return '`gemini` login found — no API key needed'
    return null
  }
  return null
}

/** Offer to save a coding agent's API key into .env when unset (shared keys asked once).
 *  For optional runtimes (claude-sdk, claude-acp, gemini) existing login or gateway
 *  credentials are detected first and skip the prompt entirely. */
async function ensureRuntimeAuth(runtime: string, force = false): Promise<void> {
  const auth = RUNTIME_AUTH[runtime]
  if (!auth) return
  if (!auth.envVar) { p.log.info(`${runtime}: ${auth.hint}.`); return }
  if (isTokenSet(auth.envVar) && !force) { p.log.success(`${auth.envVar} already set ${color.dim('✓')}`); return }
  // For optional runtimes, check for alternate auth before prompting.
  if (!force && auth.optional) {
    const alt = hasAlternateAuth(runtime)
    if (alt) { p.log.success(alt); return }
  }
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

// ─── Platform descriptors ───────────────────────────────────────────────────
// Everything platform-shaped lives here so the flows below stay platform-neutral
// (mirrors the runtime MessagingAdapter seam). See docs/messaging-platforms-setup.md.

/** Build a simple required + regex validator. */
function mkValidate(re: RegExp, msg: string): (v?: string) => string | undefined {
  return (v?: string) => {
    const s = (v ?? '').trim()
    if (!s) return 'Required.'
    return re.test(s) ? undefined : msg
  }
}

/** Notion ids are 32 hex chars, with or without dashes. */
function notionId(v?: string): string | undefined {
  const s = (v ?? '').trim().replace(/-/g, '')
  if (!s) return 'Required.'
  return /^[0-9a-f]{32}$/i.test(s) ? undefined : 'A Notion ID is 32 hex characters (copy the page link).'
}

/** An extra secret a platform needs beyond the primary token (e.g. Slack's app token).
 *  `optional` secrets may be left blank at save time; `whenWebhook` secrets are only
 *  collected when the bot uses `intake: 'webhook'`. */
type SecretSpec = {
  name: string
  envBase: string
  label: string
  howto: string
  optional?: boolean
  whenWebhook?: boolean
}

type PlatformSpec = {
  value: Platform
  label: string
  hint: string
  tokenEnvBase: string // base env-var NAME for the primary token
  tokenHowto: string // where to get the primary token
  secrets: SecretSpec[] // extra secrets → bot.secretEnv (logical name → env var)
  idLabel: string // channel/scope id prompt
  idHowto?: string // optional multi-line "how to find this id" help, printed before the prompt
  idPlaceholder: string
  idValidate: (v?: string) => string | undefined
  ownerLabel: string // owner/me id prompt
  ownerPlaceholder: string
  ownerValidate: (v?: string) => string | undefined
  memberIdLabel: string // roster person/peer id prompt
  notes: string[] // post-setup reminders printed after adding a bot/channel
  /** Poll-based platforms (github/notion) can opt into event-driven webhook intake. */
  supportsWebhook?: boolean
  /** Onboarding lines printed when the bot is set to `intake: 'webhook'`. */
  webhookNotes?: string[]
}

const PLATFORMS: Record<Platform, PlatformSpec> = {
  discord: {
    value: 'discord', label: 'Discord', hint: 'full-fidelity · gateway WebSocket',
    tokenEnvBase: 'DISCORD_BOT_TOKEN',
    tokenHowto: 'discord.com/developers → your app → Bot → Reset Token',
    secrets: [],
    idLabel: 'Channel ID (right-click channel → Copy Channel ID)',
    idPlaceholder: '846209781206941736',
    idValidate: discordId,
    ownerLabel: 'Your Discord user ID (you own these bots — approval prompts ping you)',
    ownerPlaceholder: '184695080709324800',
    ownerValidate: discordId,
    memberIdLabel: 'Their Discord user ID',
    notes: [],
  },
  slack: {
    value: 'slack', label: 'Slack', hint: 'full-fidelity · Socket Mode',
    tokenEnvBase: 'SLACK_BOT_TOKEN',
    tokenHowto: 'api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-)',
    secrets: [{
      name: 'appToken', envBase: 'SLACK_APP_TOKEN', label: 'Slack app-level token (xapp-)',
      howto: 'api.slack.com/apps → Basic Information → App-Level Tokens → scope connections:write',
    }],
    idLabel: 'Slack channel ID (channel name → About → Channel ID)',
    idPlaceholder: 'C0123ABCD',
    idValidate: mkValidate(/^[CGD][A-Z0-9]{6,}$/i, 'Slack channel IDs look like C0123ABCD.'),
    ownerLabel: 'Your Slack member ID (avatar → Profile → ⋯ → Copy member ID)',
    ownerPlaceholder: 'U0123ABCD',
    ownerValidate: mkValidate(/^[UW][A-Z0-9]{6,}$/i, 'Slack member IDs look like U0123ABCD.'),
    memberIdLabel: 'Their Slack member ID (U0123ABCD)',
    notes: [
      'Enable Socket Mode, Event Subscriptions, and Interactivity in your Slack app.',
      'Invite the bot to each channel: /invite @yourbot.',
    ],
  },
  telegram: {
    value: 'telegram', label: 'Telegram', hint: 'near-parity · long-poll',
    tokenEnvBase: 'TELEGRAM_BOT_TOKEN',
    tokenHowto: '@BotFather → /newbot → copy the HTTP API token',
    secrets: [],
    idLabel: 'Telegram chat ID (negative for groups; -100… for supergroups)',
    idHowto: [
      'Finding the chat ID:',
      '  • DM / private chat: message @userinfobot — it replies with your numeric id (the chat id, positive).',
      '  • Group / supergroup: add @RawDataBot (or @getidsbot) to the group; it posts the chat id (negative,',
      '    supergroups start with -100). Remove it afterwards.',
      '  • Or, after the bot has its token: send any message in the chat, then open',
      '    https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates and read result[].message.chat.id.',
    ].join('\n'),
    idPlaceholder: '-1001234567890',
    idValidate: mkValidate(/^-?\d{5,}$/, 'Telegram chat IDs are integers (often negative).'),
    ownerLabel: 'Your Telegram user ID (DM @userinfobot)',
    ownerPlaceholder: '184695080',
    ownerValidate: mkValidate(/^\d{4,}$/, 'Telegram user IDs are numeric.'),
    memberIdLabel: 'Their Telegram user ID (numeric)',
    notes: [
      'BotFather → disable Group Privacy so the bot sees group messages.',
      'Make the bot a group admin for reactions; /start it yourself to receive DMs.',
    ],
  },
  github: {
    value: 'github', label: 'GitHub', hint: 'async (~60s poll, or webhook) · issues / PRs',
    tokenEnvBase: 'GITHUB_BOT_TOKEN',
    tokenHowto: 'github.com → Settings → Developer settings → PAT (scopes: repo, notifications) on a machine-user account',
    secrets: [{
      name: 'webhookSecret', envBase: 'GITHUB_WEBHOOK_SECRET',
      label: 'GitHub webhook secret (optional — verifies X-Hub-Signature-256)',
      howto: 'the secret you set on the App/repo webhook (or `gh webhook forward`); leave blank to skip verification',
      optional: true, whenWebhook: true,
    }],
    idLabel: 'Repository (owner/repo)',
    idPlaceholder: 'acme/widgets',
    idValidate: mkValidate(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/repo, e.g. acme/widgets.'),
    ownerLabel: 'Owner GitHub login (the allowed @mentioner)',
    ownerPlaceholder: 'octocat',
    ownerValidate: mkValidate(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'A GitHub login (letters, digits, hyphens).'),
    memberIdLabel: 'Their GitHub login',
    notes: [
      'The bot account must be a collaborator/member of the repo.',
      'Poll mode: ~60s latency. On public repos only OWNER/MEMBER/COLLABORATOR authors are auto-trusted.',
    ],
    supportsWebhook: true,
    webhookNotes: [
      'Webhook intake (no public URL needed): install the CLI extension `gh extension install cli/gh-webhook`,',
      'then forward issue comments to the relay:',
      '  gh webhook forward --repo <owner/repo> --events issue_comment --url http://localhost:8787/github/<botKey>',
      'Set KNOCK_KNOCK_WEBHOOK_PORT if 8787 is taken. For a GitHub App webhook, front it with smee.io instead.',
    ],
  },
  notion: {
    value: 'notion', label: 'Notion', hint: 'async (~10s poll, or webhook) · page comments',
    tokenEnvBase: 'NOTION_TOKEN',
    tokenHowto: 'notion.so/profile/integrations → New connection → Access token (workspace-scoped, ntn_…). A user PAT or an internal-integration secret both work.',
    secrets: [{
      name: 'notionVerificationToken', envBase: 'NOTION_VERIFICATION_TOKEN',
      label: 'Notion webhook verification token (optional — auto-captured on first event)',
      howto: 'shown when you Create the subscription in the integration; leave blank to capture it from the handshake',
      optional: true, whenWebhook: true,
    }],
    idLabel: 'Notion page or database ID (32 hex chars from the page link)',
    idPlaceholder: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    idValidate: notionId,
    ownerLabel: 'Your Notion user ID (from GET /v1/users)',
    ownerPlaceholder: '',
    ownerValidate: (v?: string) => ((v ?? '').trim() ? undefined : 'Required.'),
    memberIdLabel: 'Their Notion user ID',
    notes: [
      'CRITICAL: connect each page/database to the integration (Page → ••• → Connections) — or it sees nothing.',
      'Enable capabilities: Read/Insert content, Read/Insert comments, Read user info. Comments are edited in place.',
    ],
    supportsWebhook: true,
    webhookNotes: [
      'Webhook intake needs a public URL: run a tunnel (cloudflared/ngrok) to KNOCK_KNOCK_WEBHOOK_PORT (default 8787),',
      'then in the integration → Webhooks → Create subscription, paste https://<tunnel>/notion/<botKey>,',
      'pick the Comment events, and Notion will POST a verification token (auto-captured on the first request).',
    ],
  },
}

/** Pick a platform (used when adding a bot). */
async function pickPlatform(): Promise<Platform> {
  return orCancel(await p.select({
    message: 'Which messaging platform does this bot speak?',
    options: Object.values(PLATFORMS).map(s => ({ value: s.value, label: s.label, hint: s.hint })),
    initialValue: 'discord' as Platform,
  })) as Platform
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

/** Env-var names already claimed by other bots (primary tokens + extra secrets). */
function envTaken(a: AuthoringAccess, exceptKey: string): Set<string> {
  const taken = new Set<string>()
  for (const [k, b] of Object.entries(a.bots)) {
    if (k === exceptKey) continue
    taken.add(b.tokenEnv)
    for (const v of Object.values(b.secretEnv ?? {})) taken.add(v)
  }
  return taken
}

/** A bare env-var name unless it's taken, in which case suffix it with the bot key. */
function deriveEnv(base: string, key: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  return `${base}_${key.toUpperCase().replace(/-/g, '_')}`
}

/** Is a bot fully credentialed — primary token AND every declared secret set? */
function botFullyTokened(bot: Bot): boolean {
  if (!isTokenSet(bot.tokenEnv)) return false
  for (const env of Object.values(bot.secretEnv ?? {})) if (!isTokenSet(env)) return false
  return true
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

/** Discord user/channel id validator (numeric snowflakes). */
function discordId(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  if (!s) return 'Required.'
  if (!/^\d{17,20}$/.test(s)) return 'Discord IDs are 17–20 digits (Developer Mode → Copy ID).'
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

/** Ensure `me[platform]` is known — the owner pinged for approvals. Asked once per platform. */
async function ensureMe(a: AuthoringAccess, spec: PlatformSpec): Promise<string> {
  const existing = a.me?.[spec.value]
  if (existing) return existing
  const id = orCancel(await p.text({
    message: spec.ownerLabel,
    placeholder: spec.ownerPlaceholder,
    validate: spec.ownerValidate,
  })).trim()
  a.me = { ...(a.me ?? {}), [spec.value]: id }
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

  const platform = await pickPlatform()
  const spec = PLATFORMS[platform]
  await ensureMe(a, spec)

  // The coding agent is a DEFAULT, not part of the bot's identity — it's switchable
  // per channel and in chat (`!config agent`). Offer to set one now, or take the
  // Claude Code default and move on.
  let runtime = 'claude-sdk'
  const setAgent = orCancel(await p.confirm({
    message: 'Set this bot’s default coding agent now? (switchable per-channel & in chat — defaults to Claude Code)',
    initialValue: false,
  }))
  if (setAgent) {
    runtime = orCancel(await p.select({
      message: 'Default coding agent for this bot',
      options: RUNTIMES,
      initialValue: 'claude-sdk',
    }))
    await ensureRuntimeAuth(runtime)
  }

  const blurb = orCancel(await p.text({
    message: 'One-line description peers see (optional)',
    placeholder: 'read-only research agent',
  })).trim()

  // Intake mode: poll (default, no inbound server) vs webhook (event-driven, lower
  // latency; needs forwarding/tunnel). Only the poll-based platforms offer the choice.
  let intake: 'poll' | 'webhook' = 'poll'
  if (spec.supportsWebhook) {
    intake = orCancel(await p.select({
      message: 'Inbound intake mode?',
      options: [
        { value: 'poll', label: 'Poll (default)', hint: 'pure local · no inbound server' },
        { value: 'webhook', label: 'Webhook', hint: 'event-driven · lower latency · needs forwarding/tunnel' },
      ],
      initialValue: 'poll',
    })) as 'poll' | 'webhook'
  }

  const taken = envTaken(a, key)
  const tokenEnv = deriveEnv(spec.tokenEnvBase, key, taken)
  taken.add(tokenEnv)
  const secretEnv: Record<string, string> = {}
  // Webhook-only secrets are skipped unless this bot uses webhook intake.
  const applicableSecrets = spec.secrets.filter(s => !s.whenWebhook || intake === 'webhook')
  for (const s of applicableSecrets) {
    const env = deriveEnv(s.envBase, key, taken)
    secretEnv[s.name] = env
    taken.add(env)
  }

  a.bots[key] = {
    platform,
    tokenEnv,
    ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
    runtime,
    ...(intake === 'webhook' ? { intake } : {}),
    ...(blurb ? { blurb } : {}),
  }
  saveAuthoringAccess(a)
  const secretNote = applicableSecrets.length ? ` (+${applicableSecrets.length} secret)` : ''
  const intakeNote = intake === 'webhook' ? ' · webhook' : ''
  p.log.success(`Saved bot ${color.cyan(key)} ${color.dim(`· ${platform}${intakeNote} · token env: ${tokenEnv}${secretNote}`)}`)
  if (spec.notes.length) p.log.info(spec.notes.join('\n'))
  if (intake === 'webhook' && spec.webhookNotes?.length) p.log.info(spec.webhookNotes.join('\n'))
  return key
}

// ─── Roster (people + peer bots, entered once) ─────────────────────────────────

/** Add a human to the roster. Returns the new roster id. */
async function addPerson(a: AuthoringAccess, platform: Platform): Promise<string | null> {
  const spec = PLATFORMS[platform]
  const label = orCancel(await p.text({ message: 'Name / label for this person', placeholder: 'alice' })).trim()
  const userId = orCancel(await p.text({
    message: spec.memberIdLabel,
    placeholder: spec.ownerPlaceholder,
    validate: spec.ownerValidate,
  })).trim()
  const id = slugify(label || userId, new Set(Object.keys(a.roster.people)))
  const person: Person = { platform, userId, ...(label ? { label } : {}) }
  a.roster.people[id] = person
  saveAuthoringAccess(a)
  p.log.success(`Added person ${color.cyan(label || userId)} to the roster`)
  return id
}

/** Add a peer bot to the roster. Returns the new roster id. */
async function addPeer(a: AuthoringAccess, platform: Platform, offerTransport = false): Promise<string | null> {
  const spec = PLATFORMS[platform]
  const label = orCancel(await p.text({ message: 'Name / label for this peer bot', placeholder: 'deploy-bot' })).trim()
  const userId = orCancel(await p.text({
    message: `Peer bot's ${spec.label} ${platform === 'github' ? 'login' : 'user ID'}`,
    placeholder: spec.ownerPlaceholder || '987654321098765432',
    validate: spec.ownerValidate,
  })).trim()
  const blurb = orCancel(await p.text({ message: 'What does this peer do?', placeholder: 'deploy specialist', validate: required })).trim()
  const id = slugify(label || userId, new Set(Object.keys(a.roster.peers)))
  const peer: Peer = { platform, userId, blurb, ...(label ? { label } : {}) }
  a.roster.peers[id] = peer
  saveAuthoringAccess(a)
  p.log.success(`Added peer ${color.cyan(label || userId)} to the roster`)

  // A peer bot is another machine's bot — that's cross-machine intent. Tell the user what makes
  // the two machines actually coordinate, so they don't hit "the other bot just never responds."
  const hasTransport = Object.values(a.channels).some(c => c.meshTransport)
  p.log.info(
    'This is a cross-machine peer. Once you add it as a collaborator in a channel, the mesh turns\n' +
      'on automatically (SQLite backend) — no env var needed — so the two machines share a directory\n' +
      'and take turns without conflict. Both machines must run knock-knock with this peer configured.\n' +
      (hasTransport
        ? 'You already have a dedicated transport channel, so coordination traffic stays out of human rooms.'
        : 'Tip: add a dedicated transport channel so the coordination traffic (⟦kk-mesh⟧ lines) stays\n' +
          'out of your human rooms — otherwise it posts there.'),
  )
  // From the top-level roster menu we can offer to set one up right now; inline (mid channel
  // setup) we don't, to avoid a re-entrant channel flow.
  if (offerTransport && !hasTransport) {
    const make = orCancel(await p.confirm({
      message: 'Set up a dedicated mesh-transport channel now?',
      initialValue: true,
    }))
    if (make) await addChannel(a)
  }
  return id
}

/** Pick collaborators for a channel from the roster, with an inline "+ add new". */
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

    // Persist real selections first, so they survive a "+ add new" round-trip.
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

  // A channel's platform is its member bots' platform. Pick it when bots span several.
  const botPlatforms = [...new Set(botKeys.map(k => a.bots[k]!.platform))]
  const platform: Platform = botPlatforms.length === 1
    ? botPlatforms[0]!
    : (orCancel(await p.select({
        message: 'This channel is on which platform?',
        options: botPlatforms.map(pl => ({ value: pl, label: PLATFORMS[pl].label })),
      })) as Platform)
  const spec = PLATFORMS[platform]
  if (spec.idHowto) p.log.message(color.dim(spec.idHowto))
  const channelId = orCancel(await p.text({
    message: spec.idLabel,
    placeholder: spec.idPlaceholder,
    validate: spec.idValidate,
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

  // Dedicated mesh-transport channel: carries ONLY ⟦kk-mesh⟧ coordination lines, never human
  // chat. Marking a channel here is what keeps the base64 coordination traffic out of your human
  // rooms — without one, the mesh falls back to posting those lines (incl. discovery beacons) to
  // the human channels. Use a NEW empty channel, and add the SAME channel on every machine.
  p.log.message(
    color.dim(
      'A transport channel hides ⟦kk-mesh⟧ traffic from human rooms. Use a brand-new, empty\n' +
        'channel (it will never carry chat or tasks), and add the SAME channel id on every machine.',
    ),
  )
  const isTransport = orCancel(await p.confirm({
    message: 'Is this a dedicated mesh-transport channel (cross-machine coordination only)?',
    initialValue: ch.meshTransport ?? false,
  }))
  if (isTransport) ch.meshTransport = true
  else delete ch.meshTransport

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
    // Which local coding agent drives this bot HERE; default is the bot's own runtime.
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
      // Store runtime only when it differs from the bot default.
      ...(runtime !== botDefault ? { runtime } : {}),
    })
  }
  ch.members = members

  // A transport channel carries no human chat — collaborators and @mention gating don't apply,
  // so skip those prompts. Everything else (members, workspaces) is the same.
  if (!isTransport) {
    // The preset governs outbound sharing via FileShare; the credential floor can be
    // neither read nor shared under any preset (deny floor, not disableable here).
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
  }

  a.channels[ck] = ch
  saveAuthoringAccess(a)
  if (isTransport) {
    p.log.success(`Saved mesh-transport channel ${color.cyan(label || channelId)} ${color.dim(`· ${members.length} bot(s)`)}`)
    p.log.info(
      'Mesh transport set. Add this SAME channel (same id, meshTransport) on every machine, and\n' +
        'invite each machine\'s bots to it. The relay will then post all ⟦kk-mesh⟧ lines here — your\n' +
        'human channels stay clean. Restart the relay to apply; the startup line shows `transport=<id>`.',
    )
  } else {
    p.log.success(`Saved channel ${color.cyan(label || channelId)} ${color.dim(`· ${members.length} bot(s) · ${ch.collaborators.length} collaborator(s)`)}`)
  }
  if (spec.notes.length) p.log.info(spec.notes.join('\n'))
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

/** Edit a bot's mutable coding-agent defaults (runtime / blurb). Platform +
 *  tokenEnv are immutable. `preKey` skips the picker (used by the bot-centric bundle). */
async function editBot(a: AuthoringAccess, preKey?: string): Promise<void> {
  const keys = Object.keys(a.bots)
  if (keys.length === 0) { p.log.info('No bots to edit.'); return }
  const key = preKey ?? (keys.length === 1 ? keys[0]! : (orCancel(await p.select({
    message: 'Edit which bot?',
    options: keys.map(k => ({ value: k, label: k, hint: `${a.bots[k]!.platform} · ${a.bots[k]!.runtime}` })),
  })) as string))
  const bot = a.bots[key]!

  type Field = 'runtime' | 'blurb'
  const fields = orCancel(await p.multiselect<Field>({
    message: `Edit ${color.cyan(key)} — pick fields to change (space to toggle; none = cancel)`,
    options: [
      { value: 'runtime', label: 'Coding agent runtime', hint: bot.runtime },
      { value: 'blurb', label: 'Blurb description', hint: bot.blurb ?? '(none)' },
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

// ─── Bot-centric bundle ("Manage a bot") ──────────────────────────────────────
// Everything about ONE bot in one place: identity (key/owner/token), the channels
// it works in (workspace + preset + collaborators per channel), and its coding-agent
// defaults. A bot is a portal — the coding agent (runtime) is a default here and is
// switchable per channel and in chat (`!config agent`), so it is de-emphasized.

/** Channels this bot is a member of, as [channelKey, Channel] pairs. */
function botChannels(a: AuthoringAccess, key: string): Array<[string, Channel]> {
  return Object.entries(a.channels).filter(([, ch]) => ch.members.some(m => m.bot === key))
}

/** A bot-scoped summary (identity + its channels + defaults), printed atop the bundle menu. */
function botBundleSummary(a: AuthoringAccess, key: string): string {
  const bot = a.bots[key]!
  const lines: string[] = []
  const tok = botFullyTokened(bot) ? color.green('● token set') : color.red('○ token missing')
  const owner = a.me?.[bot.platform] ?? color.red('(owner id not set)')
  lines.push(`${color.cyan(key)}  ${color.dim(bot.platform)}  ${tok}`)
  lines.push(`  ${color.dim('owner')}    ${owner}`)
  lines.push(`  ${color.dim('agent')}    ${bot.runtime} ${color.dim('(default · switchable per-channel & in chat)')}`)
  if (bot.blurb) lines.push(`  ${color.dim('blurb')}    ${bot.blurb}`)
  const chans = botChannels(a, key)
  lines.push(`  ${color.dim('channels')} ${chans.length === 0 ? color.dim('(none — add one below)') : ''}`)
  for (const [, ch] of chans) {
    const m = ch.members.find(x => x.bot === key)!
    const rt = m.runtime ? color.dim(` · ${m.runtime}`) : ''
    const transport = ch.meshTransport ? color.dim(' · 🔗 mesh transport') : ''
    lines.push(`    ${color.cyan(ch.label ?? `#${ch.channelId}`)}  ${color.dim(`·${m.preset ?? DEFAULT_PRESET}·`)}  ${color.dim(m.workspace)}${rt}${transport}`)
    if (ch.collaborators.length) {
      const names = ch.collaborators.map(c => {
        const r = c.kind === 'human' ? a.roster.people[c.id] : a.roster.peers[c.id]
        return (c.kind === 'human' ? '👤' : '🤖') + (r?.label ?? r?.userId ?? c.id)
      })
      lines.push(`      ${color.dim('collab:')} ${names.join(' ')}`)
    }
  }
  return lines.join('\n')
}

/** Rename a bot key (rewrites every membership reference). Returns the resulting key. */
async function renameBotFlow(a: AuthoringAccess, key: string): Promise<string> {
  const next = orCancel(await p.text({
    message: 'New bot key (lowercase letters, digits, hyphens)',
    initialValue: key,
    validate: v => {
      const e = validateBotKey(v)
      if (e) return e
      const s = (v ?? '').trim()
      if (s !== key && a.bots[s]) return 'A bot with that key already exists.'
      return undefined
    },
  })).trim()
  if (next === key) { p.log.info('Unchanged.'); return key }
  const updated = renameBot(a, key, next)
  saveAuthoringAccess(updated)
  p.log.success(`Renamed bot ${color.cyan(key)} → ${color.cyan(next)} ${color.dim(`· token env unchanged (${a.bots[key]!.tokenEnv})`)}`)
  return next
}

/** Edit the owner id for this bot's platform (the `me[platform]` shared identity). */
async function editOwnerFlow(a: AuthoringAccess, key: string): Promise<void> {
  const bot = a.bots[key]!
  const spec = PLATFORMS[bot.platform]
  const id = orCancel(await p.text({
    message: spec.ownerLabel + color.dim('  (shared by every bot on this platform)'),
    placeholder: spec.ownerPlaceholder,
    initialValue: a.me?.[bot.platform] ?? '',
    validate: spec.ownerValidate,
  })).trim()
  a.me = { ...(a.me ?? {}), [bot.platform]: id }
  saveAuthoringAccess(a)
  p.log.success(`Owner id for ${spec.label} set to ${id}`)
}

/** Add this bot to a channel (existing project or a new one); sets its workspace + preset + collaborators. */
async function addBotToChannel(a: AuthoringAccess, key: string): Promise<void> {
  const bot = a.bots[key]!
  const platform = bot.platform
  const spec = PLATFORMS[platform]
  const NEW = ' new'
  // Existing channels on this platform this bot is NOT already in, plus "+ new".
  const candidates = Object.entries(a.channels).filter(
    ([, ch]) => ch.platform === platform && !ch.members.some(m => m.bot === key),
  )
  let ck: string
  if (candidates.length > 0) {
    ck = orCancel(await p.select({
      message: `Add ${color.cyan(key)} to which channel?`,
      options: [
        ...candidates.map(([k, ch]) => ({ value: k, label: ch.label ?? `#${ch.channelId}`, hint: k })),
        { value: NEW, label: color.dim('+ a new channel') },
      ],
    })) as string
  } else {
    ck = NEW
  }

  let ch: Channel
  if (ck === NEW) {
    if (spec.idHowto) p.log.message(color.dim(spec.idHowto))
    const channelId = orCancel(await p.text({
      message: spec.idLabel,
      placeholder: spec.idPlaceholder,
      validate: spec.idValidate,
    })).trim()
    ck = channelKey(platform, channelId)
    ch = a.channels[ck] ?? { platform, channelId, members: [], collaborators: [] }
    if (!ch.label) {
      const label = orCancel(await p.text({
        message: 'Friendly project name for this channel (optional)',
        placeholder: '#infra-prod',
      })).trim()
      if (label) ch.label = label
    }
  } else {
    ch = a.channels[ck]!
  }

  await ensureMe(a, spec)
  const workspace = orCancel(await p.text({
    message: `Workspace folder for ${key} in this channel (absolute)`,
    placeholder: process.cwd(),
    initialValue: process.cwd(),
    validate: validateAbsPath,
  })).trim()
  if (!existsSync(workspace)) p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
  const preset = await pickPreset()
  ch.members.push({ bot: key, workspace, preset, profile: profileFromPreset(preset) })

  await pickCollaborators(a, platform, ch)
  ch.requireMention = orCancel(await p.confirm({
    message: 'Require an @mention before a bot responds here?',
    initialValue: ch.requireMention ?? true,
  }))

  a.channels[ck] = ch
  saveAuthoringAccess(a)
  p.log.success(`Added ${color.cyan(key)} to ${color.cyan(ch.label ?? `#${ch.channelId}`)}`)
  if (spec.notes.length) p.log.info(spec.notes.join('\n'))
}

/** Remove this bot from one of its channels (drops just its membership; offers to delete an emptied channel). */
async function removeBotFromChannel(a: AuthoringAccess, key: string): Promise<void> {
  const chans = botChannels(a, key)
  if (chans.length === 0) { p.log.info('This bot is not in any channel.'); return }
  const ck = orCancel(await p.select({
    message: `Remove ${color.cyan(key)} from which channel?`,
    options: chans.map(([k, ch]) => ({ value: k, label: ch.label ?? `#${ch.channelId}`, hint: k })),
  })) as string
  const ch = a.channels[ck]!
  ch.members = ch.members.filter(m => m.bot !== key)
  if (ch.members.length === 0) {
    const drop = orCancel(await p.confirm({
      message: `${ch.label ?? `#${ch.channelId}`} now has no member bots — remove the channel entirely?`,
      initialValue: true,
    }))
    if (drop) delete a.channels[ck]
  }
  saveAuthoringAccess(a)
  p.log.success(`Removed ${color.cyan(key)} from ${ch.label ?? `#${ch.channelId}`}`)
}

/** Edit this bot's per-channel workspace (and optionally its preset). */
async function editBotChannel(a: AuthoringAccess, key: string): Promise<void> {
  const chans = botChannels(a, key)
  if (chans.length === 0) { p.log.info('This bot is not in any channel — add it to one first.'); return }
  const ck = chans.length === 1 ? chans[0]![0] : (orCancel(await p.select({
    message: 'Edit this bot in which channel?',
    options: chans.map(([k, ch]) => ({ value: k, label: ch.label ?? `#${ch.channelId}`, hint: k })),
  })) as string)
  const ch = a.channels[ck]!
  const m = ch.members.find(x => x.bot === key)!
  const workspace = orCancel(await p.text({
    message: `Workspace folder for ${key} in ${ch.label ?? `#${ch.channelId}`} (absolute)`,
    placeholder: process.cwd(),
    initialValue: m.workspace,
    validate: validateAbsPath,
  })).trim()
  if (!existsSync(workspace)) p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
  m.workspace = workspace
  const preset = await pickPreset(m.preset ?? DEFAULT_PRESET)
  m.preset = preset
  m.profile = profileFromPreset(preset)
  saveAuthoringAccess(a)
  p.log.success(`Updated ${color.cyan(key)} in ${ch.label ?? `#${ch.channelId}`}`)
}

/** The bot-centric bundle: pick a bot (or add one), then edit everything about it in one place. */
async function manageBot(a: AuthoringAccess): Promise<void> {
  const keys = Object.keys(a.bots)
  const ADD = ' add'
  let key: string
  if (keys.length === 0) {
    const added = await addBot(a)
    if (!added) return
    key = added
  } else {
    const picked = orCancel(await p.select({
      message: 'Manage which bot?',
      options: [
        ...keys.map(k => ({ value: k, label: k, hint: `${a.bots[k]!.platform} · ${botChannels(a, k).length} channel(s)` })),
        { value: ADD, label: color.dim('+ add a new bot') },
      ],
    })) as string
    if (picked === ADD) {
      const added = await addBot(a)
      if (!added) return
      key = added
    } else {
      key = picked
    }
  }

  // Bundle loop — re-read from disk each pass so the summary reflects prior edits.
  let running = true
  while (running) {
    a = readAuthoringAccess()
    if (!a.bots[key]) { p.log.info('Bot no longer exists.'); return }
    p.note(botBundleSummary(a, key), `Bot · ${key}`)
    type Act = 'channel-add' | 'channel-edit' | 'channel-remove' | 'token' | 'owner' | 'rename' | 'defaults' | 'remove' | 'done'
    const act = orCancel(await p.select<Act>({
      message: `What about ${color.cyan(key)}?`,
      options: [
        { value: 'channel-add', label: 'Add to a channel', hint: 'project: workspace + preset + collaborators' },
        { value: 'channel-edit', label: 'Edit a channel', hint: 'workspace / preset / collaborators' },
        { value: 'channel-remove', label: 'Remove from a channel' },
        { value: 'token', label: 'Save / update token' },
        { value: 'owner', label: 'Edit owner id', hint: 'your user id on this platform' },
        { value: 'rename', label: 'Rename bot key' },
        { value: 'defaults', label: 'Coding-agent defaults', hint: 'default agent / blurb' },
        { value: 'remove', label: color.red('Remove this bot') },
        { value: 'done', label: color.dim('← back') },
      ],
    }))
    a = readAuthoringAccess()
    if (act === 'channel-add') await addBotToChannel(a, key)
    else if (act === 'channel-edit') await editBotChannel(a, key)
    else if (act === 'channel-remove') await removeBotFromChannel(a, key)
    else if (act === 'token') await saveBotToken(a, key)
    else if (act === 'owner') await editOwnerFlow(a, key)
    else if (act === 'rename') key = await renameBotFlow(a, key)
    else if (act === 'defaults') await editBot(a, key)
    else if (act === 'remove') {
      const confirm = orCancel(await p.confirm({ message: `Remove bot ${key}? (drops it from every channel)`, initialValue: false }))
      if (confirm) {
        delete a.bots[key]
        for (const ch of Object.values(a.channels)) ch.members = ch.members.filter(m => m.bot !== key)
        saveAuthoringAccess(a)
        p.log.success(`Removed bot ${key}`)
        return
      }
    } else {
      running = false
    }
  }
}

// ─── Tokens ─────────────────────────────────────────────────────────────────────

async function saveBotToken(a: AuthoringAccess, botKey?: string): Promise<void> {
  const keys = Object.keys(a.bots)
  if (keys.length === 0) { p.log.error('Add a bot first.'); return }
  const key = botKey ?? (keys.length === 1 ? keys[0]! : (orCancel(await p.select({
    message: 'Save a token for which bot?',
    options: keys.map(k => ({ value: k, label: k, hint: botFullyTokened(a.bots[k]!) ? '✓ set' : '✗ missing' })),
  })) as string))
  const bot = a.bots[key]!
  const spec = PLATFORMS[bot.platform]
  p.log.message(color.dim(`Get it from: ${spec.tokenHowto}`))
  const token = orCancel(await p.password({ message: `Bot token for ${color.cyan(key)} (${bot.tokenEnv})`, validate: required })).trim()
  setToken(bot.tokenEnv, token)
  p.log.success(`Saved to .env as ${bot.tokenEnv} ${color.dim(`· ***${token.slice(-4)}`)}`)

  // Extra secrets (e.g. Slack's app-level token), keyed by logical name in secretEnv.
  // Only those the bot actually declared in secretEnv are prompted; an `optional`
  // secret may be left blank (skipped) — e.g. a webhook secret/verification token.
  for (const s of spec.secrets) {
    const envName = bot.secretEnv?.[s.name]
    if (!envName) continue
    p.log.message(color.dim(`Get it from: ${s.howto}`))
    const val = orCancel(
      await p.password({ message: `${s.label} (${envName})`, validate: s.optional ? undefined : required }),
    ).trim()
    if (!val && s.optional) {
      p.log.info(`Skipped ${envName} (optional).`)
      continue
    }
    setToken(envName, val)
    p.log.success(`Saved to .env as ${envName} ${color.dim(`· ***${val.slice(-4)}`)}`)
  }
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
    const mark = botFullyTokened(bot) ? color.green('●') : color.red('○')
    const name = bot.displayName ?? color.dim('(name from platform on connect)')
    lines.push(`  ${mark} ${color.cyan(key)}  ${name}  ${color.dim(bot.platform)}  ${color.dim(bot.runtime)}`)
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
      if (isTokenSet(k.envVar)) {
        lines.push(`  ${color.dim(k.runtime.padEnd(11))} ${k.envVar} ${color.green('✓')}`)
      } else if (RUNTIME_AUTH[k.runtime]?.optional) {
        const alt = hasAlternateAuth(k.runtime)
        if (alt) {
          lines.push(`  ${color.dim(k.runtime.padEnd(11))} ${color.green(alt)}`)
        } else {
          lines.push(`  ${color.dim(k.runtime.padEnd(11))} ${k.envVar} ${color.red('✗ missing')}  ${color.dim(RUNTIME_AUTH[k.runtime]!.hint)}`)
        }
      } else {
        lines.push(`  ${color.dim(k.runtime.padEnd(11))} ${k.envVar} ${color.red('✗ missing')}`)
      }
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
  const noToken = Object.entries(a.bots).filter(([, b]) => !botFullyTokened(b)).map(([k]) => k)
  const memberOf = new Set(Object.values(a.channels).flatMap(c => c.members.map(m => m.bot)))
  const noChannel = Object.keys(a.bots).filter(k => !memberOf.has(k))
  if (noToken.length) tips.push(`${color.yellow('!')} Token missing for ${noToken.join(', ')} — run setup → "Manage a bot" → Save / update token`)
  if (noChannel.length) tips.push(`${color.yellow('!')} ${noChannel.join(', ')} isn't a member of any channel — add it to one`)
  const noKey = runtimeKeysInUse(a).filter(k => {
    if (isTokenSet(k.envVar)) return false
    if (RUNTIME_AUTH[k.runtime]?.optional && hasAlternateAuth(k.runtime)) return false
    return true
  })
  if (noKey.length) tips.push(`${color.yellow('!')} Auth missing: ${noKey.map(k => k.envVar).join(', ')} — run setup → "Save a coding-agent API key"${noKey.some(k => RUNTIME_AUTH[k.runtime]?.optional) ? ' (or use the agent\'s own login)' : ''}`)
  tips.push(`${color.green('→')} Start the relay: ${color.cyan('bun relay.ts')} ${color.dim('(prints who listens where)')}`)
  tips.push(`${color.green('→')} Tune a thread in-chat (owner): ${color.cyan('!config role <text>')} — ${color.cyan('!config help')}`)
  p.note(tips.join('\n'), 'Next steps')
  p.outro(color.green('All done.'))
}

// ─── Resolver-driven onboarding (auto-configure; coexists with the wizard) ─────
// Connects the bot, discovers what it can see, and fills each gap by the cheapest legal rung —
// auto-derive (silent) → pick-list → guided manual / nonce. Nothing is auto-trusted: every
// discovered identity is shown claimed/unverified and confirmed in the terminal before it is
// written to access.json (R8/R9). The pure decision logic lives in lib.ts; this is the @clack glue.

/** Ensure `channelId` exists as a channel with `botKey` as a member (prompting for a workspace on a
 *  new membership). Returns the channelKey. Mutates + saves `a`. */
async function ensureChannelMembership(a: AuthoringAccess, botKey: string, platform: Platform, channelId: string): Promise<string> {
  const ck = channelKey(platform, channelId)
  const ch: Channel = a.channels[ck] ?? { platform, channelId, members: [], collaborators: [] }
  if (!ch.members.some(m => m.bot === botKey)) {
    const workspace = orCancel(await p.text({
      message: `Workspace folder for ${botKey} in this channel (absolute)`,
      placeholder: process.cwd(),
      initialValue: process.cwd(),
      validate: validateAbsPath,
    })).trim()
    if (!existsSync(workspace)) p.log.warn(`${workspace} doesn't exist yet — create it before launching the relay.`)
    const preset = await pickPreset(DEFAULT_PRESET)
    ch.members.push({ bot: botKey, workspace, preset, profile: profileFromPreset(preset) })
  }
  a.channels[ck] = ch
  saveAuthoringAccess(a)
  return ck
}

/** Owner-ID nonce capture (R22): print a single-use phrase, listen on the live channel for a
 *  message whose text matches it within a short window, and return the raw immutable userId of the
 *  single matching sender. 2+ matches abort (re-issue); none → undefined (caller falls to manual). */
async function captureOwnerViaNonce(adapter: MessagingAdapter, channelId: string, windowMs = 120_000): Promise<string | undefined> {
  const nonce = makeNonce()
  const seen: Array<{ userId: string; text: string }> = []
  adapter.onMessage(m => {
    if (m.scope === channelId || m.scope.startsWith(channelId)) seen.push({ userId: m.authorId, text: m.text })
  })
  p.log.message(
    `In ${color.cyan(`#${channelId}`)}, send EXACTLY this phrase from your own account:\n\n   ${color.bgBlack(color.white(` ${nonce} `))}\n\n` +
      color.dim('(captures your owner user-id with no opaque id to copy — proceeds the moment you send it)'),
  )
  const s = p.spinner()
  s.start('Waiting for your message… (Ctrl-C to skip)')
  // Poll so we proceed the INSTANT a match arrives, rather than blocking the whole window.
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const result = nonceMatch(seen, nonce)
    if (result.kind === 'matched') { s.stop('Captured your message.'); return result.userId }
    if (result.kind === 'multiple') {
      s.stop('Aborted.')
      p.log.warn('More than one message matched the phrase — aborting capture. Re-run to get a fresh phrase.')
      return undefined
    }
  }
  s.stop('Capture window closed.')
  p.log.warn('No message matched the phrase in time.')
  return undefined
}

/** Confirm a single discovered (claimed/unverified) peer into the roster — with sanitized framing,
 *  a live collision re-check (R25), and the trust-consequence text supplied by knock-knock (R26).
 *  Returns the mutated authoring (peer written) or the input unchanged on decline. */
async function confirmDiscoveredPeer(a: AuthoringAccess, prop: Proposal): Promise<AuthoringAccess> {
  const collision = prop.claimed.agentKey && prop.claimed.userId
    ? detectCollision({ agentKey: prop.claimed.agentKey, userId: prop.claimed.userId }, confirmedIdentitiesFor(a, prop.platform))
    : undefined
  const header = collision
    ? color.red(`⚠ CONFLICT: this user-id is already your ${collision.kind}. Confirming would let a different key act as them.`)
    : color.yellow('This identity is CLAIMED by the peer and is NOT cryptographically verified.')
  p.log.message(`${header}\n  ${renderClaimedPeer(prop.claimed)}`)
  const ok = orCancel(await p.confirm({
    message: collision ? 'Confirm anyway? (you are overriding a flagged conflict)' : 'Add this peer as an addressable collaborator?',
    initialValue: false, // careful default: declined / conflict defaults to no
  }))
  if (!ok) {
    const t = tombstoneForProposal(prop, new Date().toISOString())
    if (t) addTombstone(t) // a decline is durable: don't re-surface this pair on cosmetic churn
    return a
  }
  // Slug against the roster map this kind actually writes into (peers vs people), so the
  // uniqueness check can't collide with the wrong map.
  const taken = new Set(Object.keys(prop.kind === 'collaborator' ? a.roster.people : a.roster.peers))
  const id = slugify(prop.claimed.label || prop.targetId, taken)
  const next = applyConfirmedProposal(a, prop, id)
  saveAuthoringAccess(next)
  p.log.success(`Confirmed ${prop.kind === 'collaborator' ? 'collaborator' : 'peer'} ${color.cyan(prop.claimed.label ?? prop.targetId)}.`)
  return next
}

/** Auto-configure one (bot, channel): connect, discover, and fill each gap by its rung. */
async function resolveAndFill(a: AuthoringAccess): Promise<void> {
  const botKeys = Object.keys(a.bots)
  if (botKeys.length === 0) { p.log.error('Add a bot first.'); return }
  const botKey = botKeys.length === 1 ? botKeys[0]! : (orCancel(await p.select({ message: 'Auto-configure which bot?', options: botKeys.map(k => ({ value: k, label: k })) })) as string)
  const bot = a.bots[botKey]!
  if (!botFullyTokened(bot)) { p.log.error(`Save ${botKey}'s token first (Manage a bot → token).`); return }
  const platform = bot.platform

  const spin = p.spinner()
  spin.start('Connecting to discover what this bot can see…')
  const adapter = await connectDiscoveryAdapter(bot, process.env as Record<string, string | undefined>)
  if (!adapter) { spin.stop(color.red('Could not connect — check the token.')); return }
  spin.stop('Connected.')

  try {
    // Self-ID is auto-derived from the token, never prompted (R5). Cache it as the bot's
    // displayName so the resolver counts it as met thereafter.
    const self = adapter.botLabel ?? adapter.botUserId
    if (self && !bot.displayName) {
      bot.displayName = self
      a.bots[botKey] = bot
      saveAuthoringAccess(a)
      p.log.info(`Self-ID derived: ${color.cyan(self)} (never typed by you).`)
    }

    // Channel binding: pick from the enumerated list where capable, else enter manually.
    const pre = await assembleSnapshot({ platform, adapter })
    const chans = itemsOf(pre.channels)
    let channelId: string
    if (chans.length > 0) {
      const ENTER = ' enter'
      const picked = orCancel(await p.select({
        message: 'Which channel should this bot work in?',
        options: [...chans.map(c => ({ value: c.id, label: c.label, hint: c.id })), { value: ENTER, label: color.dim('+ enter a channel id manually') }],
      })) as string
      channelId = picked === ENTER ? orCancel(await p.text({ message: PLATFORMS[platform].idLabel, validate: PLATFORMS[platform].idValidate })).trim() : picked
    } else {
      if (pre.channels.kind === 'degraded') p.log.warn(`Channel list unavailable (${pre.channels.reason}); enter the id manually.`)
      channelId = orCancel(await p.text({ message: PLATFORMS[platform].idLabel, validate: PLATFORMS[platform].idValidate })).trim()
    }
    const ck = await ensureChannelMembership(a, botKey, platform, channelId)
    a = readAuthoringAccess()

    // Re-assemble with the chosen channel so member enumeration + directory peers are in scope.
    // Bounded by the assembler's timeout, so a platform that can't list members (e.g. Discord
    // without the Server Members Intent) degrades to nonce capture instead of hanging.
    const disco = p.spinner()
    disco.start('Discovering members…')
    const snapshot = await assembleSnapshot({ platform, adapter, channelId, transportConfigured: Object.values(a.channels).some(c => c.platform === platform && c.meshTransport) })
    disco.stop(snapshot.members.kind === 'results' ? `Found ${snapshot.members.items.length} member(s).` : 'Member list unavailable — will use guided capture.')
    const crossMachinePeer = snapshot.directoryPeers.length > 0
    const needs: Need[] = resolveGaps({ authoring: a, botKey, channelKey: ck, snapshot, crossMachinePeer })

    for (const need of needs) {
      if (need.kind === 'self-id') continue // already cached above
      if (need.kind === 'collaborators') {
        if (need.rung === 'pick' && need.options?.length) {
          const picks = orCancel(await p.multiselect({
            message: 'Collaborators in this channel (humans who may drive this bot)',
            options: need.options.filter(o => o.id !== adapter.botUserId).map(o => ({ value: o.id, label: o.label, hint: o.id })),
            required: false,
          })) as string[]
          for (const userId of picks) {
            const label = need.options.find(o => o.id === userId)?.label
            const id = slugify(label || userId, new Set(Object.keys(a.roster.people)))
            a = applyConfirmedProposal(a, { kind: 'collaborator', platform, channelKey: ck, targetId: userId, claimed: { userId, ...(label ? { label } : {}) }, discoveredAt: new Date().toISOString(), status: 'confirmed' }, id)
            saveAuthoringAccess(a)
          }
        } else {
          p.log.info(`Collaborator pick unavailable${need.reason ? ` (${need.reason})` : ''} — add people later via "Add a person to the roster."`)
        }
      } else if (need.kind === 'owner-id') {
        let ownerId: string | undefined
        if (need.rung === 'pick' && need.options?.length) {
          ownerId = orCancel(await p.select({
            message: 'Which of these is YOU (the owner)?',
            options: need.options.map(o => ({ value: o.id, label: o.label, hint: o.id })),
          })) as string
        } else {
          p.log.info(`Owner pick unavailable${need.reason ? ` (${need.reason})` : ''} — capturing via a one-time phrase instead.`)
          ownerId = await captureOwnerViaNonce(adapter, channelId)
        }
        if (ownerId) {
          // Show the raw immutable id for a final confirm before writing (R22).
          const ok = orCancel(await p.confirm({ message: `Set owner user-id to ${color.cyan(ownerId)}?`, initialValue: true }))
          if (ok) { a = applyConfirmedProposal(a, { kind: 'owner', platform, targetId: ownerId, claimed: { userId: ownerId }, discoveredAt: new Date().toISOString(), status: 'confirmed' }); saveAuthoringAccess(a) }
        }
      } else if (need.kind === 'transport') {
        await offerTransport(a, platform, adapter, need)
        a = readAuthoringAccess()
      }
    }

    // Cross-machine peers discovered in the directory are claimed/unverified — confirm each
    // explicitly (they are addressable but not auto-heard until confirmed, per the U7 gate).
    for (const peer of snapshot.directoryPeers) {
      if (!peer.userId) continue
      if (Object.values(a.roster.peers).some(x => x.platform === platform && x.userId === peer.userId)) continue
      const prop: Proposal = { kind: 'peer', platform, channelKey: ck, targetId: peer.userId, claimed: { agentKey: peer.agentKey, userId: peer.userId, ...(peer.label ? { label: peer.label } : {}), ...(peer.blurb ? { blurb: peer.blurb } : {}) }, discoveredAt: new Date().toISOString(), status: 'proposed' }
      // Drift is moot here (this IS the live directory), but a collision re-check still applies.
      a = await confirmDiscoveredPeer(a, prop)
    }

    p.log.success(`${color.cyan(botKey)} is configured for ${color.cyan(`#${channelId}`)}.`)
  } finally {
    await adapter.disconnect().catch(() => {})
  }
}

/** Offer to create (where capable) or designate a dedicated mesh-transport channel just-in-time —
 *  before any ⟦kk-mesh⟧ line would post to a human channel (R18/R19/AE5). */
async function offerTransport(a: AuthoringAccess, platform: Platform, adapter: MessagingAdapter, need: Need): Promise<void> {
  p.log.message(color.yellow('A cross-machine peer was discovered, but no transport channel is configured.\n') +
    color.dim('Without one, ⟦kk-mesh⟧ coordination traffic posts to your human rooms.'))
  const create = (adapter as { createChannel?: (n: string) => Promise<unknown> }).createChannel
  if (need.rung === 'pick' && create) {
    const make = orCancel(await p.confirm({ message: 'Create a dedicated transport channel now?', initialValue: true }))
    if (make) {
      const name = orCancel(await p.text({ message: 'Name for the transport channel', placeholder: 'kk-mesh', initialValue: 'kk-mesh' })).trim()
      const res = (await create(name)) as { kind: string; items?: Array<{ id: string }>; reason?: string }
      if (res.kind === 'results' && res.items?.[0]) {
        const ck = channelKey(platform, res.items[0].id)
        a.channels[ck] = a.channels[ck] ?? { platform, channelId: res.items[0].id, members: [], collaborators: [] }
        a.channels[ck]!.meshTransport = true
        saveAuthoringAccess(a)
        p.log.success(`Created transport channel ${color.cyan(name)}. Add the SAME channel id on every machine, then restart the relay.`)
        return
      }
      p.log.warn(`Could not create the channel${res.reason ? ` (${res.reason})` : ''} — designate one instead.`)
    }
  }
  const id = orCancel(await p.text({ message: 'Channel id to DESIGNATE as mesh transport (a new, empty channel)', validate: PLATFORMS[platform].idValidate })).trim()
  const ck = channelKey(platform, id)
  a.channels[ck] = a.channels[ck] ?? { platform, channelId: id, members: [], collaborators: [] }
  a.channels[ck]!.meshTransport = true
  saveAuthoringAccess(a)
  p.log.success(`Designated ${color.cyan(`#${id}`)} as mesh transport. Add the SAME channel on every machine, then restart the relay.`)
}

/** Confirm (or decline) the proposals the relay discovered into pending.json (F4/F5 surface). This
 *  is the confirm surface `kk doctor` points at. Re-checks collisions against the live access.json
 *  at confirm time (R25); declines are tombstoned by pair (R20). */
async function confirmPendingDiscoveries(a: AuthoringAccess): Promise<void> {
  const store = readPending()
  const open = store.proposals.filter(pr => pr.status === 'proposed')
  if (open.length === 0) { p.log.info('No pending discoveries awaiting confirmation.'); return }
  p.log.info(`${open.length} pending discover${open.length === 1 ? 'y' : 'ies'} from the relay.`)
  for (const prop of open) {
    if (prop.kind === 'peer' || prop.kind === 'collaborator') {
      a = await confirmDiscoveredPeer(a, prop)
    } else if (prop.kind === 'transport') {
      // A relay transport proposal carries the platform (targetId) but no channel yet — the owner
      // designates one now, before ⟦kk-mesh⟧ traffic would post to a human room (R19/AE5).
      const platform = prop.platform
      p.log.message(color.yellow('A cross-machine peer is configured but no transport channel exists.\n') +
        color.dim('⟦kk-mesh⟧ coordination traffic is posting to your human rooms until you set one.'))
      const designate = orCancel(await p.confirm({ message: 'Designate a dedicated mesh-transport channel now?', initialValue: true }))
      if (designate) {
        const id = orCancel(await p.text({ message: 'Channel id to use as transport (a new, empty channel)', validate: PLATFORMS[platform].idValidate })).trim()
        const ck = channelKey(platform, id)
        a.channels[ck] = a.channels[ck] ?? { platform, channelId: id, members: [], collaborators: [] }
        a.channels[ck]!.meshTransport = true
        saveAuthoringAccess(a)
        p.log.success(`Designated ${color.cyan(`#${id}`)} as mesh transport. Add the SAME channel on every machine, then restart the relay.`)
      }
    }
  }
  // Drop only the proposals we just handled, matching by identity (kind+targetId+channelKey) — and
  // RE-READ pending first, so any proposal the relay appended while the owner was answering prompts
  // is preserved rather than clobbered (the relay is the sole writer, but this terminal write must
  // not lose its concurrent appends). The relay also re-reconciles on its next pass.
  const handledKey = (pr: Proposal): string => `${pr.kind} ${pr.targetId} ${pr.channelKey ?? ''}`
  const handled = new Set(open.map(handledKey))
  const fresh = readPending()
  writePending({ ...fresh, proposals: fresh.proposals.filter(pr => !handled.has(handledKey(pr))) })
  p.log.success('Pending discoveries resolved.')
}

// ─── Main flows ───────────────────────────────────────────────────────────────

/** Guided first-run: bot → token → auto-configure (discover the channel/collaborators/owner-ID and
 *  fill the gaps) → ledger. The token is saved BEFORE auto-configure so the resolver can connect and
 *  enumerate; the manual channel flow remains the fallback when the user declines or it's offline. */
async function firstRunWizard(): Promise<void> {
  p.log.info("Let's set up your first bot, then auto-configure it from what it can see.")
  let a = readAuthoringAccess()
  const key = await addBot(a)
  if (!key) { finishWithNextSteps(readAuthoringAccess()); return }

  const addTok = orCancel(await p.confirm({ message: 'Save the bot token now? (needed to auto-discover channels & members)', initialValue: true }))
  if (addTok) await saveBotToken(readAuthoringAccess(), key)

  a = readAuthoringAccess()
  if (botFullyTokened(a.bots[key]!)) {
    const auto = orCancel(await p.confirm({ message: 'Auto-configure now? (discover the channel, collaborators, and your owner-ID — no IDs typed by hand)', initialValue: true }))
    if (auto) { await resolveAndFill(readAuthoringAccess()); a = readAuthoringAccess() }
    else {
      const addCh = orCancel(await p.confirm({ message: 'Add a channel manually instead?', initialValue: true }))
      if (addCh) { await addChannel(a); a = readAuthoringAccess() }
    }
  } else {
    p.log.warn('No token saved — skipping auto-configure. Add a channel manually:')
    const addCh = orCancel(await p.confirm({ message: 'Add a channel now?', initialValue: true }))
    if (addCh) { await addChannel(readAuthoringAccess()) }
  }

  const setLedger = orCancel(await p.confirm({ message: 'Set up the shared ledger now? (Postgres for collaboration)', initialValue: true }))
  if (setLedger) await collectLedger()

  finishWithNextSteps(readAuthoringAccess())
}

/** Action menu for existing setups. */
async function interactiveMenu(): Promise<void> {
  p.note(statusReport(readAuthoringAccess()), 'Current setup')

  const TASK_ORDER = ['resolve', 'confirm', 'bot', 'channel', 'channel-remove', 'person', 'peer', 'roster-remove', 'api-key', 'ledger'] as const
  type Task = typeof TASK_ORDER[number]

  let running = true
  while (running) {
    const pendingCount = readPending().proposals.filter(pr => pr.status === 'proposed').length
    const tasks = orCancel(await p.multiselect<Task>({
      message: 'What would you like to do? (space to toggle, enter to run — nothing selected = done)',
      options: [
        { value: 'resolve', label: 'Auto-configure a bot', hint: 'discover channels/members & fill the gaps — no IDs typed by hand' },
        ...(pendingCount > 0 ? [{ value: 'confirm' as Task, label: `Confirm ${pendingCount} pending discover${pendingCount === 1 ? 'y' : 'ies'}`, hint: 'peers/transport the relay found, awaiting your OK' }] : []),
        { value: 'bot', label: 'Manage a bot', hint: 'identity · token · channels · agent — all in one place' },
        { value: 'channel', label: 'Add / edit a channel', hint: 'project: members + workspaces + collaborators' },
        { value: 'channel-remove', label: 'Remove a channel' },
        { value: 'person', label: 'Add a person to the roster' },
        { value: 'peer', label: 'Add a peer bot to the roster' },
        { value: 'roster-remove', label: 'Remove a roster entry', hint: 'person or peer (drops it from channels too)' },
        { value: 'api-key', label: 'Save / update a coding-agent API key', hint: 'e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY' },
        { value: 'ledger', label: 'Choose ledger backend', hint: 'local SQLite or remote Postgres' },
      ],
      required: false,
    }))
    if (tasks.length === 0) { running = false; break }

    const sorted = [...tasks].sort((x, y) => TASK_ORDER.indexOf(x) - TASK_ORDER.indexOf(y))
    for (const task of sorted) {
      const a = readAuthoringAccess()
      if (task === 'resolve') await resolveAndFill(a)
      else if (task === 'confirm') await confirmPendingDiscoveries(a)
      else if (task === 'bot') await manageBot(a)
      else if (task === 'channel') await addChannel(a)
      else if (task === 'channel-remove') await removeChannel(a)
      else if (task === 'person') await addPerson(a, await pickRosterPlatform(a))
      else if (task === 'peer') await addPeer(a, await pickRosterPlatform(a), true)
      else if (task === 'roster-remove') await removeRosterEntry(a)
      else if (task === 'api-key') await saveCodingAgentKey(a)
      else if (task === 'ledger') await collectLedger()
    }
    p.note(statusReport(readAuthoringAccess()), 'Current setup')
  }
  finishWithNextSteps(readAuthoringAccess())
}

/** The platform a new roster entry is on — inferred from the bots, or asked. */
async function pickRosterPlatform(a: AuthoringAccess): Promise<Platform> {
  const platforms = [...new Set(Object.values(a.bots).map(b => b.platform))]
  if (platforms.length <= 1) return platforms[0] ?? 'discord'
  return orCancel(await p.select({
    message: 'This roster entry is on which platform?',
    options: platforms.map(pl => ({ value: pl, label: PLATFORMS[pl].label })),
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
