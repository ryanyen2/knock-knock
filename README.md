# knock-knock

**Agent Channels — your bots collaborate with other people's bots through shared Discord channels.**

Your bot and a collaborator's bot each run on your own machines, connected to the same Discord channel. They can ask each other questions, request work, and answer each other directly — while every action that touches your machine still goes through *your own* permission rules. Nobody hands anyone else control of their machine.

**The channel is the project — and the permission boundary.**

---

## How it works

The config is **channel-centric** and normalized into four nouns: a **bot** (one coding-agent identity you run = one Discord app), a **channel** (a platform channel = a project = a permission boundary), a **membership** (one of your bots active in one channel, carrying that bot's workspace folder + allow/ask/deny profile *for that project*), and a **roster** (people + peer bots you collaborate with, entered once and referenced by id). A **thread** is a single task inside a channel.

- Each person runs **one Discord bot per coding-agent identity** — that bot is your identity in the channel. One relay process can host several bots at once.
- Bots address each other by `@mention` in the shared channel.
- **Each task runs in its own thread.** A top-level `@mention` opens a Discord **thread** for that task; the bot does its work there, and the original message keeps a 🏁/⚠️ status reaction. The bot's workspace and permissions come from its **membership** on the parent channel; threads inherit them. So the channel stays a readable index of tasks, and each task has its own space, activity log, and agent session.
- **Routine reads flow automatically** — if answering only needs tools in the membership's `allow` list, the bot just answers.
- **Work requests are gated** — if a tool is in the `ask` list, an approval prompt posts *in the thread*, `@mention`ing the owner. The owner clicks **Allow / Deny** or reacts ✅ / ❌.
- **The `deny` list is a hard floor** — it is auto-rejected before the owner ever sees it, and cannot be reached even by an approved request. The floor lives on the membership, so a threaded task is governed by the same profile as a top-level one.

The relay is **agent-agnostic** and **multi-bot**: one process can host several bots at once, each with its own Discord token and runtime (Claude Code, OpenCode, Codex, Gemini, or any [ACP](https://agentclientprotocol.com) agent), and a per-channel workspace + profile via its memberships. See **[Getting started with different agents](docs/getting-started-agents.md)** for per-agent runtime setup, multi-agent collaboration, and the deny-floor caveat.

**Beyond request → reply, the relay adds three collaboration features:**

- **[Session sharing](docs/session-sharing.md)** 📥 — start from the plan/decisions in one of your local coding sessions, instead of cold. Import a distilled brief, or resume the live session.
- **[Watches](docs/knock-knock-watches.md)** ⏳ — let a turn *defer* and be resumed by the world: a file changing, a job finishing, a deadline passing. The relay owns the wait and re-prompts the agent when reality changes.
- **[Reactions, conflict resolution & version control](docs/reactions-and-versioning.md)** — the Discord reaction vocabulary, equal-role conflict cards, and how the append-only ledger versions every action (nothing deleted, only superseded; rewind/checkpoint the frontier).

**Locking down what an agent may touch** — presets, per-peer permission tiers, the hard deny floor, and OS-level sandboxing are all in **[Permissions & security](docs/security-and-permissions.md)** (start here for the friendly walkthrough).

> **Billing note:** Agent SDK usage draws from a separate monthly credit pool starting 2026-06-15. Check your Anthropic console for metering.

---

## Install

knock-knock ships as a single `knock-knock` CLI. The prebuilt binaries embed the
Bun runtime, so there is nothing else to install.

```bash
# Homebrew (macOS / Linux)
brew install ryanyen2/tap/knock-knock

# Linux / macOS — install script (latest release, verifies checksum)
curl -fsSL https://raw.githubusercontent.com/ryanyen2/knock-knock/main/packaging/install.sh | bash

# Ubuntu / Debian — .deb from the latest release
#   (download knock-knock_<version>_amd64.deb from the Releases page, then:)
sudo dpkg -i knock-knock_*_amd64.deb

# npm (requires Bun installed — the CLI runs under bun)
npm install -g knock-knock

# from source
git clone https://github.com/ryanyen2/knock-knock && cd knock-knock && bun install
```

Then:

```bash
knock-knock setup     # interactive: bot → channel (workspace + preset) → token
knock-knock relay     # start the relay (prints who's listening where)
```

`knock-knock` with no arguments runs setup the first time and the relay once a bot
is configured. From a source checkout, `bun cli.ts <cmd>` (or `bun setup.ts` /
`bun relay.ts`) work too.

## Prerequisites

- A Discord server (guild) that **both collaborators are members of**, with one channel to use as the project
- **Discord Developer Mode on** (User Settings → Advanced → Developer Mode) so you can copy IDs
- For the default `claude-sdk` runtime: `ANTHROPIC_API_KEY` set, or an existing `claude` login (`claude login`)
- Only for the npm install or a source checkout: [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`). The brew / install-script / `.deb` binaries need no runtime.

---

## Quick start

```bash
knock-knock setup             # interactive: bot → channel (workspace + preset) → token
knock-knock relay             # start the relay (prints who's listening where)
```

`knock-knock setup` walks you through everything with arrow-key menus and inline validation: a guided wizard on first run (bot → channel → token → ledger), then a status dashboard + action menu once a bot exists. Re-run it any time to add a bot, add/edit a channel, add a person or peer to the roster, or save a token. (From a source checkout, `bun setup.ts` is equivalent.)

> **Want a guided, top-to-bottom walkthrough?** The **[Setup guide](docs/setup.md)** takes you from zero to a running group chat step by step — platform setup, picking a runtime, choosing a permission preset, verifying it works, and adding a teammate's bot — linking into the deep docs as it goes. Start there if this is your first time.

---

# Production setup — two collaborators

This walkthrough uses two people, **Alice** and **Bob**, collaborating in a channel called `#project-x`. **Both** people do steps 1–7 on their own machines.

> **Another platform?** Discord is the live messaging surface. The chat layer sits behind one platform-neutral `MessagingAdapter` seam (`adapters-msg/`), so supporting another platform is one new adapter file — but there is no live adapter for one today.

## 1. Create your Discord bot

At [discord.com/developers/applications](https://discord.com/developers/applications):

1. **New Application** → name it (e.g. `alice-research-agent`).
2. **Bot** tab → **Reset Token** → copy and save it (shown only once). This is your bot token.
3. **Bot** tab → **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT**.
   *(This is the only privileged intent required. `GuildMessageReactions` — needed for ✅ approvals — is a standard intent and needs no toggle here.)*

## 2. Invite your bot to the shared server

1. **OAuth2 → URL Generator**.
2. Scopes: check **`bot`**.
3. Bot Permissions: **View Channels**, **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Read Message History**, **Add Reactions**. *(Threads permissions matter — each task runs in a thread the bot opens. Attach Files is not needed; the relay posts text replies directly. If the bot lacks thread permission it degrades gracefully and runs the task in the channel instead.)*
4. Copy the generated URL, open it, and add the bot to the shared server.

## 3. Note your bot's User ID

In Discord (Developer Mode on): find your bot in the member list → right-click → **Copy User ID**. You'll exchange this with your collaborator in step 5.

## 4. Configure your bot and channel, and save your token

You'll need the **channel ID** of `#project-x` (right-click the channel → **Copy Channel ID**) and **your own Discord user ID** (right-click yourself → **Copy User ID**).

```bash
knock-knock setup                  # guided wizard: bot → channel (workspace + preset) → token
```

The wizard asks for:

- **Bot key** — a short local nickname (e.g. `reviewer`). The bot's display name is fetched from Discord on connect, never typed.
- **Platform & runtime** — Discord (the production path), then the coding agent: arrow-key pick (`claude-sdk`, `claude-acp`, `opencode`, `codex`, `gemini`, or `acp`)
- **Sandbox** — optionally confine the bot's writes to its workspace / block network at the OS level (ACP runtimes; see [Permissions & security](docs/security-and-permissions.md))
- **Your Discord user ID** — the owner; approval prompts ping this ID. Asked **once per platform** (`me.discord`), then reused for every bot.
- **Channel ID** — the `#project-x` channel ID. A channel is the project = the permission boundary.
- **Members** — which of your bots work in this channel. For each, its **workspace** (the absolute path it works in *for this channel*) and a **permission preset** (strict / ask-per-edit / auto / bypass), expanded inline into the membership's `allow` / `ask` / `deny`.
- **Collaborators** — people and peer bots in this channel, picked from your **roster** (or "+ add new", which registers them once for reuse)
- **Bot token** — masked input; stored in `.env` under the bot's `tokenEnv`
- **Ledger backend** — local SQLite, or remote Postgres for cross-machine collaboration (recommended)

After the first run, re-run `knock-knock setup` to open the status dashboard + action menu: add a bot, add/edit a channel, add a person or peer to the roster, or save/update a token.

> **No bot name is asked for.** The bot's name is its live Discord username. To rename it, rename the bot in the Discord Developer Portal.

## 5. Exchange bot User IDs

Alice tells Bob her bot's User ID; Bob tells Alice his.

## 6. Add each other to the roster, then to the channel

```bash
knock-knock setup                  # "Add a peer bot to the roster" → then "Add / edit a channel"
```

Alice adds Bob's bot to her **roster** as a peer (id + a short blurb like `deploy specialist`), then adds it as a **collaborator** of `#project-x` (picked from the roster); Bob does the same with Alice's bot. The relay re-reads the access file on every inbound message, so this takes effect immediately — no restart.

## 7. Launch each bot

Everything the relay needs (runtime, per-channel workspace, profile, token) lives in `access.json` and `.env`, so just:

```bash
knock-knock relay
```

The relay prints a **"who's listening where"** table — each bot, its channels, and the workspace it uses in each — flagging any channel claimed by more than one of your bots, then `relay [<botKey>]: connected as <bot>#1234`.

Each membership's permission profile is stored **inline** in `access.json` under
the channel's `members` — no separate per-room file. A channel governs every task
thread spawned under it, so one profile covers the channel and all its threads.

The profile keeps the familiar `allow` / `ask` / `deny` shape (plus optional
per-actor `tiers`):

```jsonc
{
  "preset": "ask-per-edit",       // the preset this membership was stamped from
  "profile": {
    "allow": ["Read(**)"],        // auto-approved, no prompt
    "ask":   ["Bash(*)"],         // posts Allow/Deny buttons to Discord
    "deny":  ["Bash(rm -rf *)", "Bash(sudo *)"],  // hard floor, never runs

    // optional: narrow what a peer/human may do on this bot's behalf.
    // deny is always unioned with the base floor; a tier can only tighten.
    "tiers": { "agent": { "allow": ["Read(**)"], "ask": [], "deny": ["Edit(**)", "Write(**)", "Bash(*)"] } }
  }
}
```

You normally don't write this by hand — `knock-knock setup` picks a preset (and
optionally per-peer tiers) per membership for you. Full guide:
**[Permissions & security](docs/security-and-permissions.md)**.

---

# Acceptance test

Start the relay:

```bash
knock-knock relay
```

With the membership's profile configured as:

```jsonc
{ "allow": ["Read(**)"], "ask": ["Bash(*)"], "deny": ["Bash(rm -rf *)", "Bash(sudo *)"] }
```

### T1 — Auto (no approval)

`@mention` the bot: *"what files are in the working directory?"*

**Pass:** the bot opens a task thread and answers there immediately; no Allow/Deny prompt appears. `Read` is in the `allow` list.

### T2 — Gated (approval required)

`@mention` the bot: *"run the test suite"*

**Pass:** in the task thread, an Allow/Deny prompt appears mentioning the owner. A non-owner clicking Allow gets "Not authorized." The owner clicking Allow runs the command and the result is posted. (The deny floor is the membership's profile on the parent channel — the thread inherits it.)

### T3 — Hard deny floor

Ask the bot to do something on the `deny` list (e.g. *"delete everything with rm -rf"*).

**Pass:** the request is auto-rejected — no prompt ever appears and the tool never runs.

---

# Driving your agent from Discord

- **`@mention` to address it.** By default (`requireMention: true`) the bot only responds when mentioned or when someone replies to one of its messages.
- **Each task gets a thread.** A top-level `@mention` opens a Discord thread named from your prompt, and the whole task — the reply, tool steps, approvals, and the activity log — happens *in that thread*. Reply inside a thread to continue the same task. The original message keeps the 🏁/⚠️ status, so the channel reads as a task index. (Owner control commands like `!watch` and `share session` act in place and don't open a thread.)
- **Brevity.** The relay posts the agent's answer directly to the thread. Long responses are split at paragraph boundaries to stay under Discord's 2000-char limit.
- **Informative approvals.** Permission prompts show the tool name and an input preview — decide from your phone without opening the terminal.
- **Presence & outcome.** The bot reacts 👀 the moment it starts a turn, then swaps that for a persistent **🏁 done** or **⚠️ failed** reaction on your message when the turn ends — so you can scroll back and see at a glance which requests succeeded. (✅ / ❌ stay reserved for approvals.)
- **Stop a turn.** React **🛑** on a message while the bot is working and it aborts the in-flight turn promptly, posting a short "Stopped" note. Only the owner can stop.
- **Live "Workbench."** Each task thread gets one pinned message the relay edits in place as the turn runs — a per-agent activity log of the tool steps (`→ Terminal git status ✓`), with the current state as the last line. After the turn it stays put as the trace of what happened.
- **Attribution line.** A small italic line under each reply names the message and tool count it was traced from — the audit trail, surfaced.
- **Sessions persist per task.** The relay keeps an agent session per thread and resumes it on each turn, so a task retains its own context between messages without bleeding into other tasks.
- **Share or resume a local session** 📥 — start a task from the plan and decisions already in one of your local coding sessions (Claude Code, Codex, OpenCode, Gemini), instead of cold. Run `share session` *inside the task's thread*: `share session` imports a distilled context brief; `resume session` continues the live session. Owner-only. See **[Session sharing](docs/session-sharing.md)**.
- **Watches — defer and resume on events** ⏳ — an agent (or the owner via `!watch`) can register interest in something that happens *later* — a file changing, a job finishing, a script exiting, a deadline passing — and be re-prompted to act and post the instant it does, without holding a turn open. See **[Watches](docs/knock-knock-watches.md)**.

### Collaboration cues (multi-agent)

When two agents share a channel and edit the same thing, or you want to redirect a turn, the relay surfaces it instead of resolving silently — and because every action is recorded in an append-only ledger, **nothing is ever deleted, only superseded**:

- **Conflict card** 🔀 — two equal-role drafts at the same anchor → a **Take A / Take B / Write my own** card; only the owner resolves it, the loser is kept.
- **Override DM** 🔁 — a higher-role write overrides your agent's draft → a short DM telling you what changed.
- **Rewind reactions** — react on a bot message: **🔁 retry** re-runs the turn, **⏪ rewind** or **🧷 checkpoint** moves/pins the conversation frontier.

These cues, the full reaction/glyph vocabulary, conflict resolution, and how the relay versions every action live in **[Reactions, conflict resolution & version control](docs/reactions-and-versioning.md)**.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Bot shows offline in Discord | Token wrong or not loaded. Re-run `knock-knock setup`, choose "Save / update a bot token", and check `~/.knock-knock/.env`. |
| Bot never sees channel messages | (a) MESSAGE CONTENT INTENT not enabled; (b) `requireMention` is on and the message didn't `@mention` the bot; (c) the bot isn't a **member** of that channel. |
| No approval prompt appears | The owner id (`me.discord`) isn't set, or the channel's `approvalActorId` override is wrong — re-run `knock-knock setup`. |
| ✅ reaction does nothing | Only the bot **owner's** reaction counts (verified by user ID). |
| Bot missing from the startup "who's listening where" table | Its `tokenEnv` isn't set in `.env` (run `knock-knock setup` → "Save / update a bot token") or it isn't a member of any channel (run `knock-knock setup` → "Add / edit a channel"). |
| Two bots stop replying to each other | Expected — the loop guard caps agent↔agent chatter after 4 consecutive turns *within a task thread*. An owner/human message resets it. |
| Agent keeps context between messages | Expected — the relay maintains a session per task thread and resumes it on each turn. |
| Bot replies in the channel instead of a thread | It lacks **Create Public Threads** / **Send Messages in Threads** permission (re-invite with those, step 2), or the message was a reply inside an existing thread. |

---

## Reference

### Setup CLI (`knock-knock setup`)

| Flow | Purpose |
|------|---------|
| First run | Guided wizard: create a bot, add a channel (workspace + preset + collaborators), save a token, choose ledger |
| Later runs | Status dashboard + action menu: add a bot, add/edit a channel, add a person or peer to the roster, save a token, choose ledger backend, remove |

### `access.json`

State at `~/.knock-knock/access.json` — normalized into `me`, `bots`, `channels`, and `roster`:

```jsonc
{
  "me": { "discord": "184695080709324800" },   // owner id per platform — set once

  "bots": {
    "reviewer": {
      "platform": "discord",
      "tokenEnv": "DISCORD_BOT_TOKEN",          // NAME of the .env var holding this bot's token
      "runtime": "claude-sdk",                  // claude-sdk | claude-acp | opencode | codex | gemini | acp
      "blurb": "read-only research agent",      // optional; peers see this
      "sandbox": { "fs": "workspace", "network": "deny" }  // optional, ACP runtimes only
      // displayName is cached from the platform on connect — never typed
    }
  },

  "channels": {                                 // keyed `${platform}:${channelId}` — a channel = a project = a permission boundary
    "discord:846209781206941736": {
      "platform": "discord",
      "channelId": "846209781206941736",
      "label": "#project-x",                    // friendly project name (cosmetic)
      "members": [                              // my bots active here — each carries its own workspace + profile
        {
          "bot": "reviewer",
          "workspace": "/Users/alice/repos/project-x",
          "preset": "ask-per-edit",
          "profile": { "allow": ["Read(**)"], "ask": ["Bash(*)"], "deny": ["Bash(rm -rf *)", "Bash(sudo *)"] }
        }
      ],
      "collaborators": [                         // humans + peer bots, by roster id
        { "kind": "peer", "id": "deploy-bot" }
      ],
      "requireMention": true,
      "approvalActorId": "184695080709324800"    // optional override; defaults to me[platform]
    }
  },

  "roster": {                                    // entered once, referenced by id from channels
    "people": { "alice": { "platform": "discord", "userId": "184695080709324800", "label": "alice" } },
    "peers":  { "deploy-bot": { "platform": "discord", "userId": "987654321098765432", "blurb": "deploy specialist" } }
  },

  "mentionPatterns": [],   // optional
  "ackReaction": "👀"      // optional
}
```

`state.ts` is the only module that reads or writes these files.

### Development

From a source checkout, run the entry scripts directly with Bun:

All source lives under `src/`; the repo root holds only `src/`, `tests/`,
`website/`, `packaging/`, `scripts/`, `docs/`, and config files.

```
bun test              # full suite (everything under tests/): pure logic + the ledger
bun run typecheck     # tsc --noEmit
bun src/cli.ts <cmd>  # the CLI dispatcher (setup | relay)
bun src/relay.ts      # start the relay directly (reads bots/channels from access.json)
bun src/setup.ts      # interactive setup wizard / menu directly
bun run build         # cross-compile the release binaries into dist/
```

`lib.ts` holds the pure, security-critical decision logic — who may send (`guildSenderAllowed`), who may approve (`approverForAgent`), tool classification (`classifyTool`), and the channel/scope resolution (`resolveChannelForScope`) — all unit-testable without a live messaging connection. `state.ts` is the only module that does config file I/O. `AgentHost` is the messaging ↔ ledger router (Discord today, via a platform-neutral `MessagingAdapter` seam); its feature clusters live as focused collaborators in `host/` (`Workbench`, `ConflictUI`, `WatchControl`, `SessionSharing`) behind a narrow `HostContext`. The relay's core is **ledger-native** — an append-only DAG of Interactions with folds and synchronizations on top.

**Channel vs scope.** An interaction's `channel` is the task **scope** (a thread, or a plain channel); the workspace, permission profile, roster, and routing come from the bot's **membership** on the parent **channel** (the project). `AgentHost.roomForScope` is the one seam between them — and permission classification always resolves scope→channel, so a threaded task can never slip the deny floor. See [`docs/knock-knock-ledger-model.md`](docs/knock-knock-ledger-model.md) for the full architecture.

---

## Security notes

- **Presets, tiers & sandbox.** Pick a permission preset (strict / ask-per-edit / auto / bypass) per **membership** (a bot in a channel), narrow what peers may do with per-actor tiers, and optionally confine an ACP agent at the OS level (workspace-only writes, network off). Full friendly guide: **[Permissions & security](docs/security-and-permissions.md)**.
- **Owner-only approval.** Button clicks and ✅ reactions are verified against the channel's `approvalActorId` (defaults to the owner, `me[platform]`); anyone else's click is rejected. Each bot's prompts route to *that bot's* owner.
- **The deny floor.** For the Claude SDK runtime, `deny` rules reach `disallowedTools` and block the tool before execution. For ACP agents, `classifyTool` matches the same rules on every permission request — so the agent must run **ask-first** (never yolo/bypass mode), or be **OS-sandboxed**. Every preset keeps the floor — even `bypass`. See [the deny-floor caveat](docs/getting-started-agents.md).
- **Prompt-injection protection.** `access.json` (including the inline membership profiles) and `settings.json` are written only from your terminal (the setup CLI) and are never mutated from channel messages — all access, permission, and backend changes are out of reach of untrusted input.
- **Agent↔agent loop guard.** A local per-scope heuristic caps consecutive agent-to-agent turns (default 4) within a task thread; an owner/human message resets it.
- **Rate cap.** Max 10 inbound messages per sender per 60 s (loop/spam guard).


This scenario illustrates a typical workflow supported by Knockknock.

UserA and UserB are collaborating on a project. UserA creates a chat room and invites BotA and BotB, two agents that were independently created and configured by UserA and UserB, respectively.

---
## Usage Workflow

### UserA Needs Help from UserB

UserA wants to implement a feature that requires modifications to code owned by UserB.

To initiate the task, UserA creates a new thread and mentions (@) BotB. Within the thread, UserA describes the task and optionally customizes thread-specific settings, such as the persona brief, loop-guard parameters (`maxConsecutive`, `cooldownMs`), `approvalTimeoutMs`, workbench verbosity, and the model/runtime used by BotA.

UserB can also adjust the configuration of BotB. Once the task is set up, UserA can interact directly with BotB. With UserB's approval, BotB can access and modify files on UserB's side to complete the requested work.

UserA can also explicitly mention BotA to invite it to the thread, which has context from UserA's side and access to UserA’s files. With UserA’s permission, BotA can discuss and collaborate with BotB to better complete the task.

### Handling Concurrent Edits and Conflicts

Potential conflicts may arise when multiple agents are working on the same file. For example, while BotB is modifying `fileB`, UserB may also be using another agent, BotB2, to perform a separate task that involves editing the same file.

As long as BotB and BotB2 are connected to the same relay (and the same thread?), Knockknock automatically detects and manages these concurrent edits, helping users avoid conflicts and maintain a consistent workspace.

---

## Contributing & releasing

Dev loop, and how a git tag becomes a published release + Homebrew formula
(version/tag alignment, the nfpm `expand: true` gotcha, the `HOMEBREW_TAP_TOKEN`
setup, and the re-run gotchas) are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## Forked from

Anthropic's official Discord channel plugin (`discord@claude-plugins-official`). The discord.js connection patterns and message chunking come from that plugin.
</content>
</invoke>
