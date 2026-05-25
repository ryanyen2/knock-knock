---
name: configure
description: Set up the knock-knock bot token — save it and review channel status. Use when the user pastes a Discord bot token, asks to configure knock-knock, or wants to check setup status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /knock-knock:configure — Bot Token Setup

Writes the bot token to `~/.claude/channels/knock-knock/.env` and shows status.
State dir: `~/.claude/channels/knock-knock/`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

1. **Token** — check `~/.claude/channels/knock-knock/.env` for `DISCORD_BOT_TOKEN`.
   Show set/not-set; if set, show first 6 chars only (mask the rest).

2. **Access** — read `~/.claude/channels/knock-knock/access.json` (missing = defaults).
   Show:
   - Agent identity (`self.name`, `self.roomChannelId`)
   - DM policy and what it means
   - Allowed senders (count + list)
   - Pending pairings (codes + sender IDs + age)
   - Rooms registered (count)

3. **What next** — concrete next step based on state:
   - No token → *"Run `/knock-knock:configure <token>` with your bot token from the
     Developer Portal → Bot → Reset Token."*
   - Token set, no rooms → *"Run `/knock-knock:room setup` to configure your agent
     identity and join a room."*
   - Token set, rooms configured → *"Ready. Launch with the command from `/knock-knock:room`."*

### `<token>` — save it

1. Treat `$ARGUMENTS` as the bot token (trim whitespace). Starts with `MT` or `Nz`.
2. `mkdir -p ~/.claude/channels/knock-knock`
3. Read existing `.env` if present; update/add `DISCORD_BOT_TOKEN=` line, preserve other keys.
   Write back — no quotes around the value.
4. `chmod 600 ~/.claude/channels/knock-knock/.env` — credentials must be owner-only.
5. Confirm, then show the no-args status.

The server reads `.env` once at boot — token changes need a session restart or
`/reload-plugins`.

### `clear` — remove the token

Delete the `DISCORD_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- Missing state dir or .env = not configured, not an error.
- `access.json` is re-read on every inbound message — policy changes take effect immediately.
