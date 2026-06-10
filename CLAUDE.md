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
- **one shared `Store`** — `ledger/store-sqlite.ts` or `ledger/store-pg.ts`
  (cross-machine via Postgres `LISTEN/NOTIFY`), chosen by `resolveLedgerConfig`
  (`lib.ts`): `KNOCK_KNOCK_LEDGER_URL` env wins, else the setup-managed
  `settings.json` `ledger` block, else SQLite. The `Store` exposes `kind`
  (`'sqlite'|'postgres'`) for the rare behavior that must branch cross-machine.
- **one `FoldEngine`** with the concept + artifact folds registered.
- **one `Synchronizer`** with the synchronizations registered.
- **N `AgentHost`s** — one per entry in `access.agents`, each owning its Discord
  client, token, runtime, workspace, and rooms.

Inbound/outbound flow is entirely ledger-driven:

```
Discord → AgentHost.handleInbound (gate, resolve scope) → admit(channel.message)
  → prompt-on-message → admit(turn.prompted)         [loop-guard fold consulted here]
  → drive-turn → AgentAdapter.prompt → tool.* / turn.replied admissions
  → post-on-reply → Discord post (under an external_claim)
```

### Room vs scope (the one distinction to internalize)

A Discord message lives in a **scope** — a *thread*, or a plain channel. An
interaction's `channel` field **is the scope**, and almost everything keyed on
it is naturally per-task: turn lineage, approvals, watches, the knowledge fold,
the Workbench, the agent's Driver session. A top-level @mention spawns a task
thread (`threadNameFromPrompt`), so each task runs in its own scope; messages
already in a thread use that thread; owner control commands (`!watch`, `share
session`) never spawn a thread — they act in the scope they're typed in.

The **room** is the parent text channel, and it owns what is *not* per-task:
the permission profile (`rooms/<agentKey>/<roomId>.settings.json`), the roster,
the allowlist, and routing. `AgentHost.roomForScope(scopeId)` is the single seam
that resolves a scope to its room (pure core: `resolveRoomForScope` in `lib.ts`).
**Permission classification always resolves scope→room**, so a threaded turn is
governed by the same deny floor as a top-level one — it must never degrade to an
empty profile. These were one id before threads; keep them distinct.

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
`relay.ts`: `loop-guard`, `channel`, `turn`, `approval`, `watch`
(`ledger/concepts/`) and the `knowledge` + `versionable` artifact folds
(`ledger/artifacts/`). Folds **reuse the pure functions in `lib.ts` verbatim**
(e.g. `LoopGuard.step` calls `loopGuard(...)`).

Each behavior is one file in `ledger/synchronizations/` (rubric: a new behavior
= one new synchronization, zero edits to concepts). Registered today:
`classify-on-tool-request`, `prompt-on-message`, `drive-turn`, `post-on-reply`,
`dm-on-supersede` (§4.4), `conflict-card` (§4.2), `retry-on-reaction` (§4.5),
`resume-on-watch`, and the file-edit pair `capture-workspace-edit` +
`write-back-versionable` (see "File-edit sync" below).

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

`adapters/index.ts` is the factory: `makeAdapter(runtime, {workspace, watchTools,
sandbox})` selects the runtime from the agent's `runtime` field. `AgentHost`
calls it per session. When `sandbox` is set on an agent, the factory wraps an
**ACP** launch via `buildSandboxLaunch` (`sandbox.ts`, pure: macOS `sandbox-exec`,
Linux `bwrap`); the in-process `claude-sdk` can't be OS-jailed (it warns).

### `AgentHost` (`agent-host.ts` + `host/`)

A Discord ↔ ledger adapter. Inbound: `handleInbound` gates the message
(`guildSenderAllowed`, rate cap, mention check), resolves the **scope** (thread,
or channel) and **room** (parent), and admits a `channel.message` under the
scope — the synchronizer chain does the rest. It owns the per-scope `Driver`
session (adapter instances are per-process), the live `Approvals` service, the
`scopeToRoom` cache + `roomForScope`, and turn driving; it exposes callbacks the
synchronizations call back into (`getDriveHandle`, `discordSend`,
`postConflictCard`, `dmUser`, `updatePill`, `resolveWatch`).

Its cohesive UI/feature clusters are separate collaborators in `host/`, each
owning its own state and reaching shared host capabilities through the narrow
`HostContext` (`host/context.ts`): `Workbench` (§4.1 pinned activity log),
`ConflictUI` (§4.2 cards), `WatchControl` (arm/disarm/list + `resolveWatch`), and
`SessionSharing` (import + per-scope context delivery; resume stays in the host,
delegated via a callback because it's tied to the Driver/Session lifecycle).

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
3. **Profiles are keyed by room, not scope.** A tool request's `channel` is the
   task scope (a thread); the profile lives at `rooms/<agentKey>/<roomId>`. Both
   enforcement paths resolve scope→room first — the adapter's `applyPolicy` (via
   `getOrCreateSession` → `readRoomSettings(roomForScope(scope))`) and the
   audit-only `classify-on-tool-request` (relay injects a scope→room
   `readPolicy`). An unresolved room must fail restrictive, never to an empty
   profile (which would drop the deny floor).

ACP detail: a tool's subject (command / path) may arrive in `rawInput`, the
`content` blocks, or `locations` — `AcpAdapter` probes all three and merges
across `tool_call_update`s so deny patterns match regardless of where the agent
put it.

**Presets (`lib.ts`).** `PRESET_MODES` (strict / ask-per-edit / auto / bypass)
are named profiles `setup.ts` stamps into a room's settings via `expandPreset`,
**expanded at write time** so `readRoomSettings`/`classifyTool` are unchanged.
Every preset carries the `DENY_FLOOR` (so `deny` is never empty); `bypass` is
wide-open *except* the floor. A `_mode` hint is written but ignored by `parseProfile`.

**Per-actor tiers (`lib.ts` `resolveProfileForActor`).** The flat profile is the
**owner floor**; an optional `tiers` map narrows it by the **prompting actor**
(`agent` / `human` / `peer:<botId>`). Resolved **per turn** in
`runTurnForChannel` (from the inbound `senderKind`/`senderId`) and re-applied via
`Driver.runTurn(..., profile)` inside the serialized queue. Most-specific tier
wins for allow/ask; **deny is always the UNION** (a tier only tightens); an absent
tier falls back to the base, never empty. The audit `classify-on-tool-request`
stays on the base profile — safe because tier deny ⊇ base deny.

**OS sandbox (`sandbox.ts`).** `AgentConfig.sandbox = { fs: 'workspace', network }`
confines an **ACP** runtime at the OS level (writes → workspace, optional network
deny). Pure `buildSandboxLaunch` wraps the spawn in `adapters/index.ts`. Honest
limit: in-process `claude-sdk` can't be jailed — use `claude-acp` for confinement.
See **`docs/security-and-permissions.md`** for the user-facing guide.

### File-edit sync (`workspace.edit` → versionable; walking skeleton)

Two agents editing the same file converge over the ledger (no Discord
conversation), conflicts resolved by the role-ordered merge gate:
- `capture-workspace-edit` (sync) correlates a successful `tool.executed` with its
  parent `tool.requested` (which carries the Edit/Write input), builds a Yjs
  update against a live per-artifact `Y.Doc`, and admits a `workspace.edit` to
  `vers:<scope>/<relpath>` with a stable whole-file anchor `{range,0,0}` (so
  concurrent whole-file edits contend) and `caused_by` chained onto the artifact's
  applied edits (so sequential edits don't). `effect: 'workspace'` → through the gate.
- `versionableFold` + `projectVersionable` (`ledger/artifacts/versionable.ts`)
  project the merged text via `applyEdits` (Yjs `applyUpdate` is a CRDT merge →
  order-independent convergence).
- `write-back-versionable` (sync) writes the merged text to disk under a
  per-file `withClaim` + content-compare (idempotent; dedups multi-relay writes).
- Conflicts surface the **existing** `conflict-card`; nothing new.
- Skeleton scope: capture is reliable for Claude-Code-shaped Edit/Write tools
  (`claude-sdk`, where the SDK emits real tool names); other ACP agents' edit
  formats are deferred. On a lifecycle supersession the store fires an awaited
  `subscribeLifecycle` signal and the `FoldEngine` re-folds the affected
  artifact's slice (`ledger/fold.ts`), so a superseded edit leaves the live view
  immediately — matching a fresh replay, no restart. Remaining gap: cross-machine
  lifecycle propagation (Postgres `NOTIFY` fires on INSERT, not UPDATE), so a
  peer relay's folds learn of a remote supersession only on restart.

### Headless control verbs (`ledger/` + thin Discord adapters)

Conflict resolution and session import are **headless-capable ledger cores** so a
non-Discord source could drive them later; Discord stays the human surface:
- `ledger/resolve-conflict.ts` `resolveConflict()` — records `merge.resolve`, flips
  lifecycles, surfaces drops to losers' inboxes. `ConflictUI.resolve` is a thin
  adapter over it (the owner gate is the identity boundary it trusts).
- `sessions/import.ts` `importSession()` — reads + distills a session + admits the
  shared-context `knowledge.append`. `SessionSharing.handlePick` adapts it; its
  Discord peer-bridge post is now **SQLite-only** (on Postgres the note syncs).
- Cross-relay dedup uses the `external_claim` primitive: `conflict-card` posts are
  claim-gated by a per-process `relayId` so exactly one relay posts. (Watches are
  already deduped by per-agent `resolve()` ownership.)

### §4 Discord surface (`ledger/render/` + synchronizations + `AgentHost` glue)

Visual cues that surface already-captured ledger state. Pure renderers live in
`ledger/render/` (no I/O, unit-tested like `lib.ts`); surfacing is a
synchronization or an `AgentHost` subscriber; Discord I/O is thin glue.
`GLYPHS` in `ledger/render/surface.ts` is the single visual vocabulary.

- **Attribution line** (`reply-annotations.ts`) + **stale-note flag** — appended
  to outbound text in `post-on-reply` from `caused_by` and the knowledge fold.
- **Workbench** (`host/workbench.ts`, `renderWorkbench`/`workbenchEntries`) — one
  pinned per-scope (per-thread) activity log, driven by a relay-level subscriber
  on `turn.*`/`tool.*` → `AgentHost.updatePill` (throttled). A finished turn
  keeps its step log as a trace (status `working|done|failed`).
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
  All of this lives in `host/session-sharing.ts` (`SessionSharing`).
- **Import (`sess:pick`)** — reads + distills the chosen session and admits an
  **owner-role `knowledge.append`** to `know:channel/<scopeId>/shared-context`
  (anchor `none`, so the merge gate is a no-op and no conflict card fires) — the
  same shape `surfaceToInbox` uses. State is **per-task**: share *inside* the
  thread you want it in, and that thread's next turn picks it up. On the Postgres
  backend it syncs to teammates.
- **Delivery** — `SessionSharing.pendingContext(scopeId)` reads active
  shared-context notes from the knowledge fold and, via the pure
  `pickFreshContext`, injects each one **once** into the next turn as a
  `<shared-context>` block prepended (in `Driver.buildPrompt`) ahead of the
  `<channel>` envelope. (Knowledge is otherwise read only at reply-time, so this
  delivery wiring is what makes an imported note actually reach the agent.)
- **Resume (`sess:resume`)** — continues a live session. Offered only for
  runtime-compatible sessions (`sessionRuntimeForAgent`); `Driver.bindSession`
  sets the runtime session id to resume on the next turn (and resets the
  preamble flag so the resumed session is told the room context once). The
  `AcpAdapter` captures the `loadSession` capability at init and calls
  `conn.loadSession` for a foreign id (pure `planSessionAcquire` decides
  create/reuse/load; falls back to a fresh session if load is unsupported/fails);
  the Claude SDK adapter resumes via its `resume` option. The binding is
  persisted **locally and per-scope** (`state.ts`
  `rooms/<agentKey>/<scopeId>.session.json`, not a synced ledger note — runtime
  sessions don't cross machines) and rebound on restart in `getOrCreateSession`.
  Resume itself stays in `AgentHost` (Driver/Session lifecycle); `SessionSharing`
  delegates to it.

📥 is the session-sharing glyph (`GLYPHS.session`); like ✅/❌/🛑 it is reserved.

### State layout

All persistent config lives in `~/.claude/channels/knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — `{ agents: Record<agentKey, AgentConfig>, mentionPatterns?, ackReaction? }`. Each `AgentConfig` carries `ownerUserId`, `blurb`, `runtime`, `workspace`, `tokenEnv` (the *name* of the env var holding the token, never the token), `rooms`, and an optional `sandbox` (`{fs:'workspace', network}`). Written only by the setup CLI — never mutated from channel messages (prompt-injection protection).
- `rooms/<agentKey>/<channelId>.settings.json` — the permission profile for a room, written **flat** (top-level `allow`/`ask`/`deny`, plus an optional `_mode` preset hint and a `tiers` map for per-actor overrides). Read fresh on each inbound message.
- `settings.json` — machine-global, setup-written: `ledger` backend (`{backend, url?}`) and any user-defined `presets`. Read by `relay.ts` via `resolveLedgerConfig`. Same prompt-injection invariant as `access.json`.
- `ledger.sqlite` — the interaction DAG (SQLite backend; override path with `KNOCK_KNOCK_LEDGER_FILE`). Postgres is used instead when configured (settings.json or `KNOCK_KNOCK_LEDGER_URL`).
- `.env` — bot tokens (one per agent, keyed by each agent's `tokenEnv`) and any other secrets.

`state.ts` is the only module that reads/writes the config files; `lib.ts` holds
all pure decision logic and has no I/O; the ledger owns its own storage.

### Setup (`setup.ts`)

`bun setup.ts` is the standalone, agent-agnostic setup CLI, built on
`@clack/prompts` (+ `picocolors`). With no args it runs an interactive flow: a
guided wizard on first run (agent → sandbox → room → preset → token → ledger),
then an action menu once agents exist (add agents, rooms, peers, humans, **set
room permissions**, save tokens, **choose ledger backend**). It writes the
`agents` shape, preset-expanded permission profiles (`collectPermissions` →
`expandPreset`, + per-actor tiers), and `settings.json` (ledger) via
`readAccessFile`/`saveAccess`/`saveSettings`; tokens and the Postgres URL are
masked on input. Permission profiles are written **only** here — never from chat.

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
| `KNOCK_KNOCK_LEDGER_URL` | no | Postgres connection string; **overrides** the setup-managed `settings.json` ledger choice. Neither set → SQLite. Prefer choosing the backend in `bun setup.ts`. |
| `KNOCK_KNOCK_LEDGER_FILE` | no | Override the SQLite ledger path (default `<state-dir>/ledger.sqlite`) |
| `KNOCK_KNOCK_ACP_COMMAND` | when `runtime=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
