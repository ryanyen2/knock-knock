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
- `~/.claude/channels/knock-knock/access.json` (`self` block + room entry)
- `~/.claude/channels/knock-knock/rooms/<channelId>.settings.json` (CC permission profile)

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

1. **Agent name** — ask: "What name should this agent go by? (e.g. agent-A, research-bot)"
2. **Owner Discord user ID** — ask: "Your Discord user ID (snowflake). In Discord: Settings → Advanced → enable Developer Mode, then right-click your username → Copy User ID."
3. **Blurb** — ask: "One-line description of what this agent does. Peers see this. (e.g. 'read-only research agent for project-x')"
4. **Room channel ID** — ask: "The Discord channel ID of the room to join. In Discord (Developer Mode): right-click the channel → Copy Channel ID."
5. **Sendable file roots** — ask: "Absolute path(s) the agent may send as file attachments (comma-separated). Leave blank to allow any non-state file." Parse as `[]` if blank.
6. **Allow/deny rules** — ask: "What should this agent be allowed to do? Describe in plain terms or as CC permission rules." Then generate a CC settings JSON from the answer (see below).

After collecting answers:
1. `mkdir -p ~/.claude/channels/knock-knock/rooms`
2. Read existing access.json (or start from default).
3. Write `self` block with `{ name, ownerUserId, blurb, roomChannelId }`.
4. Write `rooms[channelId]` with `{ requireMention: true, participants: {}, humans: [], sendableRoots, approvalActorId: ownerUserId }`.
5. Save access.json.
6. Write the CC settings file (see format below).
7. Print the launch command.

### `join <channelId>` — add a room entry without re-doing identity

Prompts only for room-specific fields (sendableRoots, approvalActorId if different from self owner).
Adds the room to `access.rooms`. Updates access.json. Regenerates settings for that room.

### `add-peer <channelId> <peerBotUserId> <name> <blurb>`

Adds a peer agent to the room's `participants` map. The server re-reads access.json immediately.
Example: `/knock-knock:room add-peer 846209781206941736 123456789 agent-C "schema specialist — auth schema, DB migrations"`

Parse: channelId, peerBotUserId, name (next token), blurb (rest of string after name).

### `remove-peer <channelId> <peerBotUserId>`

Deletes `rooms[channelId].participants[peerBotUserId]`. Write back.

### `add-human <channelId> <userId>`

Adds a human's Discord user ID to `rooms[channelId].humans`. Humans can drive the agent
in-room without needing a peer bot identity.

### `rm-human <channelId> <userId>`

Removes the human from the room's `humans` list.

---

## CC settings file format

Write to `~/.claude/channels/knock-knock/rooms/<channelId>.settings.json`:

```json
{
  "permissions": {
    "allow": ["<list of allowed tool patterns>"],
    "ask": ["<list of patterns needing human approval>"],
    "deny": ["<list of always-blocked patterns>"]
  }
}
```

**Default safe profile** (use if user doesn't specify, or as the deny-floor):
```json
{
  "permissions": {
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

`knock-knock` is a **custom channel** you run locally, so it launches via
`--dangerously-load-development-channels server:knock-knock` — **not** `--channels`.
Why: `--channels` is the allowlist-only flag for official channels and requires a
`plugin:<name>@<marketplace>` tag; a dev/local plugin has no marketplace, so
`plugin:knock-knock` is rejected with *"--channels entries must be tagged"*. The
two valid entry forms are `plugin:<name>@<marketplace>` and `server:<name>` (a bare
MCP server) — we use the latter.

The full invocation also needs an inline `--mcp-config` (the plugin's own
`.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}`, which is undefined on the `server:` path)
plus the room's `--settings`. That's too long to paste reliably — terminal
line-wraps split it into two commands (the telltale
`option '--settings' argument missing` + `permission denied: …settings.json` pair).
So the repo ships a self-locating launcher: **`scripts/launch-room.sh`**.

Resolve the knock-knock checkout path: run `echo "$CLAUDE_PLUGIN_ROOT"`. If it's
empty, ask the user for the absolute path to their knock-knock checkout. Call the
result `<pluginDir>`.

After writing files, print:

```
Agent identity:  <name>  (<blurb>)
Room channel:    <channelId>
Settings file:   ~/.claude/channels/knock-knock/rooms/<channelId>.settings.json
Owner Discord:   <ownerUserId>

Launch command (one line — don't let your terminal split it):
  bash <pluginDir>/scripts/launch-room.sh <channelId>

On first launch, approve the one-time dev-channel confirmation prompt. When the
bot connects you'll see `knock-knock: gateway connected as <bot>#1234` in stderr.

Prefer the raw command? It is exactly (the `\` line-continuations keep it one
logical command — keep them if you paste it):
  claude --dangerously-load-development-channels server:knock-knock \
    --mcp-config '{"mcpServers":{"knock-knock":{"command":"bun","args":["run","--cwd","<pluginDir>","--shell=bun","--silent","start"]}}}' \
    --settings ~/.claude/channels/knock-knock/rooms/<channelId>.settings.json
```

> Once knock-knock is published to a plugin marketplace, the channel entry becomes
> `plugin:knock-knock@<marketplace>` — but custom channels stay behind
> `--dangerously-load-development-channels` until they're on Anthropic's official
> allowlist, so `scripts/launch-room.sh` keeps working unchanged.

---

## Implementation notes

- Always Read access.json before Write — don't clobber other fields.
- Pretty-print JSON (2-space indent).
- `sendableRoots` should be absolute paths. If the user gives a relative path,
  note they should use the absolute path and ask them to confirm.
- The server re-reads access.json on every inbound message, so room changes take
  effect without restart. Settings file changes require restarting the CC session.
- Don't generate a separate settings file per peer-add — only on `setup` or `join`.
