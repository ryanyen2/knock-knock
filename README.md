# knock-knock

**Agent Channels for Claude Code** — lets your agents collaborate with other people's agents through shared Discord rooms.

Your agent and a collaborator's agent each run on your own machines, connected to the same Discord channel. They can ask each other questions, hand off files, and request work — while every action that touches your machine still goes through *your own* Claude Code permission rules. Nobody hands anyone else control of their machine.

**The channel is the permission boundary.**

---

## How it works

- Each person runs **one Discord bot per agent** (their agent's identity in the room).
- Agents address each other by `@mention` in the shared channel.
- **Routine reads flow automatically** — if answering only needs tools in the agent's `allow` list, the agent just answers.
- **Work requests are gated** — if a tool is in the `ask` list, an approval prompt posts *in the channel*, `@mention`ing the owner. The owner clicks **Allow/Deny** or reacts ✅/❌.
- **The `deny` list is a hard floor** — it can't be bypassed even by an approved request.

**Two layers of enforcement:**
| Layer | Enforces | Configured by |
|-------|----------|---------------|
| Claude Code permissions (`settings.json` allow/ask/deny) | what runs *on your machine* | `/knock-knock:room setup` generates it |
| knock-knock server (`sendableRoots`) | what files *cross the wire* to peers | `access.json` per room |

---

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- Claude Code with the **Channels** capability (research preview — see [docs](https://code.claude.com/docs/en/channels))
- A Discord server (guild) that **both collaborators are members of**, with one channel to use as the room
- **Discord Developer Mode on** (User Settings → Advanced → Developer Mode) so you can copy IDs

---

# Production setup — two collaborators

This walkthrough uses two people, **Alice** and **Bob**, collaborating in a channel called `#project-x`. **Both** people do steps 1–7 on their own machines. Where it says "your", it means each person's own values.

## 1. Create your Discord bot

At [discord.com/developers/applications](https://discord.com/developers/applications):

1. **New Application** → name it (e.g. `alice-research-agent`).
2. **Bot** tab → **Reset Token** → copy and save it (shown only once). This is your `DISCORD_BOT_TOKEN`.
3. **Bot** tab → **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT**.
   *(This is the only privileged intent required. `GuildMessageReactions` — needed for ✅ approvals — is a standard intent and needs no toggle here.)*

## 2. Invite your bot to the shared server

1. **OAuth2 → URL Generator**.
2. Scopes: check **`bot`**.
3. Bot Permissions: **View Channels**, **Send Messages**, **Read Message History**, **Attach Files**, **Add Reactions**. *(Add **Send Messages in Threads** if you plan to use threads.)*
4. Copy the generated URL, open it, and add the bot to the **shared** server (`#project-x`'s server).

## 3. Note your bot's User ID

In Discord (Developer Mode on): find your bot in the member list → right-click → **Copy User ID**. You'll give this to your collaborator in step 6.

## 4. Install the plugin and save your token

```
/plugin install /absolute/path/to/knock-knock
/knock-knock:configure <your-bot-token>
```

## 5. Set up your agent and join the room

You need the **channel ID** of `#project-x` (right-click the channel → **Copy Channel ID**) and **your own Discord user ID** (right-click yourself → **Copy User ID**).

```
/knock-knock:room setup
```

It will ask for:
- **Agent name** — e.g. `agent-A` (Alice) / `agent-B` (Bob)
- **Your Discord user ID** — *yours*, the human; this is who approval prompts ping
- **Blurb** — one line peers see, e.g. `read-only research agent for project-x`
- **Room channel ID** — the `#project-x` channel ID
- **Sendable file roots** — absolute path(s) the agent may attach, e.g. `/Users/alice/repos/project-x`
- **What the agent may do** — describe it; the skill writes a `settings.json` permission profile

## 6. Exchange bot User IDs

Alice tells Bob her bot's User ID; Bob tells Alice his. (From step 3.)

## 7. Register each other as peers

So your agent can *hear* the other agent, register their bot in your room:

```
/knock-knock:room add-peer <channelId> <theirBotUserId> agent-B "deploy + migration specialist"
```

Alice registers Bob's bot; Bob registers Alice's bot. The server picks this up immediately — no restart.

## 8. Launch each agent

`/knock-knock:room setup` prints your launch command. Use the bundled launcher —
it's one short line, so your terminal can't split it:

```
bash <path-to-knock-knock>/scripts/launch-room.sh <channelId>
```

On first launch, approve the one-time dev-channel confirmation prompt. When the bot
connects you'll see `knock-knock: gateway connected as <bot>#1234` in stderr.

<details>
<summary>What the launcher runs (and why not <code>--channels</code>)</summary>

`knock-knock` is a **custom channel** you run locally, so it loads via
`--dangerously-load-development-channels`, not `--channels`. `--channels` is the
**allowlist-only** flag for official channels and requires a
`plugin:<name>@<marketplace>` tag — a dev/local plugin has no marketplace, so
`--channels plugin:knock-knock` fails with *"--channels entries must be tagged"*.
The valid entry forms are `plugin:<name>@<marketplace>` and `server:<name>`; for
local dev we use `server:knock-knock` (a [bare MCP server](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)).

The raw command the script execs (the `\` keep it one logical line — don't drop them):

```bash
claude --dangerously-load-development-channels server:knock-knock \
  --mcp-config '{"mcpServers":{"knock-knock":{"command":"bun","args":["run","--cwd","<path-to-knock-knock>","--shell=bun","--silent","start"]}}}' \
  --settings ~/.claude/channels/knock-knock/rooms/<channelId>.settings.json
```

The inline `--mcp-config` is required because the plugin's `.mcp.json` uses
`${CLAUDE_PLUGIN_ROOT}`, which is only defined when knock-knock is loaded as a
plugin — not on the `server:` path. `scripts/launch-room.sh` self-locates the
checkout, so you don't hand-edit that path.

**Requires** Claude Code v2.1.80+ and claude.ai / Console API-key auth (channels
aren't available on Bedrock, Vertex, or Foundry). Once published to a marketplace,
the entry becomes `plugin:knock-knock@<marketplace>` but still needs the dev flag
until it's on Anthropic's official allowlist. See
[code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels).
</details>

When both agents are launched and connected, you're ready to test.

---

# Acceptance test

Run these in order. "Tell your agent" means type the instruction into your Claude Code session; the agent then acts in the Discord room.

### Test 1 — Context pull (auto, no approval)

1. **Alice**, tell your agent: *"Ask agent-B in the room what files are in their project root."*
   Your agent should `reply` in `#project-x` with something like `<@bob-bot-id> what's in your project root?`
2. **Bob's** agent receives the mention, and since listing files is a `Read`/allowed action, it answers automatically — **no approval prompt appears**.
3. **Alice's** agent receives Bob's reply as a new event and reports it back to Alice.

✅ Pass: Alice gets the answer with no human approval on Bob's side.

### Test 2 — Gated work request (approval required)

1. **Alice**, tell your agent: *"Ask agent-B to run the test suite and report results."*
   (Assumes Bob's profile has e.g. `Bash(bun test)` in the **ask** list.)
2. **Bob** sees a message in `#project-x`: `@Bob 🔐 Permission request: Bash` with **Allow / Deny / See more** buttons.
3. **Bob** clicks **Allow** (or reacts ✅, or types `yes <code>`). Bob's agent runs the tests and replies with results.
4. **Alice's** agent receives the result.

✅ Pass: the request waited for Bob's tap; only Bob (the owner) could approve. Have a third person try clicking — it should say "Not authorized."

### Test 3 — The hard deny floor

1. Put something on Bob's `deny` list (e.g. `Bash(rm -rf *)`).
2. **Alice**, ask Bob's agent to do that thing. Even if **Bob clicks Allow**, Claude Code blocks it — the tool never runs.

✅ Pass: an approved action on the `deny` list still does not execute.

### Test 4 — File handoff + send boundary

1. **Alice**, tell your agent to send a file that's **inside** `sendableRoots` to the room. It attaches; Bob's agent can `download_attachment`.
2. **Alice**, tell your agent to send a file **outside** `sendableRoots` (e.g. `~/.ssh/id_rsa`). The server refuses with `refusing to send file outside sendableRoots`.

✅ Pass: in-root sends succeed; out-of-root sends are blocked by the server (not just by CC).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Bot shows offline in Discord | Token wrong or not loaded. Re-run `/knock-knock:configure <token>`, then restart the session (`.env` is read once at boot). |
| Agent never sees room messages | (a) MESSAGE CONTENT INTENT not enabled in the Developer Portal; (b) the peer bot isn't registered via `add-peer`; (c) `requireMention` is on and the message didn't `@mention` your bot. |
| No approval prompt appears | `self.roomChannelId` / owner not set — re-run `/knock-knock:room setup`. Check stderr for `no roomChannelId or owner configured`. |
| ✅ reaction does nothing | Only the agent **owner's** reaction counts (verified by user ID). Make sure you're reacting as the user set in `ownerUserId`. |
| "channel is not registered" | The target channel isn't in `access.rooms`. Run `/knock-knock:room join <channelId>`. |
| Agents talk in a loop | Shouldn't happen: `requireMention` + self-ignore + a 10-msg/sender/60s rate cap guard against it. If it does, lower activity and check that both bots have distinct identities. |

---

## Reference

### Skills

| Skill | Purpose |
|-------|---------|
| `/knock-knock:configure` | Save the bot token, check status |
| `/knock-knock:room` | Agent identity, join rooms, add/remove peers and humans, generate settings, print launch command |
| `/knock-knock:access` | Owner DM pairing, allowlist, DM policy |

### MCP tools (available to the agent)

| Tool | Description |
|------|-------------|
| `reply` | Send a message to the channel (text + optional file attachments) |
| `react` | Add an emoji reaction to a message |
| `edit_message` | Edit a previously sent bot message |
| `fetch_messages` | Fetch recent channel history (oldest-first, max 100) |
| `download_attachment` | Download message attachments to the local inbox |
| `list_agents` | List peer agents in this room with mention handles and blurbs |

### `access.json`

State at `~/.claude/channels/knock-knock/access.json`:

```jsonc
{
  "self": {
    "name": "agent-A",
    "ownerUserId": "184695080709324800",   // the human owner (gets approval pings)
    "blurb": "read-only research agent for project-x",
    "roomChannelId": "846209781206941736"
  },
  "rooms": {
    "846209781206941736": {
      "requireMention": true,
      "participants": {                      // peer bots this agent will hear
        "987654321098765432": { "name": "agent-B", "blurb": "deploy specialist" }
      },
      "humans": [],                          // human user IDs also allowed to drive in-room
      "sendableRoots": ["/Users/alice/repos/project-x"],
      "approvalActorId": "184695080709324800" // optional override; defaults to self.ownerUserId
    }
  },
  "dmPolicy": "pairing",
  "allowFrom": [],
  "pending": {}
}
```

### Development

```
bun test          # run lib.test.ts (pure decision logic: gate auth, send boundary, roster, chunking)
bun run typecheck # tsc --noEmit
```

`lib.ts` holds the pure, security-critical decision logic (who may send, who may approve, what files cross the wire), kept separate from `server.ts` (I/O) so it's unit-testable without a live Discord connection.

---

## Security notes

- **The "ignore all bots" guard is intentionally removed.** Anthropic's official Discord plugin drops every bot message; knock-knock must hear *peer agent bots*. In its place: a per-room participant allowlist, a self-ignore guard, and a rate cap.
- **Prompt-injection protection.** Skills refuse to mutate `access.json` based on channel messages — all access changes run from your terminal only.
- **Owner-only approval.** Button clicks and ✅ reactions are verified against `approvalActorId` (or `self.ownerUserId`); anyone else's interaction is ignored.
- **Server-side send boundary.** `reply(files:[...])` reads files inside the MCP process, *bypassing* CC's `Read` permission — so `sendableRoots` is enforced by the server, not by CC.

## Forked from

Anthropic's official Discord channel plugin (`discord@claude-plugins-official`). The channel-capability spine (`claude/channel` + `claude/channel/permission`), message chunking, attachment handling, DM pairing, and file-state safety come from that plugin.
