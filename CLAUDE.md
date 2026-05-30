# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test              # all tests: pure decision logic (lib.test.ts) + the ledger suite
bun run typecheck     # tsc --noEmit
bun relay.ts          # start the relay (reads agents from access.json)
bun setup.ts          # interactive setup wizard/menu
bun test ledger/render/surface.test.ts   # run one test file
bun test --test-name-pattern "conflict"  # run tests matching a name
```

## Architecture

knock-knock is a standalone Bun **relay** process built on a **ledger-native**
core: the only thing persisted is an append-only, content-addressed DAG of
**Interactions**, and everything else — a channel's transcript, what an agent
knows, a concept's runtime state, an artifact's current version — is a **fold**
(projection) over that log. `relay.ts` is a thin supervisor; behavior is added
as **synchronizations**, not imperative branches.

`relay.ts` boots, once per machine:
- **one shared `Store`** — `ledger/store-sqlite.ts` by default, `ledger/store-pg.ts`
  when `KNOCK_KNOCK_LEDGER_URL` is set (cross-machine via Postgres `LISTEN/NOTIFY`).
- **one `FoldEngine`** with the concept + artifact folds registered.
- **one `Synchronizer`** with the synchronizations registered.
- **N `AgentHost`s** — one per entry in `access.agents`, each owning its Discord
  client, token, runtime, workspace, and rooms.

Inbound/outbound flow is entirely ledger-driven:

```
Discord → AgentHost.handleInbound (gate) → admit(channel.message)
  → prompt-on-message → admit(turn.prompted)         [loop-guard fold consulted here]
  → drive-turn → AgentAdapter.prompt → tool.* / turn.replied admissions
  → post-on-reply → Discord post (under an external_claim)
```

The deep design (Interaction record, content addressing, role-ordered merge,
fold engine, cutover phases, cross-machine) lives in
**`docs/knock-knock-ledger-model.md`** — read it before changing the ledger.

### The ledger (`ledger/`)

- `interaction.ts` — the one persisted shape: `{actor, role, channel, target,
  verb, patch, effect, caused_by, …}`, content-addressed by hash. `role` is
  snapshotted at admission so replay is deterministic. `ROLE_RANK` = owner 3 >
  human 2 > agent 1.
- `canonical.ts` — `hashInteraction` (sorted-key canonical JSON over the
  immutable fields only; bookkeeping like `lifecycle`/`createdAt` is excluded).
- `store.ts` + `store-sqlite.ts` / `store-pg.ts` — the `Store` interface and its
  two backends (same contract; folds/merge/sync never know which is in play).
- `capture.ts` (`Ledger.record`) appends with `lifecycle: 'applied'`;
  `admit.ts` (`admit`) is the gate — runs the role-ordered `merge.ts`, sets
  `applied | denied | proposed`, supersedes losers, and surfaces supersession
  back to the loser's `know:actor/<actor>/inbox`.
- `fold.ts` — `FoldEngine`: register a `Fold`, it replays the log and stays live
  on every insert. `engine.get(name)` is synchronous after registration.
- `sync.ts` — the `Synchronizer`: for each newly-admitted Interaction, every
  `Synchronization` whose `matches(i)` is true fires; follow-ups go through
  `ctx.admit` under a per-wave cap (default 16). Errors are isolated per sync.

### Concepts, artifacts, synchronizations

A **concept**'s state *is* its named fold; nothing else. Registered in
`relay.ts`: `loop-guard`, `channel`, `turn`, `approval` (`ledger/concepts/`) and
the `knowledge` artifact fold (`ledger/artifacts/`). Folds **reuse the pure
functions in `lib.ts` verbatim** (e.g. `LoopGuard.step` calls `loopGuard(...)`).

Each behavior is one file in `ledger/synchronizations/` (rubric: a new behavior
= one new synchronization, zero edits to concepts). Registered today:
`classify-on-tool-request`, `prompt-on-message`, `drive-turn`, `post-on-reply`,
`dm-on-supersede` (§4.4), `conflict-card` (§4.2), `retry-on-reaction` (§4.5).

### The AgentAdapter seam (`agent-adapter.ts`)

The interface between the relay/driver and any agent runtime — four methods:
`applyPolicy`, `onPermissionRequest`, `onEvent`, `prompt`. The relay/driver
**never** import an agent SDK; they speak only this interface. Adding a runtime
means writing a new adapter, nothing else. Implementations in `adapters/`:
- `claude-sdk.ts` — in-process Claude Agent SDK. The SDK enforces `deny`
  natively via `disallowedTools`; `ask` is routed through `canUseTool`.
- `acp.ts` (`AcpAdapter`) — universal out-of-process adapter. Spawns any
  ACP-speaking agent and drives it over JSON-RPC on stdio. One file drives
  Claude Code, OpenCode, Codex, Gemini, Cursor.

`adapters/index.ts` is the factory: `makeAdapter(runtime, {workspace})` selects
the runtime from the agent's `runtime` field. `AgentHost` calls it per session.

### `AgentHost` (`agent-host.ts`)

A Discord ↔ ledger adapter. Inbound: `handleInbound` gates the message
(`guildSenderAllowed`, rate cap, mention check) and admits a `channel.message`
— the synchronizer chain does the rest. It also owns the per-channel `Driver`
session (adapter instances are per-process) and the live `Approvals` service,
and exposes callbacks the synchronizations call back into (`getDriveHandle`,
`discordSend`, `postConflictCard`, `dmUser`, `updatePill`).

### Permission model and `classifyTool` (`lib.ts`)

The room's profile (`allow` / `ask` / `deny`) uses Claude Code-style `Tool(arg)`
glob patterns. SDK adapter: `deny` → `disallowedTools`, `allow` →
`allowedTools`, `ask` → `canUseTool`. ACP adapter: the SDK isn't in play, so
`classifyTool()` matches on every `requestPermission`. Two non-obvious rules:

1. **Deny tier checks `denyLiteralHit` first**, before tool-name matching, so a
   dangerous command is blocked regardless of the `ToolKind` the agent labels it
   (the same `rm -rf` can arrive as both `execute` and `other`).
2. **Unmatched tools default to `ask`** — an unknown tool must never silently
   auto-run.

ACP detail: a tool's subject (command / path) may arrive in `rawInput`, the
`content` blocks, or `locations` — `AcpAdapter` probes all three and merges
across `tool_call_update`s so deny patterns match regardless of where the agent
put it.

### §4 Discord surface (`ledger/render/` + synchronizations + `AgentHost` glue)

Visual cues that surface already-captured ledger state. Pure renderers live in
`ledger/render/` (no I/O, unit-tested like `lib.ts`); surfacing is a
synchronization or an `AgentHost` subscriber; Discord I/O is thin glue.
`GLYPHS` in `ledger/render/surface.ts` is the single visual vocabulary.

- **Attribution line** (`reply-annotations.ts`) + **stale-note flag** — appended
  to outbound text in `post-on-reply` from `caused_by` and the knowledge fold.
- **Workbench** (`renderWorkbench`/`workbenchEntries`) — one pinned per-channel
  activity log, driven by a relay-level subscriber on `turn.*`/`tool.*` →
  `AgentHost.updatePill` (throttled). A finished turn keeps its step log as a
  trace (status `working|done|failed`).
- **Conflict card** (`conflict-card.ts`) — on a held equal-role conflict, posts a
  Take A / Take B / Write card; the `cflt:` button handler admits an owner
  `merge.resolve`.
- **Override DM** (`dm-on-supersede.ts`) — DMs the losing agent's owner when the
  merge gate writes a supersession note to its inbox.
- **Rewind reactions** (`retry-on-reaction.ts`) — ⏪ / 🔁 / 🧷 on a bot message;
  🔁 retry re-runs the turn, ⏪/🧷 are recorded for the audit trail.
- **Stop** — owner reacts 🛑 → `AgentHost.handleStop` aborts the channel's
  in-flight turn via an `AbortController` plumbed through `Driver.runTurn` into
  `AgentAdapter.prompt({signal})`; the SDK adapter forwards it as
  `options.abortController`, the ACP adapter calls `conn.cancel({sessionId})`.
  `runTurnForChannel` then posts a short "Stopped" note and marks the outcome.

Presence: 👀 while working (received), swapped for a persistent 🏁 done / ⚠️
failed / ⏹ stopped reaction on the inbound message. **✅/❌ are
approval-reserved** (the button/reaction handlers route them to `Approvals`) and
🛑 is the owner's stop signal — never reuse them for status.

### Session sharing (`sessions/` + `AgentHost` glue)

An owner can import the distilled context of one of their *local* coding-agent
sessions (Claude Code / Codex / OpenCode / Gemini) into a channel, so a
collaborating agent — including a teammate on another machine — starts from the
prior plan, decisions, and pitfalls instead of cold. See
**`docs/session-sharing.md`** for the full flow and security model.

- **The read seam** (`sessions/`) mirrors `adapters/`: one best-effort
  `SessionStore` per runtime reads that runtime's on-disk transcript
  (`~/.claude/projects`, `~/.codex/sessions`, `~/.local/share/opencode`,
  `~/.gemini/tmp/<sha256(cwd)>`), normalizing to a common transcript. A missing
  dir or unreadable file degrades to fewer results, never throws. `list()`
  filters to the agent's `workspace` (privacy). `sessions/index.ts` is the
  factory + `listAllSessions` fan-out.
- **Distill** (`sessions/distill.ts`, pure) → a context brief (latest
  ExitPlanMode plan, TodoWrite todos, decisions, files touched, dead-ends).
- **Trigger** — owner-only: `handleInbound` detects `isShareSessionCommand` /
  `isResumeSessionCommand` (`kind==='owner'`) and short-circuits *before* any
  admit to post a 📥 selection card (the command is never admitted as a
  `channel.message`). The `sess:` button handler is owner-gated by `ownerUserId`.
- **Import (`sess:pick`)** — reads + distills the chosen session and admits an
  **owner-role `knowledge.append`** to `know:channel/<id>/shared-context` (anchor
  `none`, so the merge gate is a no-op and no conflict card fires) — the same
  shape `surfaceToInbox` uses. On the Postgres backend it syncs to teammates.
- **Delivery** — `pendingSharedContext` reads active shared-context notes from
  the knowledge fold and, via the pure `pickFreshContext`, injects each one
  **once** into the next turn as a `<shared-context>` block prepended (in
  `Driver.buildPrompt`) ahead of the `<channel>` envelope. (Knowledge is
  otherwise read only at reply-time, so this delivery wiring is what makes an
  imported note actually reach the agent.)
- **Resume (`sess:resume`)** — continues a live session. Offered only for
  runtime-compatible sessions (`sessionRuntimeForAgent`); `Driver.bindSession`
  sets the runtime session id to resume on the next turn (and resets the
  preamble flag so the resumed session is told the room context once). The
  `AcpAdapter` captures the `loadSession` capability at init and calls
  `conn.loadSession` for a foreign id (pure `planSessionAcquire` decides
  create/reuse/load; falls back to a fresh session if load is unsupported/fails);
  the Claude SDK adapter resumes via its `resume` option. The binding is
  persisted **locally** (`state.ts` `*.session.json`, not a synced ledger note —
  runtime sessions don't cross machines) and rebound on restart in
  `getOrCreateSession`.

📥 is the session-sharing glyph (`GLYPHS.session`); like ✅/❌/🛑 it is reserved.

### State layout

All persistent config lives in `~/.claude/channels/knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — `{ agents: Record<agentKey, AgentConfig>, mentionPatterns?, ackReaction? }`. Each `AgentConfig` carries `ownerUserId`, `blurb`, `runtime`, `workspace`, `tokenEnv` (the *name* of the env var holding the token, never the token), and `rooms`. Written only by the setup CLI — never mutated from channel messages (prompt-injection protection).
- `rooms/<agentKey>/<channelId>.settings.json` — the permission profile for a room, written **flat** (top-level `allow`/`ask`/`deny`). Read fresh on each inbound message.
- `ledger.sqlite` — the interaction DAG (when on the SQLite backend; override with `KNOCK_KNOCK_LEDGER_FILE`). Postgres is used instead when `KNOCK_KNOCK_LEDGER_URL` is set.
- `.env` — bot tokens (one per agent, keyed by each agent's `tokenEnv`) and any other secrets.

`state.ts` is the only module that reads/writes the config files; `lib.ts` holds
all pure decision logic and has no I/O; the ledger owns its own storage.

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
| `KNOCK_KNOCK_LEDGER_URL` | no | Postgres connection string; switches the ledger to the Postgres backend (cross-machine). Unset → SQLite |
| `KNOCK_KNOCK_LEDGER_FILE` | no | Override the SQLite ledger path (default `<state-dir>/ledger.sqlite`) |
| `KNOCK_KNOCK_ACP_COMMAND` | when `runtime=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
