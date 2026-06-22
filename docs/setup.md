# Set up knock-knock, step by step

This is the front door. It takes you from nothing to a working setup — your
coding agent answering in a chat channel — and then to the thing knock-knock is
actually for: **your agent and a teammate's agent collaborating in one group
chat, while every action on each machine stays under its owner's control.**

It's written to be followed top to bottom the first time, then skimmed later.
Each step links to a deeper reference when you want the full detail.

**This guide covers:**

1. [The model in four words](#1-the-model-in-four-words) — agent, owner, room, peer
2. [Prerequisites](#2-prerequisites)
3. [Quickstart: from zero to a reply](#3-quickstart-from-zero-to-a-reply) — the three-command path
4. [Connect your chat platform](#4-connect-your-chat-platform) — Discord in full, plus Slack / Telegram / WhatsApp / iMessage
5. [Choose the coding agent behind the bot](#5-choose-the-coding-agent-behind-the-bot) — the runtime
6. [Decide what the agent may do](#6-decide-what-the-agent-may-do) — presets and the deny floor
7. [Say hello, then verify](#7-say-hello-then-verify) — the T1 / T2 / T3 check
8. [Add a teammate's agent](#8-add-a-teammates-agent) — the group-chat payoff
9. [Going further](#9-going-further) — cross-machine, session sharing, watches
10. [Troubleshooting](#10-troubleshooting)
11. [Where to go deeper](#11-where-to-go-deeper)

---

## 1. The model in four words

Four terms carry the whole system. Learn these and the rest of the setup reads
plainly.

| Term | What it is |
|------|------------|
| **Agent** | One bot identity the relay runs: its messaging token, its coding runtime (Claude Code, OpenCode, …), its workspace folder, and its rooms. You can run several at once. |
| **Owner** | The human who controls an agent. Approvals for that agent go to its owner, and only the owner can approve, stop, or resolve conflicts. |
| **Room** | The parent channel an agent serves. The room owns the permission profile, the roster, and the allowlist. |
| **Peer** | Another person's agent in the same room. Agents address each other by name with an `@mention`. |

One more distinction worth internalizing now: a **room** is the parent channel;
a **scope** is a single task inside it. A top-level `@mention` opens a **task
thread** (its own scope) so each task stays tidy, but the permission profile
always lives on the room. A threaded task is governed by exactly the same rules
as a top-level one. (Full rationale:
[knock-knock-ledger-model.md](knock-knock-ledger-model.md).)

Everything you configure below — tokens, ids, permissions — hangs off these four
nouns.

---

## 2. Prerequisites

- **[Bun](https://bun.sh)** installed. Check with `bun --version`; if that fails:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **A chat platform you can add a bot to.** Discord is the production-tested path
  and the rest of this guide assumes it unless a section says otherwise.
- **A coding-agent runtime.** The default (`claude-sdk`) needs only an
  `ANTHROPIC_API_KEY` or an existing `claude` login — nothing to install. Other
  runtimes are covered in [step 5](#5-choose-the-coding-agent-behind-the-bot).

knock-knock has **no `config.json` you hand-edit.** Everything lives under
`~/.claude/channels/knock-knock/` and is written for you by the setup CLI:

| File | Holds | Written by |
|------|-------|------------|
| `access.json` | agents, rooms, peers, humans | `bun setup.ts` only |
| `.env` | bot tokens and secrets | `bun setup.ts` (or you) |
| `settings.json` | ledger backend, presets | `bun setup.ts` |
| `ledger.sqlite` | the interaction log | the relay |

`access.json` and the permission profiles are written **only** from your
terminal, never from a chat message — so nothing anyone says in the room can
change who's allowed or what they may do.

---

## 3. Quickstart: from zero to a reply

The fastest path to seeing it work, solo, on Discord. Three commands and a few
answers.

> **Step 1 — Get the relay**
> Clone your knock-knock checkout, then install dependencies:
> ```bash
> cd knock-knock
> bun install
> ```

> **Step 2 — Run the setup wizard**
> ```bash
> bun setup.ts
> ```
> On first run it walks you through one agent end to end with arrow-key menus and
> masked token input: **agent identity → coding runtime → sandbox? → room →
> permission preset → bot token → ledger backend.** It writes `access.json` and
> `.env` for you. (You'll need a Discord bot token and a couple of IDs first —
> [step 4](#4-connect-your-chat-platform) shows exactly how to get them.)

> **Step 3 — Start the relay**
> ```bash
> bun relay.ts
> ```
> You'll see `relay [your-agent]: connected as your-bot#1234`. Now `@mention` the
> bot in your room and say hello.

After the first agent exists, re-running `bun setup.ts` opens an **action menu**
instead of the wizard — that's where you add more agents, rooms, peers, humans,
or update a token later.

If you want to feel the flow before creating a real bot, skip ahead to
[step 7](#7-say-hello-then-verify) to see what a first conversation looks like.

---

## 4. Connect your chat platform

Pick the platform you'll use. **Discord is fully walked through here.** The
others have their own complete reference — the essentials are below with a link
to the full steps (app manifests, limits, troubleshooting).

| Platform | Status | Full steps |
|----------|--------|-----------|
| **Discord** | ✅ production-tested | inline below |
| Slack | ⚠️ experimental | [messaging-platform-setup.md](messaging-platform-setup.md) → Slack |
| Telegram | ⚠️ experimental | [messaging-platform-setup.md](messaging-platform-setup.md) → Telegram |
| WhatsApp | ⚠️ experimental | [messaging-platform-setup.md](messaging-platform-setup.md) → WhatsApp |
| iMessage | ⚠️ experimental | [messaging-platform-setup.md](messaging-platform-setup.md) → iMessage |

> **Experimental** means implemented and type-checked, not yet live-verified
> end to end. `bun setup.ts` makes you confirm before picking one, and the relay
> warns at boot. Verify with a test account before relying on it.

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
> live Workbench is a pinned message.)

> **Step 4 — Collect three values for setup**
> - **Your Discord user ID** (you're the owner): right-click yourself → Copy User ID.
> - **The room's channel ID**: right-click the channel → Copy Channel ID.
> - **The bot token** from step 1.

> **Step 5 — Configure and run**
> ```bash
> bun setup.ts        # platform → Discord (the default); paste the three values
> bun relay.ts
> ```

**How it behaves:** a top-level `@mention` spawns a task thread; replies in that
thread continue the task. Status shows as quiet emoji reactions (👀 working → 🏁
done / ⚠️ failed). Approvals and conflict choices are buttons. The owner gets a
DM when a draft is overridden.

### The other platforms, in one breath

You still run `bun setup.ts` (pick the platform when asked) and `bun relay.ts`.
What differs per platform is **how you create the bot, which tokens you need, and
the shape of the owner / room IDs**:

- **Slack** — create an app **from the manifest** in the reference; needs **two**
  tokens, a bot token (`xoxb-`) and an app-level token (`xapp-`) for Socket Mode
  (no public URL). Owner is a `U…` id, room is a `C…` channel id. The one trap:
  without `channels:history` / `groups:history` scopes **and** the matching
  `message.*` events, Slack silently drops every message.
- **Telegram** — one bot from **@BotFather**, one token. Set **privacy mode** to
  decide whether it reads non-mention group messages. Owner is your numeric user
  id; group room ids are **negative** (`-100…`).
- **WhatsApp** — the heaviest: a Meta app, a phone number, and a **public webhook
  URL** (a tunnel like `cloudflared` or `ngrok`). Mind the 24-hour messaging
  window.
- **iMessage** — macOS only, **no token**. Grant **Full Disk Access** and
  **Automation**; the room is a chat GUID from `chat.db`. Text-only, so every
  interactive flow falls back to a numbered menu.

Full step-by-step for each (manifests, env vars, limits, troubleshooting) lives
in **[messaging-platform-setup.md](messaging-platform-setup.md)**; the
architecture and capability matrix are in
**[messaging-platforms.md](messaging-platforms.md)**.

---

## 5. Choose the coding agent behind the bot

The bot is just the face. Behind it, the relay can drive any of these coding
agents — chosen by the agent's **`runtime`** field in `bun setup.ts`, no code
changes:

| `runtime` | Agent | Notes |
|-----------|-------|-------|
| `claude-sdk` | Claude Code, in-process | **Default.** Nothing to install; enforces the deny floor natively. |
| `claude-acp` | Claude Code, over ACP | Sandboxable at the OS level. |
| `opencode` | OpenCode | `brew install sst/tap/opencode`, then set it to ask before tools. |
| `codex` | OpenAI Codex | Needs `OPENAI_API_KEY`; don't launch it in a bypass mode. |
| `gemini` | Gemini CLI | `gemini --experimental-acp`. |
| `acp` | any ACP agent | You set the spawn command (`KNOCK_KNOCK_ACP_COMMAND`). |

> **The one thing that matters: ask-first.** The deny floor only holds if the
> agent **asks before running a tool.** Claude Code does this by default. For
> other runtimes, make sure they run in their normal ask-first mode (never a
> "yolo" / auto-approve mode) — or turn on the **OS sandbox** in setup, which
> doesn't depend on the agent cooperating.

Per-agent install and auth (including the OpenCode `permission` config and the
sandbox details) are in
**[getting-started-agents.md](getting-started-agents.md)**.

---

## 6. Decide what the agent may do

In `bun setup.ts`, each room gets a **preset** — a named permission profile.
Every tool the agent reaches for is checked against it, with one rule: **deny
beats ask beats allow.**

| Preset | Reads | Edits & writes | Shell | Good for |
|--------|-------|----------------|-------|----------|
| **strict** | allow | deny | deny | untrusted peers, read-only research |
| **ask-per-edit** | allow | ask | ask | day-to-day work (recommended start) |
| **auto** | allow | allow | ask | trusted solo flow |
| **bypass** + sandbox | allow | allow | allow | unattended runs you review after |

Two things hold no matter which preset you pick:

- **The deny floor is always on.** Destructive shell (`rm -rf`, `sudo`) and
  writes to sensitive paths (`~/.ssh`) are blocked even under `bypass`, checked
  against the real command so they can't be smuggled past in a chain.
- **You can give peers less than yourself.** Per-actor **tiers** let a peer's
  agent run read-only while you keep full access. Deny is always the union, so a
  tier can only tighten.

The friendly, complete walkthrough (presets, tiers, the OS sandbox, and the
prompt-injection invariant) is in
**[security-and-permissions.md](security-and-permissions.md)**.

---

## 7. Say hello, then verify

With the relay running and a room on **ask-per-edit**, `@mention` your bot. Then
run this three-line acceptance test to confirm each tier works:

- **T1 — Auto:** "what files are in the working directory?" → answered
  immediately, **no** prompt. *(Read is allowed.)*
- **T2 — Gated:** "run `echo hello`" → an **Allow / Deny** prompt appears
  mentioning you, the owner; a non-owner tapping Allow is rejected. *(Gated.)*
- **T3 — Hard deny:** "delete everything with `rm -rf`" → **blocked, no prompt
  ever appears**; the command never runs. *(The floor.)*

Run the relay with `KNOCK_KNOCK_DEBUG=1` to log every permission decision
(`[acp] permission: … → allow|ask|deny`) if you want to watch the floor work.

---

## 8. Add a teammate's agent

This is the point of knock-knock: two people, two machines, two agents, one room.
Each person does steps 4–6 on their **own** machine (own bot token, own
workspace, own permission preset), joins the **same** channel, and registers the
other as a peer.

> **Step 1 — Both join one channel**
> Invite both bots to the same shared server and channel. That channel is the
> **room** both agents serve.

> **Step 2 — Exchange bot user IDs**
> Each person copies their bot's user ID and sends it to the other (right-click
> the bot → Copy User ID on Discord).

> **Step 3 — Register each other as peers**
> ```bash
> bun setup.ts        # → "Register a peer bot" → paste the other bot's id + a short blurb
> ```
> The blurb (e.g. "hosts the vLLM box") is what your agent sees in the roster, so
> it knows who to `@mention` for what.

> **Step 4 — Both launch**
> ```bash
> bun relay.ts
> ```
> Now in the channel, one agent can `@mention` the other with a request. A task
> thread opens, the other agent works in **its** workspace under **its** owner's
> rules, and anything that changes that machine waits for **that** owner's Allow.

What you get for free once two agents share a room: each agent knows the roster
and addresses peers by name; tasks run in isolated threads with a live Workbench;
approvals go to the right owner; and a **loop guard** stops two bots from
ping-ponging forever (after 4 agent-to-agent turns it pauses until a human
speaks). The full list is in
[getting-started-agents.md#multi-agent-collaboration](getting-started-agents.md#multi-agent-collaboration).

> **Same machine, two agents?** You don't need two computers to try this. One
> relay can host several agents at once — re-run `bun setup.ts`, add a second
> agent with its own token and workspace, register the two as peers, and a single
> `bun relay.ts` connects both.

---

## 9. Going further

Once the basics work, these are the features worth knowing about. Each has a
dedicated guide.

- **Work across two machines (shared ledger).** By default each relay keeps a
  local SQLite ledger, so two relays only see each other through the chat. To
  share ledger state (imported session context, cross-machine conflict
  detection, collaborative file edits), point **every** relay at one shared
  **Postgres**: `bun setup.ts → "Choose ledger backend" → Remote (Postgres)`.
  Setup and the Neon walkthrough:
  [getting-started-agents.md#cross-machine-setup-shared-postgres-ledger](getting-started-agents.md#cross-machine-setup-shared-postgres-ledger).
- **Session sharing** 📥 — start a teammate's agent from the plan and decisions
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
| Bot shows offline | Token wrong or not loaded. Re-run `bun setup.ts → "Save / update a bot token"` and check `.env`. |
| Bot is silent | On Discord, MESSAGE CONTENT INTENT is off, the bot isn't in the channel, or the room requires an `@mention` and you didn't mention it. |
| Empty message text (Discord) | MESSAGE CONTENT INTENT not enabled. |
| Agent skipped at startup (`agent "x" skipped`) | Its `tokenEnv` isn't set in `.env`, or its `workspace` is empty. Re-run setup. |
| No approval prompt appears | The room's owner / approver id isn't set. Re-run `bun setup.ts` and reconfigure the room. |
| `rm -rf` ran anyway (ACP runtime) | The agent isn't asking before tools. Put it in ask-first mode, or turn on the OS sandbox. See [the deny-floor caveat](getting-started-agents.md). |
| Slack posts but no inbound | Missing `*:history` scopes + `message.*` events, or Socket Mode token missing. Reinstall after adding scopes. |
| Cross-machine state not syncing | Both relays must point at the **same** Postgres (direct endpoint, not a pooled one). |

Per-platform troubleshooting tables are in
[messaging-platform-setup.md](messaging-platform-setup.md).

---

## 11. Where to go deeper

| Guide | When to read it |
|-------|-----------------|
| [Messaging platform setup](messaging-platform-setup.md) | Full per-platform steps: Slack manifest, tokens, IDs, limits, troubleshooting |
| [Messaging platforms (architecture)](messaging-platforms.md) | The `MessagingAdapter` seam and the cross-platform capability matrix |
| [Getting started with different agents](getting-started-agents.md) | Per-runtime install/auth, multi-agent collaboration, cross-machine, the deny-floor caveat |
| [Permissions & security](security-and-permissions.md) | Presets, per-peer tiers, the deny floor, OS sandbox, prompt-injection invariant |
| [Session sharing](session-sharing.md) | Importing or resuming a local coding session into a channel |
| [Watches](knock-knock-watches.md) | Deferring a turn until the world changes |
| [Reactions, conflicts & versioning](reactions-and-versioning.md) | The reaction vocabulary, conflict cards, ledger versioning |
| [Ledger model](knock-knock-ledger-model.md) | The architecture: interactions, folds, room vs scope |
