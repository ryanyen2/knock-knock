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

knock-knock has two runtime modes that share `lib.ts` and `state.ts` but diverge entirely after that:

**Relay mode** (`relay.ts`) — the active, maintained path. `relay.ts` is a thin **supervisor**: it reads the v2 access file and spawns one `AgentHost` (`agent-host.ts`) per configured agent. Each `AgentHost` owns its own Discord client, token, runtime, workspace, rooms, driver map, and `Approvals` service — so one process hosts N bots. Message flow within a host:

```
Discord → AgentHost (gate/route/loop-guard) → Driver (session queue + turn formatting) → AgentAdapter → agent runtime
                                                                                       ↑
                                  Approvals (Discord buttons/reactions, per-agent owner) ┘
```

**Channel mode** (`server.ts`) — the legacy path. knock-knock runs as an MCP subprocess spawned by Claude Code with `--dangerously-load-development-channels`. Do not extend this path; kept only for backwards compatibility.

### Multi-agent model (`AgentHost`)

`relay.ts` boots one `AgentHost` per entry in `access.agents`. A host re-reads the live access file on each inbound message, so room/peer changes take effect without a restart. The `AgentAdapter` seam is untouched: the host calls `makeAdapter(agent.runtime, {workspace})` exactly as the single-agent relay did.

### Collaborative turn layer (`driver.ts` + `lib.ts`, seam-preserving)

Identity, the `owner > human > peer` priority, the peer roster, and a per-message `<channel kind=…>` envelope are injected by **formatting the prompt `text`** passed to `adapter.prompt` — never by changing the seam. `Driver` takes an optional `PreambleContext`; on the first turn of a session it prepends `buildPreamble(ctx)`, and every turn is wrapped via `wrapEnvelope(meta, text)`. Both are pure functions in `lib.ts`. The preamble drops MCP-only tool references (no `reply`/`fetch_messages`/`react`/etc.) since the relay posts text directly.

### Agent↔agent loop guard (`lib.ts`)

`loopGuard(state, kind, now, opts)` is a local per-room heuristic (the two collaborating relays share no cross-machine state). Owner/human messages always pass and reset the counter; agent messages are denied once `consecutiveAgentTurns >= maxConsecutive` (default 4) or within `cooldownMs` (default 8s) of the last agent reply. `AgentHost` holds `loopState: Map<channelId, LoopGuardState>` and consults it before enqueuing a turn. Presence: 👀 reaction while working (never ✅/❌ — those are approval-reserved).

### The AgentAdapter seam (`agent-adapter.ts`)

The interface between the relay/driver and any agent runtime. Three methods only: `applyPolicy`, `onPermissionRequest`, `prompt`. The relay and driver **never** import any agent SDK directly — they speak only this interface. This contract must not change; adding a new runtime means writing a new adapter, nothing else.

Implementations in `adapters/`:
- `claude-sdk.ts` — in-process Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK enforces `deny` natively via `disallowedTools`; `ask` is routed through `canUseTool`.
- `acp.ts` (`AcpAdapter`) — universal out-of-process adapter. Spawns any ACP-speaking agent as a subprocess and drives it over JSON-RPC on stdio using `@agentclientprotocol/sdk`. One file drives Claude Code, OpenCode, Codex, Gemini, and Cursor.
- `opencode.ts` — legacy HTTP adapter; superseded by `acp.ts`.

`adapters/index.ts` is the factory: `makeAdapter(name, {workspace})` selects the runtime, where `name` is the agent's `runtime` field from `access.json` (or `KNOCK_KNOCK_AGENT` for legacy single-agent installs). The host calls it once per session.

### Permission model and `classifyTool` (`lib.ts`)

The room's permission profile (`allow` / `ask` / `deny`) uses Claude Code-style `Tool(arg)` glob patterns. For the SDK adapter, `deny` patterns go straight into `disallowedTools` and `allow` into `allowedTools`; `ask` is routed via `canUseTool`. For the ACP adapter, the SDK is not in play — so `classifyTool()` in `lib.ts` does the matching on every `requestPermission` callback.

Two non-obvious rules baked into `classifyTool`:
1. **Deny tier checks `denyLiteralHit` first**, before tool-name matching, so a dangerous command is blocked regardless of what `ToolKind` the agent labels it (observed in the wild: same `rm -rf` arriving as both `execute` and `other`).
2. **Unmatched tools default to `ask`** — an unknown tool must never silently auto-run.

The ACP `requestPermission` payload carries an empty `rawInput: {}`; the actual command arrives in a preceding `tool_call_update` event keyed by `toolCallId`. `AcpAdapter` tracks these in a per-turn map and merges them at decision time.

### State layout

All persistent config lives in `~/.claude/channels/knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — **v2 schema**: `{ version: 2, agents: Record<agentKey, AgentConfig>, …global fields }`. Each `AgentConfig` carries `ownerUserId`, `blurb`, `runtime`, `workspace`, `tokenEnv` (the *name* of the env var holding the token, never the token), and `rooms`. Written only by the setup CLI or skills — never mutated from channel messages (prompt-injection protection).
- `rooms/<agentKey>/<channelId>.settings.json` — the permission profile for a room (`allow`/`ask`/`deny`), written **flat** (top-level keys, not nested under `permissions`). Read fresh on each inbound message.
- `.env` — bot tokens (one per agent, keyed by each agent's `tokenEnv`) and any other secrets.

`state.ts` is the only module that reads/writes these files. `lib.ts` holds all pure decision logic and has no I/O.

**Migration & compatibility:** `readAccessFileV2()` migrates the legacy single-`self` shape to a one-entry `agents` map **on read** (non-destructive — the file isn't rewritten), falling back to `KNOCK_KNOCK_AGENT`/`KNOCK_KNOCK_WORKSPACE` for the runtime/workspace. `readRoomSettings(agentKey, channelId)` tries the per-agent path first, falls back to the legacy `rooms/<channelId>.settings.json`, and accepts both nested (`{permissions:{…}}`, skill-written) and flat (CLI-written) profiles.

### Setup (`setup.ts`)

`bun setup.ts` is the standalone, agent-agnostic setup CLI, built on `@clack/prompts` (+ `picocolors`). With no args it runs an interactive flow: a guided wizard on first run (agent → room → token), then an action menu once agents exist for adding agents, rooms, peers, humans, or updating bot tokens. It writes the v2 `agents` shape and flat permission profiles via `readAccessFileV2`/`saveAccessV2`; tokens are masked on input and stored in `.env` under each agent's derived `tokenEnv`. The Claude Code skills (`skills/configure`, `skills/room`, `skills/access`) write the same files for single-agent setups.

### The deny floor

The deny floor is **only enforced if the agent asks before running tools**. The SDK enforces it natively; ACP agents must be configured to ask-first (never yolo/bypass mode). See `docs/getting-started-agents.md` for per-agent configuration.

## Environment variables

In the v2 model, each agent's runtime, workspace, and token-env-var name live in `access.json`; the token value itself lives in `.env`. The `KNOCK_KNOCK_*` variables below are the **legacy single-agent** path — still honored as fallbacks by `readAccessFileV2`'s migration.

| Variable | Required | Purpose |
|---|---|---|
| `<tokenEnv>` (e.g. `DISCORD_BOT_TOKEN`) | yes | Discord bot token; the env-var *name* is set per agent via `tokenEnv` |
| `KNOCK_KNOCK_WORKSPACE` | legacy only | Workspace path for migrated single-agent installs (v2 uses `agent.workspace`) |
| `KNOCK_KNOCK_AGENT` | legacy only | Runtime for migrated single-agent installs (v2 uses `agent.runtime`): `claude-sdk` (default), `claude-acp`, `opencode`, `codex`, `gemini`, `acp` |
| `KNOCK_KNOCK_STATE_DIR` | no | Override the state directory (default `~/.claude/channels/knock-knock`) |
| `KNOCK_KNOCK_ACP_COMMAND` | when `runtime=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
