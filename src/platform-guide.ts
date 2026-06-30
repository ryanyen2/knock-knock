/**
 * Per-platform onboarding guidance — pure DATA (types + the PLATFORM_GUIDE / RUNTIMES tables),
 * lifted out of lib.ts so the "pure decision logic" core isn't carrying ~170 lines of @clack-shaped
 * howto prose. Shared by the terminal wizard and the settings web UI so the "where do I get this"
 * copy lives in exactly one place and can't drift between the two surfaces. No functions with side
 * effects, no I/O — the settings server can import it (it must never import setup.ts, which runs its
 * wizard on import).
 */

import type { Platform } from './lib.ts'

/** An extra secret a platform needs beyond the primary token (e.g. Slack's app token). */
export type SecretGuide = {
  name: string // logical name → bot.secretEnv key
  envBase: string // base env-var NAME
  label: string
  howto: string
  optional?: boolean
  whenWebhook?: boolean // only collected when the bot uses webhook intake
}

/** Everything the user needs to set a platform up, minus the (function) validators. */
export type PlatformGuide = {
  value: Platform
  label: string
  hint: string
  tokenEnvBase: string // base env-var NAME for the primary token
  tokenHowto: string // where to get the primary token
  tokenUrl?: string // clickable starting point for the token
  setupSteps: string[] // ordered, plain-language steps to create the app + grab the token/id
  secrets: SecretGuide[]
  idLabel: string
  idHowto?: string // optional multi-line "how to find this id" help
  idPlaceholder: string
  ownerLabel: string
  ownerPlaceholder: string
  memberIdLabel: string
  notes: string[] // post-setup reminders
  supportsWebhook?: boolean
  webhookNotes?: string[]
}

/** The secrets a poll-mode bot must carry, beyond its primary token — i.e. every non-webhook
 *  secret (Slack's app-level token; nothing for Discord/Telegram; GitHub/Notion's webhook
 *  secrets are excluded because they only matter for webhook intake). Both the terminal wizard
 *  and the web UI wire exactly these into a new bot's `secretEnv`, and the dashboard's
 *  readiness check consults them — so a Slack bot is never silently born without its app token. */
export function pollModeSecrets(guide: PlatformGuide): SecretGuide[] {
  return guide.secrets.filter(s => !s.whenWebhook)
}

/** Coding-agent runtimes a bot can be driven by. Shared by the wizard and the web UI so the
 *  dropdown can't drift; the relay branches on `value`, never the label. */
export const RUNTIMES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'claude-sdk', label: 'Claude Code', hint: 'in-process SDK · no install · local login or API key' },
  { value: 'codex', label: 'OpenAI Codex', hint: 'via ACP (npx) · ChatGPT login or OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', hint: 'via ACP · run opencode → /connect to configure auth' },
  { value: 'gemini', label: 'Gemini CLI', hint: 'via ACP · Google account login or GEMINI_API_KEY' },
  { value: 'claude-acp', label: 'Claude Code (ACP)', hint: 'via ACP (npx) · local login or API key' },
  { value: 'acp', label: 'Other ACP agent', hint: 'set KNOCK_KNOCK_ACP_COMMAND yourself' },
]

export const PLATFORM_GUIDE: Record<Platform, PlatformGuide> = {
  discord: {
    value: 'discord', label: 'Discord', hint: 'full-fidelity · gateway WebSocket',
    tokenEnvBase: 'DISCORD_BOT_TOKEN',
    tokenHowto: 'discord.com/developers → your app → Bot → Reset Token',
    tokenUrl: 'https://discord.com/developers/applications',
    setupSteps: [
      'Create the app: discord.com/developers → New Application → name it.',
      'Bot tab → Reset Token → copy it (shown once). That is your DISCORD_BOT_TOKEN.',
      'Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT (else the bot reads empty text).',
      'OAuth2 → URL Generator → scope "bot" → permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Manage Messages → open the URL as the server owner.',
      'Settings → Advanced → Developer Mode on, then right-click the channel → Copy Channel ID.',
    ],
    secrets: [],
    idLabel: 'Channel ID (right-click channel → Copy Channel ID)',
    idPlaceholder: '846209781206941736',
    ownerLabel: 'Your Discord user ID (you own these bots — approval prompts ping you)',
    ownerPlaceholder: '184695080709324800',
    memberIdLabel: 'Their Discord user ID',
    notes: [],
  },
  slack: {
    value: 'slack', label: 'Slack', hint: 'full-fidelity · Socket Mode',
    tokenEnvBase: 'SLACK_BOT_TOKEN',
    tokenHowto: 'api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-)',
    tokenUrl: 'https://api.slack.com/apps',
    setupSteps: [
      'api.slack.com/apps → Create New App → From an app manifest (sets every scope, event, interactivity, and Socket Mode in one paste).',
      'Basic Information → App-Level Tokens → Generate, add scope connections:write → that is SLACK_APP_TOKEN (xapp-).',
      'OAuth & Permissions → Install to Workspace → that is SLACK_BOT_TOKEN (xoxb-).',
      'Invite the bot to each channel: /invite @yourbot. Channel ID: channel name → View details → Copy Channel ID (C…).',
    ],
    secrets: [{
      name: 'appToken', envBase: 'SLACK_APP_TOKEN', label: 'Slack app-level token (xapp-)',
      howto: 'api.slack.com/apps → Basic Information → App-Level Tokens → scope connections:write',
    }],
    idLabel: 'Slack channel ID (channel name → About → Channel ID)',
    idPlaceholder: 'C0123ABCD',
    ownerLabel: 'Your Slack member ID (avatar → Profile → ⋯ → Copy member ID)',
    ownerPlaceholder: 'U0123ABCD',
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
    tokenUrl: 'https://t.me/BotFather',
    setupSteps: [
      'DM @BotFather → /newbot → copy the token. That is your TELEGRAM_BOT_TOKEN.',
      'BotFather → /mybots → Bot Settings → Group Privacy → Turn off (else the bot only sees @mentions).',
      'Make the bot a group admin (for reactions). /start your bot yourself so approval DMs reach you.',
      'Chat ID: @userinfobot or getUpdates — groups are negative, supergroups start with -100.',
    ],
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
    ownerLabel: 'Your Telegram user ID (DM @userinfobot)',
    ownerPlaceholder: '184695080',
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
    tokenUrl: 'https://github.com/settings/tokens',
    setupSteps: [
      'Create a dedicated machine-user account to act as the bot.',
      'github.com/settings/tokens → PAT with scopes repo + notifications → that is GITHUB_BOT_TOKEN.',
      'Add the machine-user as a collaborator/member of the repo so @mentions notify it.',
      'Channel id is the repo: owner/repo (each issue/PR scope is derived automatically).',
    ],
    secrets: [{
      name: 'webhookSecret', envBase: 'GITHUB_WEBHOOK_SECRET',
      label: 'GitHub webhook secret (optional — verifies X-Hub-Signature-256)',
      howto: 'the secret you set on the App/repo webhook (or `gh webhook forward`); leave blank to skip verification',
      optional: true, whenWebhook: true,
    }],
    idLabel: 'Repository (owner/repo)',
    idPlaceholder: 'acme/widgets',
    ownerLabel: 'Owner GitHub login (the allowed @mentioner)',
    ownerPlaceholder: 'octocat',
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
    tokenUrl: 'https://www.notion.so/profile/integrations',
    setupSteps: [
      'notion.so/profile/integrations → New connection → capabilities: Read/Insert content, Read/Insert comments, Read user info → that is NOTION_TOKEN (ntn_).',
      'Open each page/database → ••• → Connections → add your integration. Without this it sees nothing — the #1 failure.',
      'Channel id: 32 hex chars from the page link. Owner id: Settings → profile → user id.',
    ],
    secrets: [{
      name: 'notionVerificationToken', envBase: 'NOTION_VERIFICATION_TOKEN',
      label: 'Notion webhook verification token (optional — auto-captured on first event)',
      howto: 'shown when you Create the subscription in the integration; leave blank to capture it from the handshake',
      optional: true, whenWebhook: true,
    }],
    idLabel: 'Notion page or database ID (32 hex chars from the page link)',
    idPlaceholder: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    ownerLabel: 'Your Notion user ID (from GET /v1/users)',
    ownerPlaceholder: '',
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
