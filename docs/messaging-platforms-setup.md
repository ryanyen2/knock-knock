# Messaging platform setup — create the app, get the credentials

knock-knock connects a coding agent to a chat surface through one
platform-neutral `MessagingAdapter` seam (`adapters-msg/`). Five platforms are
supported; each is one adapter file plus capability-driven degradation.

This page is the **per-platform prerequisite** to [the setup guide](setup.md):
how to create the platform app/bot, which tokens it produces, the exact env-var
**names** the CLI expects, the scopes/permissions to turn on, and how to find
the **channel/scope id** and your **owner id**. Once you have those, run:

```bash
knock-knock setup    # add the bot, paste the id, save the token(s)
knock-knock relay    # connect and go
```

For the architecture and the capabilities rationale see
[messaging-platforms-roadmap.md](messaging-platforms-roadmap.md).

---

## What each platform supports

The table below shows every capability the `MessagingAdapter` seam exposes.
Capability-driven degradation means the host **never branches on platform name**
— it branches on these flags, so an unsupported feature degrades gracefully
(buttons → numbered text, reactions → text status, DM → @mention in-scope, etc.).

| Capability | Discord | Slack | Telegram | GitHub | Notion |
|---|:---:|:---:|:---:|:---:|:---:|
| **Inbound transport** | WebSocket gateway | Socket Mode WS | long-poll | poll ~60 s _or webhook_ | poll ~10 s _or webhook_ |
| **Send / post** | ✅ | ✅ | ✅ | ✅ (comment) | ✅ (comment) |
| **Edit in place** | ✅ | ✅ | ✅ | ✅ (comment) | ✅ (comment, PATCH) |
| **Reactions** | any emoji | any emoji | whitelist (11) | whitelist (8 names) | ❌ none |
| **Approval buttons** | ✅ native | ✅ Block Kit | ✅ inline kbd | ❌ numbered text | ❌ numbered text |
| **Task threads** | ✅ Discord thread | ✅ thread reply | ✅ forum topic | ✅ issue / PR | ❌ comment-only |
| **Pin message** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Direct message owner** | ✅ | ✅ | ⚠️ must /start | ❌ (→ @mention) | ❌ |
| **Typing indicator** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Inbound file attachments** | ✅ (10 MiB) | ✅ | ✅ (20 MiB) | ❌ deferred | ❌ deferred |
| **Outbound file share** | ✅ | ❌ pending | ✅ | ❌ deferred | ❌ deferred |
| **Max message length** | 2 000 chars | ~3 800 chars | 4 096 chars | 65 536 chars | ~2 000 chars |
| **Setup tokens** | 1 | **2** | 1 | 1 | 1 |
| **Recommended use** | live collab | live collab | live collab | async / PR work | async doc work |

### Terminology correspondence

Every platform uses its own vocabulary for the same structural concepts.
knock-knock names are on the left; platform synonyms are on the right.

| knock-knock | Discord | Slack | Telegram | GitHub | Notion |
|---|---|---|---|---|---|
| **bot** | bot user | bot user / app | bot account | machine user / GitHub App | internal integration |
| **room** (permission boundary) | text channel | channel | group / supergroup | repository | database or page |
| **scope** (one task) | thread | thread (`thread_ts`) | forum topic | issue or pull request | page (comment thread) |
| **@mention bot** | @BotName | @appname or `<@botId>` | @botusername | @machine-user-login | @integration-name |
| **approval button** | ActionRow button | Block Kit button | inline keyboard | reply with `1` / `/approve` | reply with `1` / `/approve` |
| **reaction** | emoji reaction | emoji reaction (name) | emoji reaction (whitelist) | reaction (`+1`, `eyes`, …) | — (not supported) |
| **DM owner** | Direct Message | Direct Message | DM (user must /start first) | — (falls back to @mention) | — (not supported) |
| **pin** | Pinned Message | Pinned Message | Pinned Message | — (not supported) | — (not supported) |
| **primary token** | Bot Token | Bot User OAuth Token (`xoxb-…`) | Bot Token | Personal Access Token | Integration Secret (`ntn_…`) |
| **extra token** | — | App-Level Token (`xapp-…`) | — | — | — |
| **channel/room id** | snowflake (17–20 digits) | `C0123ABCD` | negative int / `-100…` | `owner/repo` | 32 hex chars from URL |
| **owner id** | user snowflake | member id (`U0123ABCD`) | numeric user id | GitHub login (username) | Notion user id |

> **One owner id per platform.** Your owner id (`me.<platform>`) is asked
> **once per platform** in setup and reused as the owner of every bot on it.
> Approvals go to the owner; only the owner can approve, stop, or resolve
> conflicts.

> **Config is never settable from chat.** `access.json` / `settings.json` are
> written **only** by `knock-knock setup`, never from a chat message — so nothing
> said in a channel can change who's allowed or what they may do. This
> prompt-injection invariant holds on every platform.

---

## Discord

The live, production-tested surface — full fidelity. **Start here if you are new
to knock-knock.**

### What you are creating

A Discord **Application** (the container), with a **Bot user** inside it
(the identity that joins your server), invited to a **server (guild)** you own
or manage.

```
discord.com/developers/applications
  └── New Application  →  name it
        └── Bot tab  →  Reset Token  →  copy the token  (keep this secret)
              └── OAuth2 → URL Generator  →  invite to server
```

### Step-by-step

**Step 1 — Create the application and bot**

1. Open [discord.com/developers/applications](https://discord.com/developers/applications)
   and click **New Application**. Give it a name (this becomes the bot's default
   username; you can change it later under **Bot → Username**).
2. In the left sidebar click **Bot**.
3. Click **Reset Token** → confirm → **copy the token immediately** — it is shown
   only once. If you lose it, reset it again (invalidates the old one).

**Step 2 — Enable the message-content intent**

Still on the **Bot** tab, scroll down to **Privileged Gateway Intents** and turn
on **MESSAGE CONTENT INTENT**. Without it the bot connects to the gateway but
receives empty message text — it will appear deaf.

**Step 3 — Generate an invite URL and add the bot to your server**

1. In the left sidebar click **OAuth2 → URL Generator**.
2. Under **Scopes** check `bot`.
3. Under **Bot Permissions** check:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
   - Add Reactions
   - Manage Messages _(needed to pin the config card and Workbench)_
4. Copy the generated URL, paste it in a browser, pick your server, and click
   **Authorize**.

**Step 4 — Enable Developer Mode so you can copy IDs**

On your Discord client: **User Settings → Advanced → Developer Mode** → on.
Right-clicking any channel, message, or user now shows a **Copy ID** option.

**Step 5 — Collect the three values you need for setup**

| What | How to get it |
|------|---------------|
| **Bot token** | Developer Portal → your application → **Bot → Reset Token** |
| **Channel ID** | In your server, right-click the project channel → **Copy Channel ID** — a 17–20 digit snowflake like `1234567890123456789` |
| **Your user ID** (owner) | Right-click yourself in any server → **Copy User ID** — same snowflake format. Asked once. |

**Step 6 — Run setup and relay**

```bash
knock-knock setup    # choose Discord → paste channel id → pick bot → set workspace + preset → save token
knock-knock relay    # bot comes online; @mention it
```

### Tokens & env vars

| Env var | Token type | Where |
|---------|-----------|-------|
| `DISCORD_BOT_TOKEN` | Bot Token | Developer Portal → **Bot → Reset Token** |

### Gotchas

- **MESSAGE CONTENT INTENT off** → bot connects but reads empty text; the relay
  logs "empty message" and does nothing.
- **Manage Messages not checked** → the bot can't pin the config card or
  Workbench; pinning silently fails.
- **Bot not invited to the server** → bot comes online but the channel ID lookup
  fails on startup.
- **Wrong channel ID** (e.g. copied the server ID instead) → relay starts but no
  messages arrive.

---

## Slack

Full-fidelity over **Socket Mode** — an outbound WebSocket, so no public server
is needed. Socket Mode is a Discord-gateway twin and was the platform the seam
was modeled on.

### What you are creating

A Slack **app** installed to your workspace, running in **Socket Mode**. Slack
apps need **two** tokens: a `xoxb-` Bot User OAuth Token for API calls, and a
`xapp-` App-Level Token to open the Socket Mode WebSocket.

```
api.slack.com/apps
  └── Create New App → From scratch
        ├── Socket Mode  (generates xapp-)
        ├── OAuth & Permissions  (installs app → generates xoxb-)
        └── Event Subscriptions + Interactivity  (enable)
```

### Step-by-step

**Step 1 — Create the app**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New
   App → From scratch**.
2. Name the app and pick your workspace. Click **Create App**.

**Step 2 — Enable Socket Mode and generate the App-Level Token (`xapp-`)**

1. In the left sidebar under **Settings** click **Socket Mode**.
2. Toggle **Enable Socket Mode** → on.
3. A dialog asks you to create an **App-Level Token**. Name it anything
   (e.g. `relay-socket`), add the scope `connections:write`, and click **Generate**.
4. Copy the token — it starts with `xapp-`. This is `SLACK_APP_TOKEN`.

**Step 3 — Add bot token scopes**

1. In the left sidebar under **Features** click **OAuth & Permissions**.
2. Scroll to **Scopes → Bot Token Scopes** and add:

   ```
   app_mentions:read   channels:history   groups:history
   im:history          mpim:history       chat:write
   reactions:read      reactions:write    pins:write
   files:read          files:write
   ```

**Step 4 — Enable Event Subscriptions**

1. In the left sidebar click **Event Subscriptions** → toggle **Enable Events** →
   on. (Socket Mode apps don't need a Request URL — leave it blank.)
2. Under **Subscribe to bot events** add:

   ```
   message.channels   message.groups   message.im
   message.mpim       app_mention      reaction_added
   ```

3. Click **Save Changes**.

**Step 5 — Enable Interactivity (for approval buttons)**

1. In the left sidebar click **Interactivity & Shortcuts** → toggle on.
2. Leave Request URL empty (Socket Mode handles it). Click **Save Changes**.

**Step 6 — Install the app to your workspace and get the Bot Token (`xoxb-`)**

1. In the left sidebar click **OAuth & Permissions**.
2. Click **Install to Workspace → Allow**.
3. Copy the **Bot User OAuth Token** — starts with `xoxb-`. This is
   `SLACK_BOT_TOKEN`.

> **Re-install after adding scopes.** Slack only grants scopes present at
> install time. If you add scopes later, go back to OAuth & Permissions and
> click **Reinstall to Workspace**.

**Step 7 — Invite the bot to your channel**

In Slack, open the target channel and type:
```
/invite @your-app-name
```
The bot will not receive messages from channels it hasn't been invited to.

**Step 8 — Collect the values you need for setup**

| What | How to get it |
|------|---------------|
| `SLACK_BOT_TOKEN` | OAuth & Permissions → **Bot User OAuth Token** (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Settings → Basic Information → **App-Level Tokens** → your token (`xapp-…`) |
| **Channel ID** | Open the channel in Slack → click the channel name → **About** tab → scroll to the bottom → **Channel ID** (looks like `C0123ABCD`). Or: right-click the channel in the sidebar → **Copy link** — the ID is the last path segment. |
| **Your member ID** (owner) | Click your avatar → **Profile** → **⋯ (More)** → **Copy member ID** (looks like `U0123ABCD`). Asked once. |

**Step 9 — Run setup and relay**

```bash
knock-knock setup    # choose Slack → paste channel id → pick bot → workspace + preset
                     #   → save SLACK_BOT_TOKEN
                     #   → save SLACK_APP_TOKEN (prompted as "app-level token")
knock-knock relay
```

### Tokens & env vars

| Env var | Token type | Starts with | Where |
|---------|-----------|-------------|-------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token | `xoxb-` | OAuth & Permissions → install workspace |
| `SLACK_APP_TOKEN` | App-Level Token | `xapp-` | Basic Information → App-Level Tokens |

Both tokens are required. `knock-knock setup` saves both; `connect` fails fast
with a clear error if either is missing.

### Gotchas

- **Two tokens, not one** — the most common mistake is saving only `xoxb-` and
  forgetting the `xapp-`. The relay will print "missing appToken secret" at
  startup.
- **Re-install the app after adding scopes** — see step 6.
- **Bot not `/invite`d to the channel** → no messages arrive; the bot is in the
  workspace but not the channel.
- **Outbound file sharing (`!share`) not yet implemented** — `!share <path>` will
  post a notice instead of sending the file; inbound attachments work fine.
- **No typing indicator** — the Slack web API has no equivalent of Discord's
  typing event (it was RTM-only and is deprecated); the 👀 reaction signals
  "working" instead.

---

## Telegram

Near-parity over `getUpdates` long-poll — no public server needed. Reactions use
a fixed whitelist; **forum topics** are the thread analogue.

### What you are creating

A Telegram **bot account**, created through **@BotFather** (Telegram's own bot
that manages bot registration). The bot is added to a **group** or **supergroup**
(the room); if you want per-task threads, you need a **supergroup with Topics
enabled** (Topics = Telegram's forum-topic feature).

```
Telegram → message @BotFather
  └── /newbot  →  choose name + username  →  copy token
        └── /mybots → your bot → Bot Settings → Group Privacy → Turn off
              └── Add bot to group / supergroup → make it admin (for reactions)
```

### Step-by-step

**Step 1 — Create the bot with @BotFather**

1. Open Telegram and start a conversation with
   [@BotFather](https://t.me/BotFather).
2. Send `/newbot`. BotFather asks for:
   - A **display name** (e.g. "My Coding Bot") — shown in the chat header.
   - A **username** (must end in `bot`, e.g. `my_coding_bot`) — used for
     @mentions.
3. BotFather replies with the **bot token** in the format `<id>:<secret>` (e.g.
   `7123456789:AAFxxx…`). Copy it. This is `TELEGRAM_BOT_TOKEN`.

**Step 2 — Disable Group Privacy (critical)**

With Group Privacy **on** (the Telegram default), the bot only sees messages
that directly @mention it — everything else is invisible to it.

1. Message @BotFather → `/mybots` → pick your bot →
   **Bot Settings → Group Privacy → Turn off**.
2. BotFather confirms "Privacy mode is disabled".

> If you skip this step the bot will appear "deaf" to most group messages.

**Step 3 — Set up the group (room)**

Two options:

| Option | Threads? | Setup |
|--------|----------|-------|
| Plain group / supergroup | No (all messages at room scope) | Just create a Telegram group and add the bot |
| Supergroup with Topics | Yes (each topic = one task) | Create a **supergroup** → **Edit → Topics → enable** |

For the room ID (needed by setup), the quickest method: after adding the bot,
DM [@userinfobot](https://t.me/userinfobot) a message forwarded from the group —
it replies with `chat_id`. Group IDs are **negative** integers (e.g. `-1001234567890`).

**Step 4 — Make the bot a group admin (required for reactions)**

In the group → tap the group name → **Administrators → Add Administrator** →
pick your bot. Reactions (`message_reaction` updates) are only delivered to
admins.

**Step 5 — /start the bot yourself (required for DMs)**

In a private chat with your bot, send `/start`. This opens the DM channel.
The relay can only send you approval DMs and override notifications if you've
opened this channel. If you don't, those messages fall back to an @mention in
the task scope.

**Step 6 — Collect the values you need for setup**

| What | How to get it |
|------|---------------|
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` reply, format `<id>:<secret>` |
| **Chat ID** (room) | Forward a group message to [@userinfobot](https://t.me/userinfobot); or call `https://api.telegram.org/bot<token>/getUpdates` in a browser after posting a message to the group |
| **Your user ID** (owner) | DM [@userinfobot](https://t.me/userinfobot) — it replies with your numeric user id (e.g. `123456789`). Asked once. |

**Step 7 — Run setup and relay**

```bash
knock-knock setup    # choose Telegram → paste chat id (often -100…) → bot → workspace + preset → save token
knock-knock relay
```

### Tokens & env vars

| Env var | Token type | Format | Where |
|---------|-----------|--------|-------|
| `TELEGRAM_BOT_TOKEN` | Bot Token | `<numeric_id>:<secret>` | @BotFather → `/newbot` |

### Reaction whitelist

Telegram only allows reactions from a fixed set. knock-knock maps its control
glyphs to the closest permitted emoji:

| knock-knock glyph | Telegram emoji | Meaning |
|---|---|---|
| 👀 | 👀 | working / saw message |
| 🏁 | 🎉 | done |
| ⚠️ | 😱 | failed |
| ⏹ | 👎 | stopped |
| 🛑 | 👎 | stop signal |
| ✅ | 👍 | approved |
| ❌ | 👎 | denied |

Any glyph not in the whitelist (`👍 👎 ❤️ 🔥 🎉 🤔 😱 🙏 👏 🤩 👀`) is skipped
and status falls back to a text note.

### Gotchas

- **Group Privacy on (default)** → bot is "deaf" to most messages. Disable via
  BotFather (step 2).
- **Bot not group admin** → reaction events (`message_reaction`) are not
  delivered; status reactions silently fail.
- **Cold DM** → if you never `/start`ed the bot in a private chat, DMs fail;
  override / approval messages fall back to an in-scope @mention.
- **64-byte callback limit on buttons** — Telegram inline keyboard `callback_data`
  is capped at 64 bytes; the adapter maps long action IDs through an internal
  side table, so this is transparent to you.
- **Topics / forum scope** — reaction events on a topic carry no `message_thread_id`
  in the Telegram API; this means control reactions (✅/❌/🛑) on a task in a forum
  topic are surfaced at room scope, not topic scope. This is a known Telegram API
  limitation.

---

## GitHub

An **async transport** (~60 s latency) over Notifications-API polling — best for
PR-cadence coding and the agent-to-agent-over-issues pattern, not live chat.

### What you are creating

A **dedicated machine-user GitHub account** (a separate GitHub login that acts
as the bot identity). You register that account as a **collaborator** on your
repo, and give it a **Personal Access Token**. The repository is the room; each
issue or pull request is a task scope.

```
github.com → create a second account  (the "machine user")
  └── Invite machine user as collaborator on your repo
        └── Sign in as machine user → Settings → Developer Settings → Tokens
              └── Create PAT with repo + notifications scopes
```

> **Why a separate account?** GitHub comments are posted as the token's owner.
> Using a dedicated account means the bot's replies are clearly attributed and
> don't clutter your personal activity feed.

### Step-by-step

**Step 1 — Create the machine-user account**

Create a second GitHub account at [github.com/join](https://github.com/join).
Pick a name that makes it clear it's a bot (e.g. `acme-coding-bot`). GitHub
requires a unique email address — use an alias or a `+tag` variant.

**Step 2 — Invite the machine user as a collaborator**

In your repository: **Settings → Collaborators and teams → Add people** →
search for the machine-user login → **Add collaborator**. The machine user
must accept the invite (sign in as them and accept via the email or the
[github.com/notifications](https://github.com/notifications) page).

**Step 3 — Create a Personal Access Token for the machine user**

Sign in as the machine user, then:

- **Classic PAT:**
  [github.com/settings/tokens](https://github.com/settings/tokens) →
  **Generate new token (classic)** → check `repo` and `notifications` →
  **Generate token** → copy.

- **Fine-grained PAT (recommended):**
  [github.com/settings/tokens](https://github.com/settings/tokens) →
  **Fine-grained tokens → Generate new token** → scope to the specific
  repository → grant:
  - Issues: **Read and write**
  - Pull requests: **Read and write**
  - Contents: **Read and write**
  - Metadata: **Read**
  - Notifications: **Read**

This token is `GITHUB_BOT_TOKEN`.

**Step 4 — Collect the values you need for setup**

| What | How to get it |
|------|---------------|
| `GITHUB_BOT_TOKEN` | Machine user → Settings → Developer Settings → **Personal access tokens** |
| **Repo ID** (channel) | Simply `owner/repo` — e.g. `acme/my-project`. No numeric ID needed; you type it in setup. |
| **Your GitHub login** (owner) | Your personal GitHub username (e.g. `octocat`). Asked once. |

**Step 5 — Run setup and relay**

```bash
knock-knock setup    # choose GitHub → poll or webhook → type owner/repo → pick bot → workspace + preset → save token
knock-knock relay
```

### Tokens & env vars

| Env var | Token type | Starts with | Where |
|---------|-----------|-------------|-------|
| `GITHUB_BOT_TOKEN` | Personal Access Token | `ghp_` (classic) or `github_pat_` (fine-grained) | Machine user → Settings → Developer Settings |
| `GITHUB_WEBHOOK_SECRET` _(optional)_ | webhook signing secret | — | only for webhook intake with a signed App/repo webhook |

### Intake mode: poll (default) or webhook

GitHub is poll-based by default (~60 s; setup picks this unless you choose webhook). For
near-instant delivery, choose **webhook** intake in setup and forward events to the relay's
local receiver — **no public URL needed**:

```bash
gh extension install cli/gh-webhook        # once
gh webhook forward --repo <owner/repo> --events issue_comment \
  --url http://localhost:8787/github/<botKey>
```

Keep that running next to `knock-knock relay`. Set `KNOCK_KNOCK_WEBHOOK_PORT` if `8787` is
taken. Full details, signing, and the GitHub-App/smee.io path:
[messaging-event-driven-intake.md](messaging-event-driven-intake.md).

### How scopes map

| GitHub concept | knock-knock concept |
|---|---|
| repository | **room** (permission boundary; profile per repo) |
| issue or pull request | **scope** (one task) |
| comment on issue/PR | message |
| bot posting a comment | `send` |
| editing a comment | `edit` |
| `@machine-user-login` | @mention bot |
| issue/PR number suffix | scope id (`owner/repo#123`) |

The task scope id is derived **automatically** when someone @mentions the bot in
an issue or PR — you never type issue numbers in setup.

### Approval flow (no native buttons)

GitHub has no interactive button API in comments. Approvals and session-pick
choices degrade to a numbered menu:

```
The bot wants to run: bash("npm test")

  1 — Allow
  2 — Deny

Reply with the number to choose.
```

Reply with `1` or `2` in the same issue/PR thread. The host detects it and
routes it as an approval action.

### Gotchas

- **~60 s latency floor** (`X-Poll-Interval` from the Notifications API) — right
  for async coding, wrong for live chat.
- **Public repos are an open prompt-injection surface** — anyone can @mention the
  bot on a public repo. The relay auto-trusts only comment authors whose
  `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` (plus the configured
  owner + roster); `CONTRIBUTOR` / `FIRST_TIMER` / `NONE` are ignored. So a repo's real
  collaborators "just work" without being re-listed, while drive-by commenters can't
  trigger the bot. **Still review who has collaborator access before pointing at a
  public repo.**
- **REST quota** — each new mention fetches comment history; watch usage with a
  busy public repo. A GitHub App identity (higher rate ceiling) is a deferred
  fast-follow; v1 is a PAT machine-user.
- **No DM** — approval DMs fall back to an @mention comment in the issue/PR
  thread.
- **No pin, no buttons** — conflict cards and session-pick use numbered text menus.

---

## Notion

A **heavily-degraded async transport** over comment/page polling (~10 s). Honest
recommendation from the build: **Notion is often better used as an MCP tool than
a chat transport** — use it as a transport only when the conversation genuinely
lives in Notion.

### What you are creating

A Notion **connection** (Notion's current Developer Portal term for an integration) —
a credential scoped to your workspace, connected to specific pages or databases. Unlike
the other platforms there is no "bot account"; the connection itself posts as a named
entity.

In the **New connection** dialog (notion.so/profile/integrations → New connection) pick
the **Authentication method**:

- **Access token** (recommended for knock-knock) — a workspace-scoped static token
  (`ntn_…`). Single workspace, not Marketplace-eligible. This is the simplest path and
  what the relay uses. A user **Personal Access Token (PAT)** works identically — both are
  bearer tokens you save as `NOTION_TOKEN`.
- **OAuth** — user-scoped OAuth 2.0, multi-workspace, Marketplace-eligible. Only needed if
  you're distributing a public integration; not required for self-hosting the relay.

```
notion.so/profile/integrations  →  New connection
  ├── Name it + choose "Access token" + pick workspace
  ├── Capabilities: Read/Insert content, Read/Insert comments, Read user info
  └── Copy the Access token / Internal Integration Secret  (ntn_…)
        ↓
  For EACH page or database the bot should watch:
  Open page → ••• (top-right) → Connections → add your connection
```

> **The sharing step is mandatory.** A valid token that has not been connected
> to a page sees nothing — no error, just silence. This is the single most
> common failure mode.

### Step-by-step

**Step 1 — Create the internal integration**

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and
   click **+ New integration**.
2. Give it a name (e.g. "knock-knock relay"), pick your workspace, and upload an
   icon if you like.
3. Under **Capabilities** enable:
   - **Read content**
   - **Insert content**
   - **Read comments**
   - **Insert comments**
   - **Read user information**
4. Click **Submit**. On the next page copy the **Internal Integration Secret** —
   it starts with `ntn_`. This is `NOTION_TOKEN`.

**Step 2 — Share each page or database with the integration**

For **every** page or database you want the bot to watch:

1. Open the page in Notion.
2. Click **•••** (the three-dot menu in the top-right corner).
3. Click **Connections → Add connections** → search for your integration name →
   select it.
4. Confirm that you see the integration name appear under Connections.

> Repeat this for each project page or database. The relay only polls pages
> that have been connected.

**Step 3 — Find the page or database ID**

The ID is the 32 hex characters at the end of the page URL:

```
https://www.notion.so/My-Page-Title-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
                                     ↑─────────── this part ───────────↑
```

Strip the hyphens — Notion sometimes shows it with hyphens in the URL, but
`knock-knock setup` accepts either format.

**Step 4 — Find your Notion user ID**

Call the Notion API with your token to list workspace users:

```bash
curl -H "Authorization: Bearer ntn_YOUR_TOKEN" \
     -H "Notion-Version: 2022-06-28" \
     https://api.notion.com/v1/users
```

Find your entry in the JSON and copy the `"id"` field — a UUID like
`a1b2c3d4-e5f6-7890-abcd-ef1234567890`. This is asked once as your owner id.

Alternatively: in Notion, create a new page, type `@` and start typing your
name, hover over your entry in the dropdown — the URL in your browser's status
bar shows your user ID.

**Step 5 — Run setup and relay**

```bash
knock-knock setup    # choose Notion → paste page/database id → bot → workspace + preset → save token
knock-knock relay
```

### Tokens & env vars

| Env var | Token type | Starts with | Where |
|---------|-----------|-------------|-------|
| `NOTION_TOKEN` | Access token / Internal Integration Secret / PAT | `ntn_` | notion.so/profile/integrations → your connection |
| `NOTION_VERIFICATION_TOKEN` _(optional)_ | webhook verification token | — | only for webhook intake; auto-captured on the subscription handshake |

### Intake mode: poll (default) or webhook

Notion polls page comments every ~10 s by default. When the host configures the bot's
tracked page/database ids (from your `notion:<id>` channels), the sweep polls **only those
pages** instead of scanning the whole workspace — faster and a smaller injection surface.

For near-instant delivery, choose **webhook** intake in setup. Notion webhooks need a
public HTTPS URL, so front the relay's receiver with a tunnel and create a subscription:

```bash
cloudflared tunnel --url http://localhost:8787      # or: ngrok http 8787
```

Then in your connection → **Webhooks → Create subscription**: paste
`https://<tunnel-host>/notion/<botKey>`, pick API version `2026-03-11`, select the
**Comment** events, and create. Notion sends a one-time verification token that the relay
captures automatically. Full details:
[messaging-event-driven-intake.md](messaging-event-driven-intake.md).

### How scopes map

| Notion concept | knock-knock concept |
|---|---|
| database or top-level page | **room** (permission boundary) |
| page (or database row as page) | **scope** (one task) |
| comment on a page | message |
| integration posting a comment | `send` |
| @integration-name in a comment | @mention bot |

### Approval flow (no native buttons)

Same as GitHub — no interactive button API. Approvals degrade to a numbered
text menu in a comment; reply with the number in the same page thread.

### Gotchas

- **Sharing is mandatory** — if the page isn't connected to the integration (step
  2), the relay polls nothing and no messages are received. No error is shown.
- **Cold start ignores existing comments** — on first connect the relay records
  all current comments as "seen" and only responds to new ones. Pre-existing
  discussion is not replayed.
- **~10 s polling latency** (Notion's comment API is rate-limited to ~3 req/s;
  the adapter spaces requests to stay under the ceiling). Webhook intake removes the
  poll delay — see Intake mode above.
- **No reactions, no buttons, no DM** — status is conveyed in text appended to
  comments; approvals are numbered text menus (reply with the number).
- **Comments ARE edited in place** — the adapter uses `PATCH /v1/comments`
  (`comments.update`), so status/Workbench updates rewrite a comment instead of posting
  a new one each time.
- **Writing INTO the page (not just comments)** — a Notion bot on the `claude-sdk`
  runtime gets page-scoped tools (`read_page`, `append_to_page`) locked to the page the
  conversation is on. So "add a paragraph describing X to the page" appends to the page
  *body*; the agent's chat reply still posts as a *comment*. The agent is told (via its
  preamble) to use these tools rather than editing local files for page changes. (ACP
  runtimes don't expose these yet.)
- **File exchange deferred** — Notion's file upload API is multi-step; inbound
  and outbound file handling is not yet wired.
- **Workers bridge (future)** — a Notion Worker + External Agents API
  integration that lets Notion summon the relay bidirectionally requires a
  Business/Enterprise workspace and a publicly reachable relay endpoint; it is a
  planned fast-follow, not v1.

---

## After the credentials

With the app created and the id + token(s) in hand, follow
[the setup guide](setup.md): `knock-knock setup` registers the bot and channel,
masks and saves the token(s) into `~/.knock-knock/.env`, and `knock-knock relay`
connects. Choosing the coding agent behind the bot, presets, and the deny floor
are covered there and in
[getting-started-agents.md](getting-started-agents.md).

### Quick reference: which platform to use?

| Goal | Best platform |
|------|---------------|
| Live, interactive collaboration with full approval UX | **Discord** or **Slack** |
| Async PR review / agent-to-agent-over-issues | **GitHub** |
| Team that already lives in Telegram | **Telegram** |
| Conversation genuinely happening on a Notion page | **Notion** (with expectations set) |
| Need OS sandbox + untrusted work | Any platform + `claude-acp` runtime + `sandbox` config |
