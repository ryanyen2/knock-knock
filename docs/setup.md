# Set up knock-knock, step by step

This is the front door. It takes you from nothing to a working setup — your
coding agent answering in a chat channel — and then to the thing knock-knock is
actually for: **your bot and a teammate's bot collaborating in one group chat,
while every action on each machine stays under its owner's control.**

It's written to be followed top to bottom the first time, then skimmed later.
Each step links to a deeper reference when you want the full detail.

**This guide covers:**

1. [The model in five words](#1-the-model-in-five-words) — bot, channel, membership, roster, owner
2. [Prerequisites](#2-prerequisites)
3. [Quickstart: from zero to a reply](#3-quickstart-from-zero-to-a-reply) — the three-command path
4. [Connect your chat platform](#4-connect-your-chat-platform) — Discord, the live surface
5. [Choose the coding agent behind the bot](#5-choose-the-coding-agent-behind-the-bot) — the runtime
6. [Decide what the bot may do](#6-decide-what-the-bot-may-do) — presets and the deny floor
7. [Say hello, then verify](#7-say-hello-then-verify) — the T1 / T2 / T3 check
8. [Add a teammate's bot](#8-add-a-teammates-bot) — the group-chat payoff
9. [Going further](#9-going-further) — cross-machine, session sharing, watches
10. [Troubleshooting](#10-troubleshooting)
11. [Where to go deeper](#11-where-to-go-deeper)

---

## 1. The model in five words

Five terms carry the whole system. Learn these and the rest of the setup reads
plainly.

| Term | What it is |
|------|------------|
| **Bot** | One coding-agent identity you run = one Discord app you created, holding a token locally. Its name and avatar live **on the platform** and are fetched on connect — never typed. Has a runtime (Claude Code, OpenCode, …). You can run several at once. |
| **Channel** | A platform channel = **a project = a permission boundary**. It's the thing a bot is "invited" to. Keyed globally as `${platform}:${channelId}` so two platforms never collide. |
| **Membership** | One of *your* bots active in one channel. This is the permission boundary itself: it carries that bot's **workspace folder** and its **allow/ask/deny profile** *for that project*. The same bot can have a read-only workspace in one channel and a read-write one in another. |
| **Roster** | Your local address-book of **people** (human collaborators) and **peers** (other people's bots), each entered **once** and then picked from a list. No re-pasting IDs. |
| **Owner / me** | You, the human running this relay. Identified by one user id per platform (`me.discord`), entered **once** and reused as the owner of every bot. Approvals go to the owner, and only the owner can approve, stop, or resolve conflicts. |

One more distinction worth internalizing now: a **channel** is the project (and
the permission boundary); a **thread** is a single **task** inside it. A
top-level `@mention` opens a task thread so each task stays tidy, but the
workspace and permission profile always come from the **membership** on the
parent channel. A threaded task is governed by exactly the same rules as a
top-level one. (Full rationale:
[knock-knock-ledger-model.md](knock-knock-ledger-model.md).)

Everything you configure below — tokens, ids, permissions — hangs off these
nouns. The config is **normalized**: bots, channels, and the roster are sibling
tables, and a channel references bots and roster entries by id.

---

## 2. Prerequisites

- **macOS or Linux.** The prebuilt `knock-knock` CLI (installed in
  [step 1](#3-quickstart-from-zero-to-a-reply)) embeds the Bun runtime, so there
  is nothing else to install. **[Bun](https://bun.sh)** (`curl -fsSL
  https://bun.sh/install | bash`) is needed *only* if you install via npm or run
  from a source checkout.
- **A Discord account and a server you can add a bot to.** Discord is the live
  messaging platform this guide uses throughout.
- **A coding-agent runtime.** The default (`claude-sdk`) needs only an
  `ANTHROPIC_API_KEY` or an existing `claude` login — nothing to install. Other
  runtimes are covered in [step 5](#5-choose-the-coding-agent-behind-the-bot).

knock-knock has **no `config.json` you hand-edit.** Everything lives under
`~/.knock-knock/` and is written for you by the setup CLI:

| File | Holds | Written by |
|------|-------|------------|
| `access.json` | `me` (owner per platform), `bots`, `channels` (with each member's workspace + permission profile), `roster` (people + peers) | `knock-knock setup` only |
| `.env` | bot tokens and secrets | `knock-knock setup` (or you) |
| `settings.json` | ledger backend, presets | `knock-knock setup` |
| `ledger.sqlite` | the interaction log | the relay |

`access.json` (including the inline permission profiles) is written **only** from
your terminal, never from a chat message — so nothing anyone says in the channel
can change who's allowed or what they may do.

### Where does the `.env` go? (set it once)

**One global file: `~/.knock-knock/.env`** — *not* per-project and *not* tied to the
folder you run from. You set it up **once**; every bot, every channel, and every
`knock-knock relay` (launched from any directory) reads the same file. You never re-enter
env vars when you add a channel or start from a different folder.

It holds two kinds of secret, both managed by `knock-knock setup`:

- **Bot tokens** — one per bot (e.g. `DISCORD_BOT_TOKEN`), via "Manage a bot → Save / update token".
- **Coding-agent API keys** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, via "Save a
  coding-agent API key". A key is **shared across every bot using that agent**, so you
  enter `ANTHROPIC_API_KEY` once no matter how many Claude bots you run. Agents that use
  their own login (`gemini`, `opencode`) need no key here at all.

The setup dashboard shows a **CODING-AGENT AUTH** panel with a ✓/✗ per key so you can
see at a glance what's set. The bot's **workspace** (the project folder it edits) is a
*separate* per-channel path you choose in setup — it has nothing to do with where the
`.env` lives. Relocate the whole state dir with `KNOCK_KNOCK_STATE_DIR` if you must.

---

## 3. Quickstart: from zero to a reply

The fastest path to seeing it work, solo, on Discord. Three commands and a few
answers.

> **Step 1 — Install knock-knock**
> One CLI with the Bun runtime embedded — nothing else to install:
> ```bash
> brew install ryanyen2/tap/knock-knock
> ```
> No Homebrew? The install script (macOS & Linux, verifies the checksum):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/ryanyen2/knock-knock/main/packaging/install.sh | bash
> ```
> Also available: a `.deb` on the [Releases](https://github.com/ryanyen2/knock-knock/releases)
> page, `npm install -g knock-knock` (needs Bun), or from source
> (`git clone https://github.com/ryanyen2/knock-knock && cd knock-knock && bun install`).

> **Step 2 — Run the setup wizard**
> ```bash
> knock-knock setup
> ```
> On first run it walks you through one bot and a channel for it to work in,
> with arrow-key menus and masked token input: **bot (platform → optional default
> coding agent) → channel (paste id → pick member bots → set each
> bot's workspace + permission preset → add collaborators from your roster) → bot
> token → ledger backend.** Your owner id is asked once per platform; the bot's
> name is fetched from the platform on connect, never typed. The coding agent is
> just a **default** — you can skip it (Claude Code is used), set it per channel,
> switch it live in chat with `!config agent`, or override it at launch with
> `--config`. It writes `access.json` and `.env` for you. (You'll need a Discord
> bot token and a couple of IDs first — [step 4](#4-connect-your-chat-platform)
> shows exactly how to get them.)

> **Step 3 — Start the relay**
> ```bash
> knock-knock relay
> ```
> The relay prints a **"who's listening where"** table — each bot, the channels
> it's a member of, and the workspace it uses there — then `connected as
> your-bot#1234`. (If two of your bots claim the same channel, it flags that at
> startup rather than picking one silently.) Now `@mention` the bot in your
> channel and say hello.
>
> **Optional launch flags** (combine freely):
> - `--pick` — choose which configured bots to start (interactive checklist).
> - `--config` / `-c` — a quick per-bot setup at launch: coding agent, model,
>   thinking, effort, and which local sessions to share as context. Seeded before
>   the bots connect, so the first turn already uses them.
> - `--tui` — a multi-pane view, one pane per active bot, instead of the single
>   combined log (falls back to the plain log when not a terminal).
> - `--daemon` / `--wake` — connect **every** configured bot, but keep the ones you
>   didn't pick **idle** (listening, spun down) until their first message wakes
>   them. See [idle-wake.md](idle-wake.md).

After the first bot exists, re-running `knock-knock setup` opens a **status
dashboard + action menu** instead of the wizard — a compact map of your bots,
channels, and roster. The main action is **"Manage a bot"**: pick a bot and edit
everything about it in one place — rename its key, set the owner id, save its
token, add/remove it from channels (with each channel's workspace, preset, and
collaborators), and set its default coding agent / blurb. The other
actions add/edit a channel directly, manage the roster, save a coding-agent API
key, or choose the ledger backend.

If you want to feel the flow before creating a real bot, skip ahead to
[step 7](#7-say-hello-then-verify) to see what a first conversation looks like.

---

## 4. Connect your chat platform

Discord is the live messaging surface, and it's fully walked through below. The
chat layer sits behind one platform-neutral `MessagingAdapter` seam
(`adapters-msg/`), so another platform is one new adapter file away — but there
is no live adapter for one today.

### Discord (the default path)

**Prerequisites:** a Discord server you can manage, and **Developer Mode** on
(**Settings → Advanced → Developer Mode**) so you can copy IDs.

> **Step 1 — Create the application and bot**
> Go to [discord.com/developers/applications](https://discord.com/developers/applications)
> → **New Application** → name it. Open the **Bot** tab → **Reset Token** → copy
> it. It's shown only once. This is your bot token.

> **Step 2 — Enable the message-content intent**
> **Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.** It's the
> only privileged toggle you need. Without it the bot connects but reads empty
> message text.

> **Step 3 — Invite the bot to your server**
> **OAuth2 → URL Generator** → scope **`bot`** → enable these bot permissions:
> View Channels · Send Messages · Send Messages in Threads · Create Public
> Threads · Read Message History · Add Reactions · Manage Messages.
> Open the generated URL and add the bot to your server.
> (Threads and Manage Messages matter: each task runs in its own thread, and the
> config card / Workbench are pinned messages.)

> **Step 4 — Collect three values for setup**
> - **Your Discord user ID** (you're the owner): right-click yourself → Copy User ID. Asked once.
> - **The channel ID** of the project channel: right-click the channel → Copy Channel ID.
> - **The bot token** from step 1.

> **Step 5 — Configure and run**
> ```bash
> knock-knock setup        # bot → channel (paste id, pick this bot as a member, set its workspace + preset) → token
> knock-knock relay
> ```

**How it behaves:** a top-level `@mention` spawns a task thread; replies in that
thread continue the task. Status shows as quiet emoji reactions (👀 working → 🏁
done / ⚠️ failed). Approvals and conflict choices are buttons. The owner gets a
DM when a draft is overridden.

### Another platform?

Discord is the only live messaging platform. The chat layer is isolated behind a
platform-neutral `MessagingAdapter` interface (`adapters-msg/`), so adding
another platform means writing one new adapter against that seam and a branch in
its factory — the relay, the ledger, and the permission model never change.

---

## 5. Choose the coding agent behind the bot

The bot is just the face — the coding agent behind it is **not** part of the bot's
identity. Set a **default** in `knock-knock setup`, then change it freely without
touching code: per channel (a membership override), live in chat with the owner
command `!config agent <runtime>` (rebuilds the session on the next turn), or at
launch with `knock-knock relay --config`. The relay can drive any of these:

| `runtime` | Agent | Notes |
|-----------|-------|-------|
| `claude-sdk` | Claude Code, in-process | **Default.** Nothing to install; enforces the deny floor natively. |
| `claude-acp` | Claude Code, over ACP | Runs out-of-process over ACP. |
| `opencode` | OpenCode | `brew install sst/tap/opencode`, then set it to ask before tools. |
| `codex` | OpenAI Codex | Needs `OPENAI_API_KEY`; don't launch it in a bypass mode. |
| `gemini` | Gemini CLI | `gemini --experimental-acp`. |
| `acp` | any ACP agent | You set the spawn command (`KNOCK_KNOCK_ACP_COMMAND`). |

> **The one thing that matters: ask-first.** The deny floor only holds if the
> agent **asks before running a tool.** Claude Code does this by default. For
> other runtimes, make sure they run in their normal ask-first mode (never a
> "yolo" / auto-approve mode).

Per-agent install and auth (including the OpenCode `permission` config) are in
**[getting-started-agents.md](getting-started-agents.md)**.

---

## 6. Decide what the bot may do

In `knock-knock setup`, each **membership** (a bot in a channel) gets a **preset** — a
named permission profile, expanded inline into that membership's allow/ask/deny.
Every tool the bot reaches for is checked against it, with one rule: **deny beats
ask beats allow.** Because the profile lives on the membership, the same bot can
be `strict` in one channel and `auto` in another.

| Preset | Reads | Edits & writes | Shell | Good for |
|--------|-------|----------------|-------|----------|
| **strict** | allow | deny | deny | untrusted peers, read-only research |
| **ask-per-edit** | allow | ask | ask | day-to-day work (recommended start) |
| **auto** | allow | allow | ask | trusted solo flow |
| **bypass** | allow | allow | allow | unattended runs you review after (deny floor still holds) |

Two things hold no matter which preset you pick:

- **The deny floor is always on.** Destructive shell (`rm -rf`, `sudo`) and
  writes to sensitive paths (`~/.ssh`) are blocked even under `bypass`, checked
  against the real command so they can't be smuggled past in a chain.
- **You can give peers less than yourself.** Per-actor **tiers** let a peer's
  bot run read-only while you keep full access. Deny is always the union, so a
  tier can only tighten.

The friendly, complete walkthrough (presets, tiers, and the
prompt-injection invariant) is in
**[security-and-permissions.md](security-and-permissions.md)**.

---

## 7. Say hello, then verify

With the relay running and your bot a member of a channel on **ask-per-edit**,
`@mention` it. Then run this three-line acceptance test to confirm each tier
works:

- **T1 — Auto:** "what files are in the working directory?" → answered
  immediately, **no** prompt. *(Read is allowed.)*
- **T2 — Gated:** "run `echo hello`" → an **Allow / Deny** prompt appears
  mentioning you, the owner; a non-owner tapping Allow is rejected. *(Gated.)*
- **T3 — Hard deny:** "delete everything with `rm -rf`" → **blocked, no prompt
  ever appears**; the command never runs. *(The floor.)*

Run the relay with `KNOCK_KNOCK_DEBUG=1` to log every permission decision
(`[acp] permission: … → allow|ask|deny`) if you want to watch the floor work.

---

## 8. Add a teammate's bot

This is the point of knock-knock: two people, two machines, two bots, one
channel. Each person does steps 4–6 on their **own** machine (own bot token, own
membership: own workspace + permission preset), joins the **same** channel, and
adds the other to their roster as a peer.

> **Step 1 — Both join one channel**
> Invite both bots to the same shared server and channel. That channel is the
> **project** both bots are members of.

> **Step 2 — Exchange bot user IDs**
> Each person copies their bot's user ID and sends it to the other (right-click
> the bot → Copy User ID on Discord).

> **Step 3 — Add each other as peers, then as channel collaborators**
> ```bash
> knock-knock setup        # "Add a peer bot to the roster" → paste the other bot's id + a short blurb
>                     # then "Add / edit a channel" → add that peer as a collaborator (picked from the roster)
> ```
> The blurb (e.g. "hosts the vLLM box") is what your bot sees in the roster, so
> it knows who to `@mention` for what. Entered once; pick from the list for any
> future channel.

> **Step 4 — Both launch**
> ```bash
> knock-knock relay
> ```
> Now in the channel, one bot can `@mention` the other with a request. A task
> thread opens, the other bot works in **its** membership's workspace under
> **its** owner's rules, and anything that changes that machine waits for
> **that** owner's Allow.

What you get for free once two bots share a channel: each bot knows the roster
and addresses peers by name; tasks run in isolated threads with a live Workbench;
approvals go to the right owner; and a **loop guard** stops two bots from
ping-ponging forever (after 4 bot-to-bot turns it pauses until a human speaks).
The full list is in
[getting-started-agents.md#multi-agent-collaboration](getting-started-agents.md#multi-agent-collaboration).

> **Same machine, two bots?** You don't need two computers to try this. One
> relay can host several bots at once — re-run `knock-knock setup`, add a second bot
> with its own token, make both members of the channel (each with its own
> workspace + preset), and a single `knock-knock relay` connects both. With more than
> one of your bots in a channel, an `@mention` routes to the named bot; an
> un-mentioned top-level message isn't auto-answered by everyone.

---

## 9. Going further

Once the basics work, these are the features worth knowing about. Each has a
dedicated guide.

- **Work across two machines (shared ledger).** By default each relay keeps a
  local SQLite ledger, so two relays only see each other through the chat. To
  share ledger state (imported session context, cross-machine conflict
  detection, collaborative file edits), point **every** relay at one shared
  **Postgres** via `KNOCK_KNOCK_LEDGER_URL` (or a `ledger` block in
  `settings.json`). Cross-machine walkthrough:
  [getting-started-agents.md#cross-machine-setup-shared-postgres-ledger](getting-started-agents.md#cross-machine-setup-shared-postgres-ledger).
- **Per-task tuning (owner, in-thread)** — `!config role <text>`, model, thinking,
  effort, coding agent (`!config agent <runtime>`), and permission mode are tunable
  per thread on top of the channel default. `!config help` lists them.
- **Run a subset, wake the rest (daemon)** — `knock-knock relay --pick --daemon`
  starts only the bots you choose, keeping the others connected-but-idle so they
  wake on their first message. Add `--tui` for one pane per bot, `--config` to set
  each bot's agent/model/effort at launch. [idle-wake.md](idle-wake.md).
- **Session sharing** 📥 — start a teammate's bot from the plan and decisions
  in one of your local coding sessions instead of cold. Run `share session`
  inside the task thread. [session-sharing.md](session-sharing.md).
- **Watches** ⏳ — let a turn defer and be resumed by the world: a file changing,
  a job finishing, a deadline passing. [knock-knock-watches.md](knock-knock-watches.md).
- **Reactions, conflicts & versioning** — the reaction vocabulary, equal-role
  conflict cards, and how the append-only ledger versions every action.
  [reactions-and-versioning.md](reactions-and-versioning.md).

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bot shows offline | Token wrong or not loaded. Re-run `knock-knock setup → "Manage a bot" → Save / update token` and check `.env`. |
| Bot is silent | On Discord, MESSAGE CONTENT INTENT is off, the bot isn't in the channel, or the channel requires an `@mention` and you didn't mention it. |
| Empty message text (Discord) | MESSAGE CONTENT INTENT not enabled. |
| Bot not in the "who's listening where" table at startup | Its `tokenEnv` isn't set in `.env`, or it isn't a **member** of any channel. Re-run setup, save its token, and add it to a channel. |
| Two of your bots flagged on the same channel | Legal but ambiguous — an `@mention` routes to the named bot, and a thread continuation stays with the bot that owns it. Give each a distinct role or drop one from the channel. |
| No approval prompt appears | The owner id (`me`) for that platform isn't set, or the channel's `approvalActorId` override is wrong. Re-run `knock-knock setup`. |
| `rm -rf` ran anyway (ACP runtime) | The agent isn't asking before tools. Put it in ask-first mode (never yolo/bypass). See [the deny-floor caveat](getting-started-agents.md). |
| Cross-machine state not syncing | Both relays must point at the **same** Postgres (direct endpoint, not a pooled one). |

---

## 11. Where to go deeper

| Guide | When to read it |
|-------|-----------------|
| [Getting started with different agents](getting-started-agents.md) | Per-runtime install/auth, multi-agent collaboration, cross-machine, the deny-floor caveat |
| [Permissions & security](security-and-permissions.md) | Presets, per-peer tiers, the deny floor, prompt-injection invariant |
| [Session sharing](session-sharing.md) | Importing or resuming a local coding session into a channel |
| [Daemon & wake-on-message](idle-wake.md) | Running a subset of bots active and waking idle ones on demand; the `--pick`/`--config`/`--tui`/`--daemon` launch flags |
| [Watches](knock-knock-watches.md) | Deferring a turn until the world changes |
| [Reactions, conflicts & versioning](reactions-and-versioning.md) | The reaction vocabulary, conflict cards, ledger versioning |
| [Ledger model](knock-knock-ledger-model.md) | The architecture: interactions, folds, channel vs scope |
