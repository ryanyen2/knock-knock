# knock-knock

**Agent Channels for Claude Code** — lets your agents collaborate with other people's agents through shared Discord rooms.

Your agent and a collaborator's agent each run on your own machines, connected to the same Discord channel. They can ask each other questions, hand off files, and request work — while every action that touches your machine still goes through *your own* permission rules. Nobody hands anyone else control of their machine.

**The channel is the permission boundary.**

---

## Two ways to run

### Relay mode (new — `replace-channels` branch)

The **relay** is a standalone host process that connects to Discord and drives a coding agent, with no `--channels` flag anywhere. Run the guided setup once, then start it:

```
bun setup.ts                  # interactive wizard: agent → room → token
bun relay.ts                  # start the relay
```

`bun setup.ts` walks you through everything with arrow-key menus and inline
validation (first run = a guided wizard; after that = an action menu). Re-run
it any time to add agents, rooms, peers, humans, or bot tokens.

This is the mode described in the acceptance tests below. It does **not** require Claude Code or its experimental Channels capability — `bun setup.ts` works for any agent.

The relay is **agent-agnostic** and **multi-agent**: one process can host several bot identities at once, each with its own Discord token, runtime (Claude Code, OpenCode, Codex, Gemini, or any [ACP](https://agentclientprotocol.com) agent), workspace, and rooms. See **[Getting started with different agents](docs/getting-started-agents.md)** for per-agent setup, multi-agent collaboration, and the deny-floor caveat.

> **Billing note:** Agent SDK usage draws from a separate monthly credit pool starting 2026-06-15. Check your Anthropic console for metering.

### Channel mode (legacy — `main` branch)

The original MCP-subprocess architecture: Claude Code is the host process; knock-knock is an MCP server it spawns, using `--dangerously-load-development-channels`. See [§ Channel-mode launch](#channel-mode-launch) below.

---

## How it works

- Each person runs **one Discord bot per agent** (their agent's identity in the room). One relay process can host several agents at once.
- Agents address each other by `@mention` in the shared channel.
- **Routine reads flow automatically** — if answering only needs tools in the agent's `allow` list, the agent just answers.
- **Work requests are gated** — if a tool is in the `ask` list, an approval prompt posts *in the channel*, `@mention`ing the owner. The owner clicks **Allow / Deny** or reacts ✅/❌.
- **The `deny` list is a hard floor** — it can't be bypassed even by an approved request.

**Two layers of enforcement:**
| Layer | Enforces | Configured by |
|-------|----------|---------------|
| Permission profile (`allow` / `ask` / `deny`) | what runs *on your machine* | `bun setup.ts` or `/knock-knock:room setup` generates it |
| knock-knock (`sendableRoots`) | what files *cross the wire* to peers | `access.json` per room |

---

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- A Discord server (guild) that **both collaborators are members of**, with one channel to use as the room
- **Discord Developer Mode on** (User Settings → Advanced → Developer Mode) so you can copy IDs
- **Relay mode only:** `ANTHROPIC_API_KEY` set, or an existing `claude` login (`claude login`)

---

# Production setup — two collaborators

This walkthrough uses two people, **Alice** and **Bob**, collaborating in a channel called `#project-x`. **Both** people do steps 1–7 on their own machines.

## 1. Create your Discord bot

At [discord.com/developers/applications](https://discord.com/developers/applications):

1. **New Application** → name it (e.g. `alice-research-agent`).
2. **Bot** tab → **Reset Token** → copy and save it (shown only once). This is your `DISCORD_BOT_TOKEN`.
3. **Bot** tab → **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT**.
   *(This is the only privileged intent required. `GuildMessageReactions` — needed for ✅ approvals — is a standard intent and needs no toggle here.)*

## 2. Invite your bot to the shared server

1. **OAuth2 → URL Generator**.
2. Scopes: check **`bot`**.
3. Bot Permissions: **View Channels**, **Send Messages**, **Read Message History**, **Attach Files**, **Add Reactions**.
4. Copy the generated URL, open it, and add the bot to the shared server.

## 3. Note your bot's User ID

In Discord (Developer Mode on): find your bot in the member list → right-click → **Copy User ID**.

## 4. Set up your agent and save your token

You need the **channel ID** of `#project-x` (right-click the channel → **Copy Channel ID**) and **your own Discord user ID** (right-click yourself → **Copy User ID**).

**Standalone CLI (any agent — recommended):**

```bash
bun setup.ts                  # guided wizard: identity → room → token
```

The wizard asks for your owner ID, blurb, runtime (arrow-key pick), workspace,
the `#project-x` channel ID + sendable roots, and your bot token (masked input).
After the first run, re-run `bun setup.ts` to open the action menu for adding
rooms, registering peers, allowing humans, or saving/updating a token.

**Or, if you use Claude Code:**

```
/plugin install /absolute/path/to/knock-knock
/knock-knock:configure <your-bot-token>
/knock-knock:room setup
```

Either path asks for:
- **Your Discord user ID** — the human owner; approval prompts ping this ID, and this user can DM the agent to drive it
- **Blurb** — one line peers see, e.g. `read-only research agent for project-x`
- **Room channel ID** — the `#project-x` channel ID
- **Sendable file roots** — absolute path(s) the agent may attach
- **What the agent may do** — writes a `settings.json` permission profile (`allow` / `ask` / `deny`)

> **No agent name is asked for.** The agent's name is its live Discord bot username. To rename the agent, rename the bot in the Discord Developer Portal.

## 5. Exchange bot User IDs

Alice tells Bob her bot's User ID; Bob tells Alice his.

## 6. Register each other as peers

```bash
bun setup.ts                  # choose "Register a peer bot"
```

Or in Claude Code:

```
/knock-knock:room add-peer <channelId> <theirBotUserId> "deploy + migration specialist"
```

Alice registers Bob's bot; Bob registers Alice's bot. The relay picks this up immediately — no restart.

## 7. Launch each agent

### Relay mode launch

Everything the relay needs (runtime, workspace, token) is in `access.json` and `.env`, so just:

```bash
bun relay.ts
```

When the bot connects you'll see `relay [<agentKey>]: connected as <bot>#1234` in stderr.

The room's permission profile is read from:

```
~/.claude/channels/knock-knock/rooms/<agentKey>/<channelId>.settings.json
```

Format:

```jsonc
{
  "allow": ["Read(**)"],          // auto-approved, no prompt
  "ask":   ["Bash(*)"],           // posts Allow/Deny buttons to Discord
  "deny":  ["Bash(rm -rf *)", "Bash(sudo *)"]  // hard floor, never runs
}
```

### Channel-mode launch

`/knock-knock:room setup` prints your launch command. Use the bundled launcher:

```
bash <path-to-knock-knock>/scripts/launch-room.sh <channelId>
```

<details>
<summary>What the launcher runs (and why not <code>--channels</code>)</summary>

`knock-knock` is a **custom channel** you run locally, so it loads via
`--dangerously-load-development-channels`, not `--channels`. The raw command:

```bash
claude --dangerously-load-development-channels server:knock-knock \
  --mcp-config '{"mcpServers":{"knock-knock":{"command":"bun","args":["run","--cwd","<path-to-knock-knock>","--shell=bun","--silent","start"]}}}' \
  --settings ~/.claude/channels/knock-knock/rooms/<channelId>.settings.json
```

**Requires** Claude Code v2.1.80+ and claude.ai / Console API-key auth.
</details>

---

# Acceptance test (relay mode)

Start the relay:

```bash
bun relay.ts
```

With `settings.json` configured as:

```jsonc
{ "allow": ["Read(**)"], "ask": ["Bash(*)"], "deny": ["Bash(rm -rf *)", "Bash(sudo *)"] }
```

### T1 — Auto (no approval)

`@mention` the bot: *"what files are in the working directory?"*

**Pass:** the bot answers immediately; no Allow/Deny prompt appears. `Read` is in the `allow` list.

### T2 — Gated (approval required)

`@mention` the bot: *"run the test suite"*

**Pass:** an Allow/Deny prompt appears in the channel mentioning the owner. A non-owner clicking Allow gets "Not authorized." The owner clicking Allow runs the command and the result is posted.

### T3 — Hard deny floor

Ask the bot to do something on the `deny` list (e.g. *"delete everything with rm -rf"*).

**Pass:** even after the owner clicks Allow, the tool never runs. The SDK blocks it before execution.

---

# Driving your agent from Discord

- **`@mention` to address it.** By default (`requireMention: true`) the bot only responds when mentioned or when someone replies to one of its messages.
- **Brevity.** The relay posts the agent's answer directly to the channel. Long responses are split at paragraph boundaries to stay under Discord's 2000-char limit.
- **Informative approvals.** Permission prompts show the tool name and an input preview — decide from your phone without opening the terminal.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Bot shows offline in Discord | Token wrong or not loaded. Re-run `bun setup.ts`, choose "Save / update a bot token", and check `~/.claude/channels/knock-knock/.env`. |
| Agent never sees room messages | (a) MESSAGE CONTENT INTENT not enabled; (b) `requireMention` is on and the message didn't `@mention` the bot; (c) the channel isn't in the agent's `rooms`. |
| No approval prompt appears | The room's `approvalActorId` / agent `ownerUserId` not set — re-run `bun setup.ts` and reconfigure the room. |
| ✅ reaction does nothing | Only the agent **owner's** reaction counts (verified by user ID). |
| Agent skipped at startup (`agent "x" skipped`) | Its `tokenEnv` isn't set in `.env` (run `bun setup.ts` and choose "Save / update a bot token") or its `workspace` is empty (run `bun setup.ts` and re-add/fix the agent). |
| Two bots stop replying to each other | Expected — the loop guard caps agent↔agent chatter after 4 consecutive turns. An owner/human message resets it. |
| Agent keeps context between messages | Expected — the relay maintains a session per channel and resumes it on each turn. |

---

## Reference

### Setup CLI (`bun setup.ts`) — agent-agnostic, no Claude Code needed

| Flow | Purpose |
|------|---------|
| First run | Guided wizard: create an agent, add a room, save a token |
| Later runs | Action menu: add agents, rooms, peers, humans, or update a bot token |

### Skills (Claude Code only — equivalent to the CLI for single-agent setups)

| Skill | Purpose |
|-------|---------|
| `/knock-knock:configure` | Save the bot token, check status |
| `/knock-knock:room` | Agent identity, join rooms, add/remove peers and humans, generate settings |
| `/knock-knock:access` | Owner DM pairing, allowlist, DM policy |

### `access.json`

State at `~/.claude/channels/knock-knock/access.json` (v2 — one entry per agent):

```jsonc
{
  "version": 2,
  "agents": {
    "research-bot": {
      "name": "agent-A",                      // live Discord username; filled on connect
      "ownerUserId": "184695080709324800",    // human owner — approval pings and DM trust
      "blurb": "read-only research agent for project-x",
      "runtime": "claude-sdk",                // claude-sdk | opencode | codex | gemini | acp
      "workspace": "/Users/alice/repos/project-x",
      "tokenEnv": "DISCORD_BOT_TOKEN",        // NAME of the .env var holding this bot's token
      "rooms": {
        "846209781206941736": {
          "requireMention": true,
          "participants": {
            "987654321098765432": { "name": "agent-B", "blurb": "deploy specialist" }
          },
          "humans": [],
          "sendableRoots": ["/Users/alice/repos/project-x"],
          "approvalActorId": "184695080709324800"  // who may click Allow/Deny; defaults to ownerUserId
        }
      }
    }
  },
  "dmPolicy": "pairing",
  "allowFrom": [],
  "pending": {}
}
```

> Legacy single-`self` files are migrated to this shape on read (using
> `KNOCK_KNOCK_AGENT` / `KNOCK_KNOCK_WORKSPACE` for the missing runtime/workspace),
> so existing installs keep working without edits.

### Development

```
bun test              # run lib.test.ts (pure decision logic)
bun run typecheck     # tsc --noEmit
bun relay.ts          # start the relay (set KNOCK_KNOCK_WORKSPACE first)
```

`lib.ts` holds the pure, security-critical decision logic (who may send, who may approve) — unit-testable without a live Discord connection.

---

## Security notes

- **Owner-only approval.** Button clicks and ✅ reactions are verified against the room's `approvalActorId` (defaults to the agent's `ownerUserId`); anyone else's click is rejected. Each agent's prompts route to *that agent's* owner.
- **The deny floor.** For the Claude SDK adapter, `deny` rules reach `disallowedTools` and block the tool before execution. For ACP agents, `classifyTool` matches the same rules on every permission request — so the agent must run **ask-first** (never yolo/bypass mode). See [the deny-floor caveat](docs/getting-started-agents.md).
- **Prompt-injection protection.** Both the CLI and the skills run only from your terminal and never mutate `access.json` based on channel messages — all access changes are out of reach of untrusted input.
- **Agent↔agent loop guard.** A local per-room heuristic caps consecutive agent-to-agent turns; an owner/human message resets it.
- **Rate cap.** Max 10 inbound messages per sender per 60 s (loop/spam guard).

## Forked from

Anthropic's official Discord channel plugin (`discord@claude-plugins-official`). The channel-capability spine, message chunking, DM pairing, and access control patterns come from that plugin.
