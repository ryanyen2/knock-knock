---
name: room
description: Set up or update a knock-knock collaboration room — configure agent identity, join a room, add peer agents, generate the CC settings file, and print the launch command. Use when the user wants to bring their agent into a Discord room.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
---

# /knock-knock:room — Room Setup

Configures this agent's identity and room membership, generates a Claude Code settings
file (the permission profile), and prints the ready-to-run launch command.

One source of truth → two generated artifacts:
- `~/.claude/channels/knock-knock/access.json` (v2 `agents` map with agent entry + room)
- `~/.claude/channels/knock-knock/rooms/<agentKey>/<channelId>.settings.json` (flat permission profile)

> **Multi-agent setup** (managing several bot identities): use `bun setup.ts` instead —
> it is agent-agnostic and does not require Claude Code.

Arguments passed: `$ARGUMENTS`

---

## State dir

`~/.claude/channels/knock-knock/`

---

## Dispatch on arguments

### No args — status

Show current `self` identity and registered rooms with participant counts.
Print the launch command (see [Launch command](#launch-command)) for the current
primary room if configured.

### `setup` — interactive configuration

Walk the user through:

1. **Owner Discord user ID** — ask: "Your Discord user ID (snowflake). In Discord: Settings → Advanced → enable Developer Mode, then right-click your username → Copy User ID." This is who owns the agent: their DMs drive it and their word outranks peer chatter.
2. **Blurb** — ask: "One-line description of what this agent does. Peers see this. (e.g. 'read-only research agent for project-x')"
3. **Room channel ID** — ask: "The Discord channel ID of the room to join. In Discord (Developer Mode): right-click the channel → Copy Channel ID."
4. **Sendable file roots** — ask: "Absolute path(s) the agent may send as file attachments (comma-separated). Leave blank to allow any non-state file." Parse as `[]` if blank.
5. **Allow/deny rules** — ask: "What should this agent be allowed to do? Describe in plain terms or as CC permission rules." Then generate a CC settings JSON from the answer (see below).

> Do **not** ask for an agent name. The agent's name *is* its live Discord bot
> username — that's the handle people actually `@mention`. The server reads it
> from Discord on connect and writes it into `self.name`, so a typed alias can
> never drift from the real handle. (If you want to rename the agent, rename the
> bot in the Discord Developer Portal; it re-syncs next launch.)

After collecting answers:
1. `mkdir -p ~/.claude/channels/knock-knock/rooms/<agentKey>`
2. Read existing access.json (or start from default v2 shape: `{ "version": 2, "agents": {} }`).
3. Write `agents["default"]` (or chosen key) with:
   ```json
   {
     "ownerUserId": "<ownerUserId>",
     "blurb": "<blurb>",
     "runtime": "claude-sdk",
     "workspace": "<cwd from env>",
     "tokenEnv": "DISCORD_BOT_TOKEN",
     "rooms": {
       "<channelId>": {
         "requireMention": true,
         "participants": {},
         "humans": [],
         "sendableRoots": ["<sendableRoots>"],
         "approvalActorId": "<ownerUserId>"
       }
     }
   }
   ```
   **Omit `name`** — the relay fills it from Discord on connect.
4. Save access.json.
5. Write the flat settings file (see format below).
6. Print the launch command.

### `join <channelId>` — add a room entry without re-doing identity

Prompts only for room-specific fields (sendableRoots, approvalActorId if different from self owner).
Adds the room to `agents["default"].rooms`. Updates access.json. Regenerates settings for that room.

### `add-peer <channelId> <peerBotUserId> <blurb>`

Adds a peer agent to the room's `participants` map. The server re-reads access.json immediately.
Example: `/knock-knock:room add-peer 846209781206941736 123456789 "schema specialist — auth schema, DB migrations"`

Parse: channelId, peerBotUserId, blurb (rest of string). Write `participants[peerBotUserId] = { blurb }` — **no name**; the server resolves the peer's display name live from Discord (so it tracks renames). The blurb is the one thing Discord can't tell us, so it's the only field you store.

### `remove-peer <channelId> <peerBotUserId>`

Deletes `rooms[channelId].participants[peerBotUserId]`. Write back.

### `add-human <channelId> <userId>`

Adds a human's Discord user ID to `rooms[channelId].humans`. Humans can drive the agent
in-room without needing a peer bot identity.

### `rm-human <channelId> <userId>`

Removes the human from the room's `humans` list.

---

## Settings file format

Write to `~/.claude/channels/knock-knock/rooms/<agentKey>/<channelId>.settings.json`.

**Use flat top-level keys** — `readRoomSettings` parses these directly:

```json
{
  "allow": ["<list of allowed tool patterns>"],
  "ask": ["<list of patterns needing human approval>"],
  "deny": ["<list of always-blocked patterns>"]
}
```

**Default safe profile** (use if user doesn't specify, or as the deny-floor):
```json
{
  "allow": [
    "Read(**)"
  ],
  "ask": [
    "Edit(**)",
    "Write(**)",
    "Bash(*)"
  ],
  "deny": [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Write(~/.claude/**)",
    "Write(~/.ssh/**)"
  ]
}
```

**Translation guide** for user's plain-English answers:
- "read-only" → `allow: ["Read(**)"]`, `deny: ["Edit", "Write", "Bash"]`
- "can read and edit project files" → `allow: ["Read(**)", "Edit(/path/to/project/**)"]`
- "can run tests but not deploy" → `allow: ["Read(**)", "Bash(npm test)", "Bash(bun test)"]`, `ask: ["Bash(npm run deploy *)", "Bash(git push *)"]`
- "full access" → `ask: ["Bash(*)", "Edit(**)", "Write(**)", "Read(**)" ]` with hard deny-floor

Always include the deny-floor regardless of other rules:
```json
"deny": [
  "Bash(rm -rf *)",
  "Bash(sudo *)",
  "Write(~/.claude/**)",
  "Write(~/.ssh/**)"
]
```

---

## Launch command

knock-knock runs as a **standalone relay** — a Bun process you start once and
leave running. It is **not** launched via `--dangerously-load-development-channels`
(that was the legacy MCP/channel path; it's still in the repo as `server.ts` but
not maintained).

After writing files, print:

```
Agent identity:  <agentKey>  (<blurb>)
Room channel:    <channelId>
Settings file:   ~/.claude/channels/knock-knock/rooms/<agentKey>/<channelId>.settings.json
Owner Discord:   <ownerUserId>

Save your bot token first (if not already done):
  bun setup.ts configure

Then start the relay:
  bun relay.ts

When the bot connects you'll see:
  relay [<agentKey>]: connected as <bot>#1234
```

The relay reads `.env` (for the token) and `access.json` on every inbound message,
so room config changes take effect without a restart. Token changes require a
relay restart.

---

## Implementation notes

- Always Read access.json before Write — don't clobber other fields.
- Pretty-print JSON (2-space indent).
- `sendableRoots` should be absolute paths. If the user gives a relative path,
  note they should use the absolute path and ask them to confirm.
- The relay re-reads access.json on every inbound message — room/peer changes take
  effect immediately without restarting the relay.
- Don't generate a separate settings file per peer-add — only on `setup` or `join`.
- Use agent key `"default"` for the first/only agent; the user can rename via
  `bun setup.ts agent add` if they add more agents later.
- Settings are written **flat** (`{allow, ask, deny}` at top level) — the nested
  `{permissions:{…}}` format is no longer used.
