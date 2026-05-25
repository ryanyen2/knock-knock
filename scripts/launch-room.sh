#!/usr/bin/env bash
# knock-knock — launch a Claude Code agent into a collaboration room.
#
# Usage:
#   bash scripts/launch-room.sh <channelId> [extra claude args...]
#
# What it does:
#   - resolves the knock-knock checkout from this script's own location,
#   - registers the knock-knock MCP server as a *development* channel,
#   - applies the room's permission profile via --settings,
#   - forwards any extra args to `claude`.
#
# Why a script instead of a pasted one-liner:
#   The launch command spans several flags and an inline JSON blob. Pasting that
#   across terminal line-wraps splits it into two commands (the classic
#   "option '--settings' argument missing" + "permission denied: ...settings.json"
#   pair). A single `bash …/launch-room.sh <id>` can't be split, and it
#   self-locates the plugin dir so there are no absolute paths to keep in sync.
set -euo pipefail

CHANNEL_ID="${1:-}"
if [[ -z "$CHANNEL_ID" ]]; then
  echo "usage: bash scripts/launch-room.sh <channelId> [extra claude args...]" >&2
  echo "  <channelId> is the Discord channel ID configured via /knock-knock:room setup" >&2
  exit 2
fi
shift

# Absolute path to the knock-knock checkout. This script lives in <root>/scripts,
# so the parent of its directory is the plugin root — no hardcoded paths.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STATE_DIR="${KNOCK_KNOCK_STATE_DIR:-$HOME/.claude/channels/knock-knock}"
SETTINGS="$STATE_DIR/rooms/$CHANNEL_ID.settings.json"

if [[ ! -f "$SETTINGS" ]]; then
  echo "error: no permission profile for room $CHANNEL_ID" >&2
  echo "  expected: $SETTINGS" >&2
  echo "  run \`/knock-knock:room setup\` (or \`join $CHANNEL_ID\`) first." >&2
  exit 1
fi

# `server:knock-knock` points at the MCP server defined below. We pass it inline
# with an absolute --cwd on purpose: the plugin's own .mcp.json uses
# ${CLAUDE_PLUGIN_ROOT}, which is only defined when knock-knock is loaded as a
# plugin — NOT on the bare `server:` path the dev-channel flag uses.
MCP_CONFIG="{\"mcpServers\":{\"knock-knock\":{\"command\":\"bun\",\"args\":[\"run\",\"--cwd\",\"$PLUGIN_DIR\",\"--shell=bun\",\"--silent\",\"start\"]}}}"

echo "knock-knock: launching room $CHANNEL_ID" >&2
echo "  plugin:   $PLUGIN_DIR" >&2
echo "  settings: $SETTINGS" >&2
echo "  (custom channels prompt once to confirm the dev-load — approve it.)" >&2

# Custom channels you build are NOT on the official allowlist, so they load via
# --dangerously-load-development-channels (not --channels, which is allowlist-only
# and requires a plugin:<name>@<marketplace> tag).
exec claude \
  --dangerously-load-development-channels server:knock-knock \
  --mcp-config "$MCP_CONFIG" \
  --settings "$SETTINGS" \
  "$@"
