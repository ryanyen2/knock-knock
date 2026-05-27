# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test              # run lib.test.ts (pure decision logic, no Discord/network)
bun run typecheck     # tsc --noEmit
bun relay.ts          # start the relay (requires KNOCK_KNOCK_WORKSPACE)
bun test --test-name-pattern "T3"  # run a single test by name
```

## Architecture

knock-knock has two runtime modes that share `lib.ts` and `state.ts` but diverge entirely after that:

**Relay mode** (`relay.ts`) — the active, maintained path. A standalone process that owns the Discord client and drives a coding agent via the `AgentAdapter` seam. Message flow:

```
Discord → relay.ts (gate/route) → Driver (session queue) → AgentAdapter → agent runtime
                                                         ↑
                     Approvals (Discord buttons/reactions) ──────────────┘
```

**Channel mode** (`server.ts`) — the legacy path. knock-knock runs as an MCP subprocess spawned by Claude Code with `--dangerously-load-development-channels`. Do not extend this path; kept only for backwards compatibility.

### The AgentAdapter seam (`agent-adapter.ts`)

The interface between the relay/driver and any agent runtime. Three methods only: `applyPolicy`, `onPermissionRequest`, `prompt`. The relay and driver **never** import any agent SDK directly — they speak only this interface. This contract must not change; adding a new runtime means writing a new adapter, nothing else.

Implementations in `adapters/`:
- `claude-sdk.ts` — in-process Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK enforces `deny` natively via `disallowedTools`; `ask` is routed through `canUseTool`.
- `acp.ts` (`AcpAdapter`) — universal out-of-process adapter. Spawns any ACP-speaking agent as a subprocess and drives it over JSON-RPC on stdio using `@agentclientprotocol/sdk`. One file drives Claude Code, OpenCode, Codex, Gemini, and Cursor.
- `opencode.ts` — legacy HTTP adapter; superseded by `acp.ts`.

`adapters/index.ts` is the factory: `KNOCK_KNOCK_AGENT` env var selects the runtime; the relay calls `makeAdapter(name, {workspace})` once per session.

### Permission model and `classifyTool` (`lib.ts`)

The room's permission profile (`allow` / `ask` / `deny`) uses Claude Code-style `Tool(arg)` glob patterns. For the SDK adapter, `deny` patterns go straight into `disallowedTools` and `allow` into `allowedTools`; `ask` is routed via `canUseTool`. For the ACP adapter, the SDK is not in play — so `classifyTool()` in `lib.ts` does the matching on every `requestPermission` callback.

Two non-obvious rules baked into `classifyTool`:
1. **Deny tier checks `denyLiteralHit` first**, before tool-name matching, so a dangerous command is blocked regardless of what `ToolKind` the agent labels it (observed in the wild: same `rm -rf` arriving as both `execute` and `other`).
2. **Unmatched tools default to `ask`** — an unknown tool must never silently auto-run.

The ACP `requestPermission` payload carries an empty `rawInput: {}`; the actual command arrives in a preceding `tool_call_update` event keyed by `toolCallId`. `AcpAdapter` tracks these in a per-turn map and merges them at decision time.

### State layout

All persistent config lives in `~/.claude/channels/knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — bot identity, room membership, peers, DM policy. Written only by skills; never mutated from channel messages (prompt-injection protection).
- `rooms/<channelId>.settings.json` — the permission profile for a room (`allow`/`ask`/`deny`). Read fresh on each inbound message.
- `.env` — `DISCORD_BOT_TOKEN` and any other secrets.

`state.ts` is the only module that reads/writes these files. `lib.ts` holds all pure decision logic and has no I/O.

### The deny floor

The deny floor is **only enforced if the agent asks before running tools**. The SDK enforces it natively; ACP agents must be configured to ask-first (never yolo/bypass mode). See `docs/getting-started-agents.md` for per-agent configuration.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Discord bot token |
| `KNOCK_KNOCK_WORKSPACE` | yes | Absolute path of the agent's working directory |
| `KNOCK_KNOCK_AGENT` | no | Agent runtime: `claude-sdk` (default), `claude-acp`, `opencode`, `codex`, `gemini`, `acp` |
| `KNOCK_KNOCK_ACP_COMMAND` | when `AGENT=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
