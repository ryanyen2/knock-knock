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

1. **Token(s)** — check `~/.claude/channels/knock-knock/.env`. For each agent in
   `access.json`, check whether `agents[key].tokenEnv` is set in `.env`.
   Show set/not-set; if set, show last 4 chars only (mask the rest).

2. **Access** — read `~/.claude/channels/knock-knock/access.json` (missing = defaults).
   Show:
   - Each configured agent (key, blurb, token env var, rooms count)
   - DM policy and what it means
   - Allowed senders (count + list)
   - Pending pairings (codes + sender IDs + age)

3. **What next** — concrete next step based on state:
   - No agents configured → *"Run `/knock-knock:room setup` to configure your first agent,
     or `bun setup.ts agent add` if not using Claude Code."*
   - Agent configured, token missing → *"Run `/knock-knock:configure <token>` or
     `bun setup.ts configure` to save the Discord bot token."*
   - Token set, rooms configured → *"Ready. Start the relay: `bun relay.ts`"*

> For managing **multiple agents** (multiple bot identities), use `bun setup.ts`
> rather than this skill — it supports all agent types without requiring Claude Code.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the bot token (trim whitespace). Starts with `MT` or `Nz`.
2. `mkdir -p ~/.claude/channels/knock-knock`
3. Read existing `.env` if present; update/add `DISCORD_BOT_TOKEN=` line, preserve other keys.
   Write back — no quotes around the value.
4. `chmod 600 ~/.claude/channels/knock-knock/.env` — credentials must be owner-only.
5. Confirm, then show the no-args status.

The relay reads `.env` at startup — token changes require restarting `bun relay.ts`.

### `clear` — remove the token

Delete the `DISCORD_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- Missing state dir or .env = not configured, not an error.
- `access.json` is re-read on every inbound message — policy changes take effect immediately.
