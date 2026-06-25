# Messaging platform setup — create the app, get the credentials

knock-knock connects a coding agent to a chat surface through one
platform-neutral `MessagingAdapter` seam (`adapters-msg/`). Five platforms are
supported today; each is one adapter file plus capability-driven degradation.

This page is the **per-platform prerequisite** to [the setup guide](setup.md):
how to create the platform app/bot, which tokens it produces, the exact env-var
**names** the CLI expects, the scopes/permissions to turn on, and how to find
the **channel/scope id** and your **owner id**. Once you have those, you run the
three-command path from [setup.md](setup.md):

```bash
knock-knock setup    # add the bot, paste the id, save the token(s)
knock-knock relay    # connect and go
```

For the architecture behind this — why each platform sorts into transport vs.
tool, what degrades, and the capabilities matrix — see
[messaging-platforms-roadmap.md](messaging-platforms-roadmap.md).

**Fidelity at a glance:**

| Platform | Cadence | Fidelity |
|----------|---------|----------|
| **Discord** | live | full (buttons · reactions · threads · DM · files) |
| **Slack** | live | full (inbound files only; outbound upload pending) |
| **Telegram** | live | near-parity (whitelist reactions, cold-DM, 64-byte callbacks) |
| **GitHub** | async (~60 s) | degraded (no buttons/DM/pin; text-numbered approvals) |
| **Notion** | async (~seconds) | heavily degraded (no reactions/buttons/DM/edit/inline files) |

> **One owner id per platform.** Your owner id (`me.<platform>`) is asked **once
> per platform** in setup and reused as the owner of every bot on it. Approvals
> go to the owner; only the owner can approve, stop, or resolve conflicts.

> **Config is never settable from chat.** `access.json` / `settings.json` are
> written **only** by `knock-knock setup`, never from a message — so nothing
> said in a channel can change who's allowed or what they may do. This
> prompt-injection invariant holds on every platform.

---

## Discord

The live, production-tested surface — full fidelity.

**What you create:** a Discord *application* with a *bot* user, invited to a
server you manage.

**Tokens & env vars:**

| Env var | Value | Where |
|---------|-------|-------|
| `DISCORD_BOT_TOKEN` | the bot token | Developer Portal → Bot → Reset Token |

**Required scopes / config toggles:**

- **Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT** — on. Without it
  the bot connects but reads empty message text.
- **OAuth2 → URL Generator** → scope `bot` → bot permissions: View Channels ·
  Send Messages · Send Messages in Threads · Create Public Threads · Read
  Message History · Add Reactions · Manage Messages. Open the generated URL to
  add the bot. (Threads + Manage Messages matter: each task runs in its own
  thread and the config card / Workbench are pinned messages.)

**How to get the channel id:** turn on **Settings → Advanced → Developer Mode**,
then right-click the project channel → **Copy Channel ID** — a 17–20 digit
snowflake.

**How to find your owner id:** right-click yourself → **Copy User ID** (a
snowflake). Asked once per platform.

**Gotchas:**

- MESSAGE CONTENT INTENT off ⇒ the bot is silent / reads empty text.
- Manage Messages is needed to pin the config card and Workbench.

**Then:** run `knock-knock setup`, choose **Discord**, paste the channel id, and
save the token (`DISCORD_BOT_TOKEN`).

---

## Slack

Full-fidelity over **Socket Mode** (an outbound WebSocket, no public server) —
the platform the seam was modeled on.

**What you create:** a Slack app (from scratch or from a manifest) installed to
your workspace, running in Socket Mode.

**Tokens & env vars:** Slack needs **two** tokens.

| Env var | Value | Where |
|---------|-------|-------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) | OAuth & Permissions → install to workspace |
| `SLACK_APP_TOKEN` | App-Level Token (`xapp-…`), scope `connections:write` | Basic Information → App-Level Tokens |

In setup, `SLACK_APP_TOKEN` is stored as the bot's `secretEnv.appToken` (the
`xoxb-` token is the primary `tokenEnv`).

**Required scopes / config toggles:**

- **Socket Mode** — enable it. This generates the `xapp-` App-Level Token
  (scope `connections:write`).
- **Event Subscriptions** — on. Bot events: `message.channels`,
  `message.groups`, `message.im`, `message.mpim`, `app_mention`,
  `reaction_added`.
- **Interactivity & Shortcuts** — on (so Block Kit buttons fire).
- **Bot Token Scopes** (OAuth & Permissions): `app_mentions:read`,
  `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `chat:write`, `reactions:read`, `reactions:write`, `pins:write`, `files:read`,
  `files:write`.
- **Install to Workspace**, then `/invite` the bot to each channel you want it in.

**How to get the channel id:** open the channel → channel name → **About** →
**Channel ID** at the bottom — looks like `C0123ABCD`.

**How to find your owner id:** click your avatar → **Profile** → **⋯** → **Copy
member ID** — looks like `U0123ABCD`.

**Gotchas:**

- **Two tokens** (`xoxb-` + `xapp-`); both must be saved or `connect` fails fast
  with a missing-`appToken` error.
- **Re-install the app after adding scopes** — Slack only grants scopes present
  at install time.
- **Outbound file upload is not supported yet** (inbound attachments are); a
  `!share` posts a short notice instead of the file.

**Then:** run `knock-knock setup`, choose **Slack**, paste the channel id
(`C…`), and save both tokens (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`).

---

## Telegram

Near-parity over `getUpdates` long-poll (no public server).

**What you create:** a Telegram bot via **@BotFather**.

**Tokens & env vars:**

| Env var | Value | Where |
|---------|-------|-------|
| `TELEGRAM_BOT_TOKEN` | the bot token (`<id>:<secret>`) | @BotFather → `/newbot` |

No extra secret.

**Required scopes / config toggles:**

- **@BotFather → /mybots → your bot → Bot Settings → Group Privacy → Turn off.**
  With Group Privacy *on* (the default) the bot sees only messages that
  @mention it — it appears "deaf" in groups.
- **Make the bot a group ADMIN** — required to receive reaction events
  (`message_reaction`).
- **Forum topics** (the thread analogue) require a **supergroup with Topics
  enabled**; group = room, topic = scope.

**How to get the chat id:** add the bot to the group, then either DM
[@userinfobot](https://t.me/userinfobot) the forwarded message, or call
`getUpdates` on the Bot API and read `chat.id`. Group ids are **negative**;
supergroups are prefixed `-100…`.

**How to find your owner id:** DM [@userinfobot](https://t.me/userinfobot) — it
replies with your numeric user id.

**Gotchas:**

- **The bot can only DM users who have `/start`ed it.** So `/start` your own bot
  in a DM, or approval DMs and override DMs degrade to an in-scope `@mention`
  reply.
- **Privacy mode on ⇒ the bot looks "deaf"** in groups — disable it via
  BotFather.
- Reactions need the bot to be a **group admin**.

**Then:** run `knock-knock setup`, choose **Telegram**, paste the chat id (often
negative / `-100…`), and save the token (`TELEGRAM_BOT_TOKEN`).

---

## GitHub

An **async transport** (~60 s latency) over Notifications-API polling — best for
PR-cadence coding and the agent-to-agent-over-issues pattern, not live chat.

**What you create:** a **dedicated machine-user GitHub account** (a separate
login that acts as the bot) with a **Personal Access Token**. The repo is the
room; an issue / PR is the per-task scope (`owner/repo#n`, resolved
automatically).

**Tokens & env vars:**

| Env var | Value | Where |
|---------|-------|-------|
| `GITHUB_BOT_TOKEN` | a PAT on the machine-user account | github.com/settings/tokens |

No extra secret. Token scopes:

- **Classic PAT:** `repo` + `notifications`.
- **Fine-grained PAT:** Issues **R/W**, Pull requests **R/W**, Contents **R/W**,
  Metadata **R**.

**Required config:**

- The machine-user must be a **collaborator / org member of the repo** so
  @mentions notify it and it can post comments.

**How to get the channel id:** the channel **is the repo** — `owner/repo`. You
register only the repo; each task scope (`owner/repo#issue`) is derived
automatically when the bot is mentioned in an issue or PR.

**How to find your owner id:** your **GitHub login** (username).

**Gotchas:**

- **~60 s latency floor** (`X-Poll-Interval`) — right for async coding, wrong
  for live chat.
- **Public repos are an open prompt-injection surface** — anyone can @mention
  the bot. Restrict to allowed authors (sender allowlist by author association)
  before pointing it at a public repo.
- **Approvals arrive as a numbered text reply** ("reply `1` to allow") rather
  than buttons; the host wiring that turns that reply back into an action is a
  known pending item (see the roadmap's "buttons-as-text" task).
- A **GitHub App identity** (`name[bot]`, higher rate ceiling) is a future
  option; v1 is the PAT machine-user.

**Then:** run `knock-knock setup`, choose **GitHub**, paste the repo id
(`owner/repo`), and save the token (`GITHUB_BOT_TOKEN`).

---

## Notion

A **heavily-degraded async transport** over comment/page polling (~seconds, no
reactions/buttons/DM/edit/inline files). Honest verdict from the build: Notion
is **often better used as an MCP tool than a chat transport** — use it as a
transport only when the conversation genuinely lives in Notion.

**What you create (CRITICAL — two steps, both required):**

1. **Create an internal integration** at
   [notion.so/my-integrations](https://www.notion.so/my-integrations) with
   capabilities **Read content**, **Insert content**, **Read comments**,
   **Insert comments**, and **Read user information**. This yields the
   integration secret.
2. **Share each page or database with the integration.** Open the page/DB →
   **•••** → **Connections** → add your integration. **Without sharing, the
   integration sees nothing** — no token grants implicit access.

**Tokens & env vars:**

| Env var | Value | Where |
|---------|-------|-------|
| `NOTION_TOKEN` | the internal integration secret (`ntn_…`) | the integration's settings |

No extra secret.

**How to get the channel id:** a **page or database id** — 32 hex characters.
Copy the page link (**•••** → **Copy link**) and take the trailing id from the
URL.

**How to find your owner id:** your Notion user id — call
`GET /v1/users` with the integration token (e.g. via the Notion API) and find
your entry, or read it from a `people` mention you've authored.

**Gotchas:**

- **Sharing is mandatory** — re-read step 2. The single most common failure is a
  valid token that sees no pages because the page was never connected to the
  integration.
- **Heavily degraded transport:** no reactions, no buttons (approvals are
  numbered text), no DM, no in-place edit (the bot re-posts instead of editing),
  no inline file blocks; polling cadence is seconds.
- **Cold start ignores the pre-existing comment backlog** — it begins from the
  comments that arrive after it connects.
- The **custom-agents / Workers bridge** (Notion summoning the relay) needs a
  Business/Enterprise workspace and a reachable relay; it's a future option, not
  v1. v1 is local-pure comment/DB polling.

**Then:** run `knock-knock setup`, choose **Notion**, paste the page/database id
(32 hex), and save the token (`NOTION_TOKEN`).

---

## After the credentials

With the app created and the id + token(s) in hand, follow
[the setup guide](setup.md): `knock-knock setup` registers the bot and channel,
masks and saves the token(s) into `~/.knock-knock/.env`, and `knock-knock relay`
connects. Choosing the coding agent behind the bot, presets, and the deny floor
are covered there and in
[getting-started-agents.md](getting-started-agents.md).
