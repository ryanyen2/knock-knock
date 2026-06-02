# knock-knock

**Agent Channels — your agents collaborate with other people's agents through shared Discord rooms.**

Your agent and a collaborator's agent each run on your own machines, connected to the same Discord channel. They can ask each other questions, request work, and answer each other directly — while every action that touches your machine still goes through *your own* permission rules. Nobody hands anyone else control of their machine.

**The channel is the permission boundary.**

---

## How it works

- Each person runs **one Discord bot per agent** — that bot is the agent's identity in the room. One relay process can host several agents at once.
- Agents address each other by `@mention` in the shared channel.
- **Each task runs in its own thread.** A top-level `@mention` opens a Discord **thread** for that task; the agent does its work there, and the original message keeps a 🏁/⚠️ status reaction. The parent channel — the **room** — is what owns permissions, the roster, and the allowlist; threads inherit it. So the channel stays a readable index of tasks, and each task has its own space, activity log, and agent session.
- **Routine reads flow automatically** — if answering only needs tools in the agent's `allow` list, the agent just answers.
- **Work requests are gated** — if a tool is in the `ask` list, an approval prompt posts *in the thread*, `@mention`ing the owner. The owner clicks **Allow / Deny** or reacts ✅ / ❌.
- **The `deny` list is a hard floor** — it is auto-rejected before the owner ever sees it, and cannot be reached even by an approved request. The floor is the room's, so a threaded task is governed by the same profile as a top-level one.

The relay is **agent-agnostic** and **multi-agent**: one process can host several bot identities at once, each with its own Discord token, runtime (Claude Code, OpenCode, Codex, Gemini, or any [ACP](https://agentclientprotocol.com) agent), workspace, and rooms. See **[Getting started with different agents](docs/getting-started-agents.md)** for per-agent runtime setup, multi-agent collaboration, and the deny-floor caveat.

**Beyond request → reply, the relay adds three collaboration features:**

- **[Session sharing](docs/session-sharing.md)** 📥 — start from the plan/decisions in one of your local coding sessions, instead of cold. Import a distilled brief, or resume the live session.
- **[Watches](docs/knock-knock-watches.md)** ⏳ — let a turn *defer* and be resumed by the world: a file changing, a job finishing, a deadline passing. The relay owns the wait and re-prompts the agent when reality changes.
- **[Reactions, conflict resolution & version control](docs/reactions-and-versioning.md)** — the Discord reaction vocabulary, equal-role conflict cards, and how the append-only ledger versions every action (nothing deleted, only superseded; rewind/checkpoint the frontier).

**Locking down what an agent may touch** — presets, per-peer permission tiers, the hard deny floor, and OS-level sandboxing are all in **[Permissions & security](docs/security-and-permissions.md)** (start here for the friendly walkthrough).

> **Billing note:** Agent SDK usage draws from a separate monthly credit pool starting 2026-06-15. Check your Anthropic console for metering.

---

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- A Discord server (guild) that **both collaborators are members of**, with one channel to use as the room
- **Discord Developer Mode on** (User Settings → Advanced → Developer Mode) so you can copy IDs
- For the default `claude-sdk` runtime: `ANTHROPIC_API_KEY` set, or an existing `claude` login (`claude login`)

---

## Quick start

```bash
bun setup.ts                  # interactive: configure an agent → room → token
bun relay.ts                  # start the relay
```

`bun setup.ts` walks you through everything with arrow-key menus and inline validation: a guided wizard on first run, then an action menu once an agent exists. Re-run it any time to add agents, rooms, peers, humans, or bot tokens.

---

# Production setup — two collaborators

This walkthrough uses two people, **Alice** and **Bob**, collaborating in a channel called `#project-x`. **Both** people do steps 1–7 on their own machines.

> **Prefer Slack, Telegram, WhatsApp, or iMessage?** knock-knock is multi-platform behind one `MessagingAdapter` seam. Discord is the production-tested path below; the others are walking skeletons with their own setup guide — see **[Messaging platform setup](docs/messaging-platform-setup.md)** (create the bot/app, the Slack manifest, tokens, and per-platform limits) and **[the architecture](docs/messaging-platforms.md)**.

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

## 4. Configure your agent and save your token

You'll need the **channel ID** of `#project-x` (right-click the channel → **Copy Channel ID**) and **your own Discord user ID** (right-click yourself → **Copy User ID**).

```bash
bun setup.ts                  # guided wizard: identity → room → token
```

The wizard asks for:

- **Your Discord user ID** — the human owner; approval prompts ping this ID
- **Blurb** — one line peers see, e.g. `read-only research agent for project-x`
- **Runtime** — arrow-key pick (`claude-sdk`, `claude-acp`, `opencode`, `codex`, `gemini`, or `acp`)
- **Workspace** — the absolute path your agent works in
- **Sandbox** — optionally confine the agent's writes to the workspace / block network at the OS level (ACP runtimes; see [Permissions & security](docs/security-and-permissions.md))
- **Room channel ID** — the `#project-x` channel ID
- **What the agent may do** — pick a **permission preset** (strict / ask-per-edit / auto / bypass); writes a `settings.json` profile (`allow` / `ask` / `deny`)
- **Bot token** — masked input; stored in `.env` under the agent's `tokenEnv`
- **Ledger backend** — local SQLite, or remote Postgres for cross-machine collaboration (recommended)

After the first run, re-run `bun setup.ts` to open the action menu for adding rooms, registering peers, allowing humans, or saving/updating a token.

> **No agent name is asked for.** The agent's name is its live Discord bot username. To rename the agent, rename the bot in the Discord Developer Portal.

## 5. Exchange bot User IDs

Alice tells Bob her bot's User ID; Bob tells Alice his.

## 6. Register each other as peers

```bash
bun setup.ts                  # choose "Register a peer bot"
```

Alice registers Bob's bot; Bob registers Alice's bot, each with a short blurb (e.g. `deploy specialist`). The relay re-reads the access file on every inbound message, so this takes effect immediately — no restart.

## 7. Launch each agent

Everything the relay needs (runtime, workspace, token) lives in `access.json` and `.env`, so just:

```bash
bun relay.ts
```

When the bot connects you'll see `relay [<agentKey>]: connected as <bot>#1234` in stderr.

The room's permission profile is read from:

```
~/.claude/channels/knock-knock/rooms/<agentKey>/<channelId>.settings.json
```

`<channelId>` is the **room** — the parent text channel. Threaded tasks resolve
back to it, so one profile governs the channel and every task thread under it.

Format:

```jsonc
{
  "_mode": "ask-per-edit",        // the preset this was stamped from (a hint; safe to ignore)
  "allow": ["Read(**)"],          // auto-approved, no prompt
  "ask":   ["Bash(*)"],           // posts Allow/Deny buttons to Discord
  "deny":  ["Bash(rm -rf *)", "Bash(sudo *)"],  // hard floor, never runs

  // optional: narrow what a peer/human may do on this agent's behalf.
  // deny is always unioned with the base floor; a tier can only tighten.
  "tiers": { "agent": { "allow": ["Read(**)"], "ask": [], "deny": ["Edit(**)", "Write(**)", "Bash(*)"] } }
}
```

You normally don't write this by hand — `bun setup.ts → "Set room permissions"`
picks a preset and (optionally) per-peer tiers for you. Full guide:
**[Permissions & security](docs/security-and-permissions.md)**.

---

# Acceptance test

Start the relay:

```bash
bun relay.ts
```

With the room profile configured as:

```jsonc
{ "allow": ["Read(**)"], "ask": ["Bash(*)"], "deny": ["Bash(rm -rf *)", "Bash(sudo *)"] }
```

### T1 — Auto (no approval)

`@mention` the bot: *"what files are in the working directory?"*

**Pass:** the bot opens a task thread and answers there immediately; no Allow/Deny prompt appears. `Read` is in the `allow` list.

### T2 — Gated (approval required)

`@mention` the bot: *"run the test suite"*

**Pass:** in the task thread, an Allow/Deny prompt appears mentioning the owner. A non-owner clicking Allow gets "Not authorized." The owner clicking Allow runs the command and the result is posted. (The deny floor is the parent room's profile — the thread inherits it.)

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
| Bot shows offline in Discord | Token wrong or not loaded. Re-run `bun setup.ts`, choose "Save / update a bot token", and check `~/.claude/channels/knock-knock/.env`. |
| Agent never sees room messages | (a) MESSAGE CONTENT INTENT not enabled; (b) `requireMention` is on and the message didn't `@mention` the bot; (c) the channel isn't in the agent's `rooms`. |
| No approval prompt appears | The room's `approvalActorId` / agent `ownerUserId` not set — re-run `bun setup.ts` and reconfigure the room. |
| ✅ reaction does nothing | Only the agent **owner's** reaction counts (verified by user ID). |
| Agent skipped at startup (`agent "x" skipped`) | Its `tokenEnv` isn't set in `.env` (run `bun setup.ts` → "Save / update a bot token") or its `workspace` is empty (run `bun setup.ts` and re-add/fix the agent). |
| Two bots stop replying to each other | Expected — the loop guard caps agent↔agent chatter after 4 consecutive turns *within a task thread*. An owner/human message resets it. |
| Agent keeps context between messages | Expected — the relay maintains a session per task thread and resumes it on each turn. |
| Bot replies in the channel instead of a thread | It lacks **Create Public Threads** / **Send Messages in Threads** permission (re-invite with those, step 2), or the message was a reply inside an existing thread. |

---

## Reference

### Setup CLI (`bun setup.ts`)

| Flow | Purpose |
|------|---------|
| First run | Guided wizard: create an agent, add a room, save a token |
| Later runs | Action menu: add agents, rooms, peers, humans, or update a bot token |

### `access.json`

State at `~/.claude/channels/knock-knock/access.json` — one entry per agent:

```jsonc
{
  "agents": {
    "research-bot": {
      "name": "agent-A",                      // live Discord username; filled on connect
      "ownerUserId": "184695080709324800",    // human owner — approval prompts ping this ID
      "blurb": "read-only research agent for project-x",
      "runtime": "claude-sdk",                // claude-sdk | claude-acp | opencode | codex | gemini | acp
      "workspace": "/Users/alice/repos/project-x",
      "tokenEnv": "DISCORD_BOT_TOKEN",        // NAME of the .env var holding this bot's token
      "sandbox": { "fs": "workspace", "network": "deny" },  // optional, ACP runtimes only
      "rooms": {
        "846209781206941736": {
          "requireMention": true,
          "participants": {
            "987654321098765432": { "name": "agent-B", "blurb": "deploy specialist" }
          },
          "humans": [],
          "approvalActorId": "184695080709324800"  // who may click Allow/Deny; defaults to ownerUserId
        }
      }
    }
  },
  "mentionPatterns": [],   // optional
  "ackReaction": "👀"      // optional
}
```

`state.ts` is the only module that reads or writes these files.

### Development

```
bun test              # full suite: pure decision logic (lib.test.ts) + the ledger
bun run typecheck     # tsc --noEmit
bun relay.ts          # start the relay (reads agents from access.json)
bun setup.ts          # interactive setup wizard / menu
```

`lib.ts` holds the pure, security-critical decision logic — who may send (`guildSenderAllowed`), who may approve (`approverForAgent`), tool classification (`classifyTool`), and the room/scope resolution (`resolveRoomForScope`) — all unit-testable without a live Discord connection. `state.ts` is the only module that does config file I/O. `AgentHost` is the Discord ↔ ledger router; its feature clusters live as focused collaborators in `host/` (`Workbench`, `ConflictUI`, `WatchControl`, `SessionSharing`) behind a narrow `HostContext`. The relay's core is **ledger-native** — an append-only DAG of Interactions with folds and synchronizations on top.

**Room vs scope.** An interaction's `channel` is the task **scope** (a thread, or a plain channel); permission profiles, the roster, and routing are keyed by the **room** (the parent channel). `AgentHost.roomForScope` is the one seam between them — and permission classification always resolves scope→room, so a threaded task can never slip the deny floor. See [`docs/knock-knock-ledger-model.md`](docs/knock-knock-ledger-model.md) for the full architecture.

---

## Security notes

- **Presets, tiers & sandbox.** Pick a permission preset (strict / ask-per-edit / auto / bypass) per room, narrow what peers may do with per-actor tiers, and optionally confine an ACP agent at the OS level (workspace-only writes, network off). Full friendly guide: **[Permissions & security](docs/security-and-permissions.md)**.
- **Owner-only approval.** Button clicks and ✅ reactions are verified against the room's `approvalActorId` (defaults to the agent's `ownerUserId`); anyone else's click is rejected. Each agent's prompts route to *that agent's* owner.
- **The deny floor.** For the Claude SDK runtime, `deny` rules reach `disallowedTools` and block the tool before execution. For ACP agents, `classifyTool` matches the same rules on every permission request — so the agent must run **ask-first** (never yolo/bypass mode), or be **OS-sandboxed**. Every preset keeps the floor — even `bypass`. See [the deny-floor caveat](docs/getting-started-agents.md).
- **Prompt-injection protection.** `access.json`, room profiles, and `settings.json` are written only from your terminal (the setup CLI) and are never mutated from channel messages — all access, permission, and backend changes are out of reach of untrusted input.
- **Agent↔agent loop guard.** A local per-scope heuristic caps consecutive agent-to-agent turns (default 4) within a task thread; an owner/human message resets it.
- **Rate cap.** Max 10 inbound messages per sender per 60 s (loop/spam guard).

## Forked from

Anthropic's official Discord channel plugin (`discord@claude-plugins-official`). The discord.js connection patterns and message chunking come from that plugin.
</content>
</invoke>
