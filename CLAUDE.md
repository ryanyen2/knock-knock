# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test              # run lib.test.ts (pure decision logic, no Discord/network)
bun run typecheck     # tsc --noEmit
bun relay.ts          # start the relay (reads agents from access.json)
bun setup.ts          # interactive setup wizard/menu
bun test --test-name-pattern "T3"  # run a single test by name
```

## Architecture

knock-knock is a standalone Bun **relay** process. `relay.ts` is a thin
**supervisor**: it reads the access file and spawns one `AgentHost`
(`agent-host.ts`) per configured agent. Each `AgentHost` owns its own Discord
client, token, runtime, workspace, rooms, driver map, and `Approvals` service —
so one process hosts N bots. Message flow within a host:

```
Discord → AgentHost (gate/route/loop-guard) → Driver (session queue + turn formatting) → AgentAdapter → agent runtime
                                                                                       ↑
                                  Approvals (Discord buttons/reactions, per-agent owner) ┘
```

### Multi-agent model (`AgentHost`)

`relay.ts` boots one `AgentHost` per entry in `access.agents`. A host re-reads
the live access file on each inbound message, so room/peer changes take effect
without a restart. The host selects a runtime by calling
`makeAdapter(agent.runtime, {workspace})`.

### Collaborative turn layer (`driver.ts` + `lib.ts`)

Identity, the `owner > human > peer` priority, the peer roster, and a per-message
`<channel kind=…>` envelope are injected by **formatting the prompt `text`**
passed to `adapter.prompt` — the `AgentAdapter` seam stays a plain
prompt/response contract. `Driver` takes an optional `PreambleContext`; on the
first turn of a session it prepends `buildPreamble(ctx)`, and every turn is
wrapped via `wrapEnvelope(meta, text)`. Both are pure functions in `lib.ts`.

### Agent↔agent loop guard (`lib.ts`)

`loopGuard(state, kind, now, opts)` is a local per-room heuristic (two
collaborating relays share no cross-machine state). Owner/human messages always
pass and reset the counter; agent messages are denied once
`consecutiveAgentTurns >= maxConsecutive` (default 4) or within `cooldownMs`
(default 8s) of the last agent reply. `AgentHost` holds
`loopState: Map<channelId, LoopGuardState>` and consults it before enqueuing a
turn. Presence: 👀 reaction while working (never ✅/❌ — those are
approval-reserved).

### The AgentAdapter seam (`agent-adapter.ts`)

The interface between the relay/driver and any agent runtime. Three methods
only: `applyPolicy`, `onPermissionRequest`, `prompt`. The relay and driver
**never** import any agent SDK directly — they speak only this interface. Adding
a new runtime means writing a new adapter, nothing else.

Implementations in `adapters/`:
- `claude-sdk.ts` — in-process Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK enforces `deny` natively via `disallowedTools`; `ask` is routed through `canUseTool`.
- `acp.ts` (`AcpAdapter`) — universal out-of-process adapter. Spawns any ACP-speaking agent as a subprocess and drives it over JSON-RPC on stdio using `@agentclientprotocol/sdk`. One file drives Claude Code, OpenCode, Codex, Gemini, and Cursor.

`adapters/index.ts` is the factory: `makeAdapter(runtime, {workspace})` selects
the runtime from the agent's `runtime` field in `access.json`. The host calls it
once per session.

### Permission model and `classifyTool` (`lib.ts`)

The room's permission profile (`allow` / `ask` / `deny`) uses Claude Code-style
`Tool(arg)` glob patterns. For the SDK adapter, `deny` patterns go straight into
`disallowedTools` and `allow` into `allowedTools`; `ask` is routed via
`canUseTool`. For the ACP adapter, the SDK is not in play — so `classifyTool()`
in `lib.ts` does the matching on every `requestPermission` callback.

Two non-obvious rules baked into `classifyTool`:
1. **Deny tier checks `denyLiteralHit` first**, before tool-name matching, so a dangerous command is blocked regardless of what `ToolKind` the agent labels it (the same `rm -rf` can arrive as both `execute` and `other`).
2. **Unmatched tools default to `ask`** — an unknown tool must never silently auto-run.

The ACP `requestPermission` payload carries an empty `rawInput: {}`; the actual
command arrives in a preceding `tool_call_update` event keyed by `toolCallId`.
`AcpAdapter` tracks these in a per-turn map and merges them at decision time.

### State layout

All persistent config lives in `~/.claude/channels/knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — `{ agents: Record<agentKey, AgentConfig>, mentionPatterns?, ackReaction? }`. Each `AgentConfig` carries `ownerUserId`, `blurb`, `runtime`, `workspace`, `tokenEnv` (the *name* of the env var holding the token, never the token), and `rooms`. Written only by the setup CLI — never mutated from channel messages (prompt-injection protection).
- `rooms/<agentKey>/<channelId>.settings.json` — the permission profile for a room, written **flat** (top-level `allow`/`ask`/`deny`). Read fresh on each inbound message.
- `.env` — bot tokens (one per agent, keyed by each agent's `tokenEnv`) and any other secrets.

`state.ts` is the only module that reads/writes these files. `lib.ts` holds all
pure decision logic and has no I/O.

### Setup (`setup.ts`)

`bun setup.ts` is the standalone, agent-agnostic setup CLI, built on
`@clack/prompts` (+ `picocolors`). With no args it runs an interactive flow: a
guided wizard on first run (agent → room → token), then an action menu once
agents exist for adding agents, rooms, peers, humans, or updating bot tokens. It
writes the `agents` shape and flat permission profiles via
`readAccessFile`/`saveAccess`; tokens are masked on input and stored in `.env`
under each agent's derived `tokenEnv`.

### The deny floor

The deny floor is **only enforced if the agent asks before running tools**. The
SDK enforces it natively; ACP agents must be configured to ask-first (never
yolo/bypass mode). See `docs/getting-started-agents.md` for per-agent
configuration.

## Environment variables

Each agent's runtime, workspace, and token-env-var name live in `access.json`;
the token value itself lives in `.env`.

| Variable | Required | Purpose |
|---|---|---|
| `<tokenEnv>` (e.g. `DISCORD_BOT_TOKEN`) | yes | Discord bot token; the env-var *name* is set per agent via `tokenEnv` |
| `KNOCK_KNOCK_STATE_DIR` | no | Override the state directory (default `~/.claude/channels/knock-knock`) |
| `KNOCK_KNOCK_ACP_COMMAND` | when `runtime=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
