# Setting up a messaging platform

Step-by-step setup for each platform knock-knock can speak — create the bot/app,
get the tokens, wire it into knock-knock, run it, and know what works and what
doesn't. This is the practical companion to
**[messaging-platforms.md](messaging-platforms.md)** (the architecture: the
`MessagingAdapter` seam and the cross-platform capability mapping).

> **Maturity.** ✅ **Discord** is production-tested. ⚠️ **Slack, Telegram,
> WhatsApp, iMessage** are **walking skeletons** — implemented and type-checked,
> not yet live-verified end-to-end. Each adapter's source header
> (`adapters-msg/<platform>.ts`) lists exactly what is real vs stubbed. Verify
> with a test account before relying on one.

---

## How configuration works (every platform)

knock-knock has **no `config.json`**. Everything is written by the setup CLI:

```bash
bun setup.ts        # interactive: add/reconfigure an agent, rooms, tokens, ledger
bun relay.ts        # start the relay — reads access.json + .env
```

- **Pick the platform per agent.** In `bun setup.ts`, **"Add another agent"** (or
  **"Reconfigure an agent"** to change an existing one) asks *"Which messaging
  platform does this bot speak?"*. It's stored as the agent's `platform` field in
  `access.json`; the relay builds the matching adapter at boot. Discord is the
  default and omits the field.
- **The bot token lives in `.env`**, under the name shown as the agent's
  `tokenEnv` (e.g. `DISCORD_BOT_TOKEN`) — never in `access.json`
  (prompt-injection invariant). Some platforms read a few **extra** `.env` vars;
  the wizard prints them after you save the agent.
- **Owner / humans / peers** are platform ids. The wizard accepts the right id
  shape per platform (Discord wants numeric snowflakes; the others accept
  letters, negative numbers, GUIDs, or phone numbers).
- **A "room"** is the parent channel/chat the agent serves; its id shape is
  platform-specific (see each section).

Each platform below follows: **Prerequisites → numbered Steps → How it works →
Environment variables → Limitations → Troubleshooting.**

---

## ✅ Discord

### Prerequisites
- A Discord server you can add a bot to (Manage Server permission).
- Developer Mode on (**Settings → Advanced → Developer Mode**) to copy IDs.

### Step 1 — Create the application & bot
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name it.
2. **Bot** tab → **Reset Token** → copy it (shown once). This is your bot token.

### Step 2 — Enable the message-content intent
**Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.** This is the
only privileged toggle. Without it, the bot connects but receives empty message
text.

### Step 3 — Invite the bot
**OAuth2 → URL Generator** → scope **`bot`** → Bot Permissions: **View Channels,
Send Messages, Send Messages in Threads, Create Public Threads, Read Message
History, Add Reactions, Manage Messages** (Manage Messages is for pinning the
Workbench). Open the generated URL and add the bot to your server.

### Step 4 — Configure in knock-knock
```bash
bun setup.ts        # platform → Discord (default)
```
You'll provide: **your Discord user ID** (the owner; right-click yourself → Copy
User ID), the **room channel ID** (right-click the channel → Copy Channel ID),
and the **bot token** (saved to `.env`).

### Step 5 — Run
```bash
bun relay.ts
```

### How it works
A gateway WebSocket. A top-level **@mention spawns a task thread**; replies in
that thread continue the task. Status is emoji **reactions** (👀 working → 🏁
done / ⚠️ failed); approvals & conflicts are **buttons**; the owner gets a **DM**
when a draft is overridden.

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` (your `tokenEnv`) | yes | bot token |

### Limitations
None of note — Discord is the reference platform.

### Troubleshooting
| Symptom | Fix |
|---|---|
| Bot silent | MESSAGE CONTENT INTENT off; not @mentioned (and room requires mention); bot not in the channel |
| Won't post / pin in threads | Missing Create Public Threads / Send Messages in Threads / Manage Messages |
| Empty message text | MESSAGE CONTENT INTENT not enabled |

---

## ⚠️ Slack

**You create an app (with a bot user) and use an app manifest.** Slack needs
**two tokens**: a bot token (`xoxb-`) for the Web API and an app-level token
(`xapp-`) for **Socket Mode** — so no public URL/webhook is needed.

### Prerequisites
- Permission to create + install an app in your Slack workspace.

### Step 1 — Create the app from a manifest
[api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an
app manifest** → choose your workspace → paste:

```yaml
display_information:
  name: knock-knock-agent
features:
  bot_user:
    display_name: knock-knock-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write          # post / update / ephemeral replies
      - reactions:read       # receive reaction_added events
      - reactions:write      # status reactions
      - pins:write           # pin the Workbench
      - im:write             # open a DM for approvals / override notices
      - app_mentions:read    # "directed at me" detection
      - channels:history     # CRITICAL — receive public-channel messages
      - groups:history       # CRITICAL — receive private-channel messages
      - im:history           # receive DMs
      - channels:read        # resolve channel ids
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
      - reaction_added
  interactivity:
    is_enabled: true         # block-kit buttons (approval / conflict / session)
  socket_mode_enabled: true  # no public URL needed
  org_deploy_enabled: false
  token_rotation_enabled: false
```

> **CRITICAL:** without `channels:history` / `groups:history` **and** the matching
> `message.*` event subscriptions, the bot connects and joins channels fine but
> Slack **silently drops every incoming message** — no error, no log. If you add
> scopes later you must **reinstall** the app.

### Step 2 — Enable Socket Mode & get the app-level token
**Basic Information → App-Level Tokens → Generate Token and Scopes** → add scope
**`connections:write`** → copy the **`xapp-…`** token. (The manifest already set
`socket_mode_enabled: true`.)

### Step 3 — Install & get the bot token
**OAuth & Permissions → Install to Workspace** → authorize → copy the **Bot User
OAuth Token (`xoxb-…`)**.

### Step 4 — Invite the bot to the channel
In the Slack channel: `/invite @knock-knock-agent`. A bot only sees and posts in
channels it has joined.

### Step 5 — Configure in knock-knock
```bash
bun setup.ts        # platform → Slack
```
Owner = your **Slack user ID** (profile → ⋮ → Copy member ID, `U…`). Room id =
the **channel ID** (`C…` — open the channel → **View channel details** → bottom).
Then set both tokens in `.env`:

```
SLACK_BOT_TOKEN=xoxb-…       # the name you chose as the agent's tokenEnv
SLACK_APP_TOKEN=xapp-…       # fixed name the adapter reads for Socket Mode
```

### Step 6 — Run
```bash
bun relay.ts
```

### How it works
Socket Mode opens a WebSocket (`apps.connections.open`) — inbound events arrive
with no firewall hole; posting uses the Web API. **Threads** are native
(`thread_ts`, encoded internally as the scope `channel#thread_ts`). Choices render
as **block-kit buttons**; status uses named-shortcode **reactions**.

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` (your `tokenEnv`) | yes | Web API auth (`xoxb-`) |
| `SLACK_APP_TOKEN` | yes | Socket Mode (`xapp-`, scope `connections:write`) |

### Limitations
- **Reactions are a whitelist** — only project glyphs with a known Slack
  shortcode (👀→`eyes`, 🏁→`checkered_flag`, ✅→`white_check_mark`, …) are sent;
  anything else is skipped silently.
- **No name resolution** — the console shows raw channel/user ids.
- **Best-effort reconnect** (single re-open, no backoff) — a long outage may need
  a relay restart.
- **No typing indicator** (no Web API call for it).

### Troubleshooting
| Symptom | Fix |
|---|---|
| Posts work, no inbound | `SLACK_APP_TOKEN` missing → Socket Mode off (the adapter logs this), or missing `*:history` scopes + events (reinstall) |
| Buttons do nothing | Interactivity disabled (the manifest enables it; Socket Mode needs no Request URL) |
| "not_in_channel" on send | `/invite` the bot into that channel |
| "Bot can't see messages" | Reinstall after adding history scopes |

---

## ⚠️ Telegram

**No app, no manifest — a bot from @BotFather and one token.** The key gotcha is
the **privacy setting**, which decides whether the bot reads non-mention group
messages.

### Prerequisites
- A Telegram account.

### Step 1 — Create the bot
Message **[@BotFather](https://t.me/BotFather)** → `/newbot` → pick a display name
→ pick a username ending in `bot`. It returns a token like
`123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Keep it secret.

### Step 2 — Set privacy mode
Still in BotFather: `/setprivacy` → pick your bot →
- **Disable** — the bot sees **all** group messages (use if your room runs
  mention-optional).
- **Enable** (default) — the bot only sees messages that **@mention it, reply to
  it, or are commands**. Fine if your room requires a mention.

(In 1:1 chats the bot always sees everything.) If you'll use groups, also
`/setjoingroups → Enable`.

### Step 3 — Put the bot where it will work
Either **DM the bot**, or **add it to a group**. For a group, add it by username;
if privacy is Enabled, address it with `@yourbot …` or reply to its messages.

### Step 4 — Get the ids you need
- **Your owner user id** (numeric): message **[@userinfobot](https://t.me/userinfobot)**.
- **Room chat id**: send a message in the chat, then
  `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and read `result[].message.chat.id`
  (groups/supergroups are **negative**, e.g. `-1001234567890`). Or forward a
  group message to **@RawDataBot**.

### Step 5 — Configure in knock-knock
```bash
bun setup.ts        # platform → Telegram
```
Owner = your numeric user id; room id = the chat id (negative for groups); token
→ `.env` under your `tokenEnv` (e.g. `TELEGRAM_BOT_TOKEN`). No extra vars.

### Step 6 — Run
```bash
bun relay.ts
```

### How it works
Long-polling (`getUpdates`) — no webhook. Choices are **inline keyboards**; status
uses `setMessageReaction` against Telegram's fixed-emoji **whitelist**; a user's
DM chat id is just their user id.

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` (your `tokenEnv`) | yes | BotFather token |

### Limitations
- **No task threads** — forum topics aren't wired, so each chat is one flat scope
  (parallel tasks in a chat share a transcript).
- **Reactions only in supergroups/channels** — they no-op in 1:1 chats.
- **`unreact` clears all reactions** on a message (Bot API can't remove one).
- **Markdown renders literally** — text is sent plain (Telegram's MarkdownV2 is
  incompatible with Discord-flavored markdown), so `**bold**` / attribution
  subtext show raw characters.

### Troubleshooting
| Symptom | Fix |
|---|---|
| Silent in a group | Privacy Enabled and you didn't @mention/reply; or bot isn't a member |
| Reactions never appear | You're in a 1:1 chat (reactions need a group/channel) |
| Looping, nothing happens | Bad/revoked token — the poll loop logs `getUpdates failed …` |
| Wrong chat | Group ids are negative (`-100…`); don't use a positive user id as a room |

---

## ⚠️ WhatsApp (Cloud API)

The heaviest setup: a **Meta app**, a phone number, and — because WhatsApp
delivers inbound via **webhook** — a **publicly reachable URL**.

### Prerequisites
- A Meta (Facebook) developer account and a Business app.
- A way to expose a local port publicly (tunnel or reverse proxy).

### Step 1 — Create the app & add WhatsApp
[developers.facebook.com](https://developers.facebook.com) → **My Apps → Create
App → Business** → open the app → **Add product → WhatsApp → Set up**.

### Step 2 — Get the number, id, and token
In **WhatsApp → API Setup**: note the **test phone number**, its **Phone number
ID**, and the **temporary access token** (24h). For something lasting, create a
**System User** in [Business Settings](https://business.facebook.com) with a
permanent token and the `whatsapp_business_messaging` permission. Add your own
number as a **recipient** (test mode only messages allow-listed numbers).

### Step 3 — Set the env vars
```
WHATSAPP_TOKEN=EAAG…                 # your tokenEnv value (access token)
WHATSAPP_PHONE_NUMBER_ID=1234567890  # from API Setup
WHATSAPP_VERIFY_TOKEN=any-secret-you-pick
WHATSAPP_WEBHOOK_PORT=8787           # the adapter's Bun.serve port (default)
```

### Step 4 — Expose & register the webhook
The adapter serves `GET/POST /webhook` on `WHATSAPP_WEBHOOK_PORT`. Put a tunnel in
front:
```bash
cloudflared tunnel --url http://localhost:8787    # or: ngrok http 8787
```
Then **WhatsApp → Configuration → Webhook**: **Callback URL** =
`https://<public-host>/webhook`, **Verify token** = your `WHATSAPP_VERIFY_TOKEN`,
and **subscribe to the `messages` field**. Meta does a GET handshake the adapter
answers automatically.

### Step 5 — Configure in knock-knock
```bash
bun setup.ts        # platform → WhatsApp
```
Owner = your WhatsApp number in **E.164** (e.g. `+15551234567`); a "room" is a
contact's `wa_id` (their number). Token + the three extra vars go in `.env`.

### Step 6 — Run
```bash
bun relay.ts        # starts the webhook server on WHATSAPP_WEBHOOK_PORT
```

### How it works
Outbound is a Graph API POST; inbound is the webhook. Choices ≤ 3 render as native
**reply buttons**; more than 3 (or any reply) fall back to a **numbered text
menu** parsed back into a choice.

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `WHATSAPP_TOKEN` (your `tokenEnv`) | yes | Graph API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | the sending number's id |
| `WHATSAPP_VERIFY_TOKEN` | yes | webhook handshake secret |
| `WHATSAPP_WEBHOOK_PORT` | no | webhook port (default `8787`) |

### Limitations
- **24-hour window** — outside 24h of the user's last message you can only send
  pre-approved **message templates**, not free text. A hard WhatsApp rule that
  surprises everyone in testing.
- **No edit, no pin, no threads** — the Workbench reposts; a prompt `update` sends
  a fresh message.
- **Buttons cap at 3** — beyond that it's the text-menu fallback.
- **Production needs business verification** to message numbers beyond your test
  recipients.

### Troubleshooting
| Symptom | Fix |
|---|---|
| Webhook won't verify | `WHATSAPP_VERIFY_TOKEN` mismatch, or the public URL isn't reaching `:WHATSAPP_WEBHOOK_PORT/webhook` |
| Sends silently fail | `WHATSAPP_PHONE_NUMBER_ID` unset (the adapter warns at startup), or token expired |
| "can't send" after a while | Outside the 24-hour window — the user must message first, or use a template |
| No inbound | Not subscribed to the `messages` field in Configuration |

---

## ⚠️ iMessage

**No bot, no app, no token** — but **macOS-only**, with two system-permission
grants. Inbound is read from the local Messages database; outbound drives
Messages.app via AppleScript.

### Prerequisites
- A Mac signed into **iMessage** in Messages.app.

### Step 1 — Grant Full Disk Access
The relay process must read `~/Library/Messages/chat.db`: **System Settings →
Privacy & Security → Full Disk Access** → add your terminal app (or the `bun`
binary) → toggle on → restart the terminal.

### Step 2 — Grant Automation
AppleScript must control Messages: the first send triggers a prompt (**Allow**),
or pre-allow under **Privacy & Security → Automation →** *your terminal* →
**Messages**.

### Step 3 — Find the room's chat GUID
With Full Disk Access granted:
```bash
sqlite3 ~/Library/Messages/chat.db "SELECT guid, display_name FROM chat;"
```
A GUID looks like `iMessage;-;+15551234567` (1:1) or `iMessage;+;chat123…`
(group). Or just send a message to the bot and read the inbound **scope** the
relay logs.

### Step 4 — Configure in knock-knock
```bash
bun setup.ts        # platform → iMessage
```
Owner = your handle (`+15551234567` or `you@icloud.com`); room id = the chat GUID.
**No token** — the `tokenEnv` is unused (any placeholder is fine).

### Step 5 — Run
```bash
bun relay.ts
```

### How it works
A 1.5s SQLite poll of `chat.db` (watermarked by row id, so no history replay)
surfaces new inbound; sending shells out to `osascript`. There are **no
reactions, threads, buttons, or edits**, so **every** interactive flow (approvals,
conflict resolution, session pick) runs through the **text-command fallback**:
the bot posts a numbered menu and parses your typed reply (`2`, `deny`, `take A`).

### Environment variables
None. (macOS permissions do the gating; the `tokenEnv` value is ignored.)

### Limitations
- **No tapbacks/reactions, no threads, no buttons, no edit, no pin** — text only.
- **Message-body decode is heuristic** — when a message has no plain `text`
  column (newer macOS stores it in a binary `attributedBody`), extraction is
  best-effort; some rich/non-ASCII messages may be missed.
- **iMessage only** (no green-bubble SMS); group-vs-direct routing isn't validated
  in the skeleton.
- For real tapbacks/edits, a future adapter could bridge
  [BlueBubbles](https://bluebubbles.app) instead of raw AppleScript.

### Troubleshooting
| Symptom | Fix |
|---|---|
| No inbound at all | Relay process lacks **Full Disk Access** (re-grant, restart terminal) |
| Sends do nothing | **Automation** permission denied for the terminal → Messages |
| Garbled / missing text | The `attributedBody` heuristic couldn't decode that message |
| Wrong/no chat | Use the exact `chat.guid` from the SQLite query above |

---

## Reconfiguring later

You don't have to delete and re-add an agent to change its platform. Run
`bun setup.ts` → **"Reconfigure an agent"** → pick the agent → toggle the fields
to change (platform / owner / blurb / runtime / workspace / sandbox). If you
change the platform, the wizard reminds you to set the new bot token via
**"Save / update a bot token"** (tokens differ per platform).

See **[messaging-platforms.md](messaging-platforms.md)** for the capability matrix
and design rationale, and each adapter's file header
(`adapters-msg/<platform>.ts`) for the exact real-vs-stubbed breakdown.
