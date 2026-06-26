# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test              # all tests (everything under tests/): pure decision logic + the ledger suite
bun run typecheck     # tsc --noEmit
bun src/cli.ts relay  # start the relay (reads agents from access.json)
bun src/cli.ts setup  # interactive setup wizard/menu
bun run build         # cross-compile the release binaries into dist/
bun test tests/ledger/render/surface.test.ts   # run one test file
bun test --test-name-pattern "conflict"  # run tests matching a name
```

## Architecture

**All source lives under `src/`** (the loose modules and the `adapters/`,
`adapters-msg/`, `host/`, `ledger/`, `sessions/` trees). The repo root holds only
`src/`, `tests/`, `website/`, `packaging/`, `scripts/`, `docs/`, and config files.
Source paths below are written relative to `src/` — e.g. `lib.ts` is `src/lib.ts`,
`ledger/store-sqlite.ts` is `src/ledger/store-sqlite.ts`.

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
- **N `AgentHost`s** — one per entry in `access.agents`, each owning its
  messaging client (via the `MessagingAdapter` seam — Discord today, see
  "Messaging platforms" below), token, runtime, workspace, and rooms.

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
the permission profile (the member's inline `Membership.profile`), the roster,
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
`relay.ts`: `loop-guard`, `channel`, `turn`, `approval`, `watch`, `config`,
`coordination-board`, `task-dag` (`ledger/concepts/`) and the `knowledge` +
`versionable` artifact folds (`ledger/artifacts/`). Folds **reuse the pure
functions in `lib.ts` verbatim** (e.g. `LoopGuard.step` calls `loopGuard(...)`).

The **`config`** fold is the owner's behavioral overlay (`!config`), keyed by
artifact `cfg:channel/<id>` — and because the id can be a **room OR a thread
scope**, the same fold backs both layers. `resolveConfigFor(state, roomId,
scopeId)` projects each layer through the pure `projectChannelConfig` and merges
them (`resolveTwoLayerConfig`): a thread overlay wins per key, an unset key
inherits the room, unset on both → the agent default; `scope===room` collapses to
the room config (no thread). The room is the inherited default; rate-cap /
require-mention / mention / ack stay **room-keyed** (they gate inbound *before* a
thread exists). `role`/`end-goal` ride the per-turn `contextPrefix`;
`model`/`thinking`/`effort` ride the per-turn `TurnOptions` (claude-sdk only; ACP
self-manages); the permission `mode` applies a vetted preset to the room profile
with `deny` always UNIONed (`applyModeToProfile`). `!context` curates a thread's
shared-context notes over the same `knowledge` fold session-sharing imports into.

Each behavior is one file in `ledger/synchronizations/` (rubric: a new behavior
= one new synchronization, zero edits to concepts). Registered today:
`classify-on-tool-request`, `reply-claim` (turn-taking: exactly one agent
replies, see "Coordination" below — replaced `prompt-on-message`), `drive-turn`,
`post-on-reply`, `capture-presence` + `task-scheduler` + `complete-task-on-turn` (coordination),
`dm-on-supersede` (§4.4), `conflict-card` (§4.2), `retry-on-reaction` (§4.5),
`resume-on-watch`, `apply-supersession` (local-first cross-machine supersession
convergence — re-derives a lifecycle change on each peer from the winner's
immutable `supersedes` op, which crosses NOTIFY where the UPDATE does not), and
the file-edit pair `capture-workspace-edit` + `write-back-versionable` (see
"File-edit sync" below), and the file-exchange pair `ingest-attachment`
(inbound) + `share-file` (outbound) (see "File exchange" below).

### Coordination (turn-taking, awareness, task allocation)

Multiple agents (co-resident or cross-machine) coordinate over the ledger with no
server. The **mechanism** (the `external_claim` two-claim pattern, the
`coordination-board` + `task-dag` folds, the `task-scheduler` reconcile tick) is
pattern-agnostic; the collaboration **topology** is pure **policy** selected via
`!config`: `responder` (`race`/`designated`/`role-priority`) and `allocation`
(`pull-claim`/`push-assign`/`bid`), defaulting to decentralized peers. `reply-claim`
fixes the duplicate-reply bug (reply election holder=agentKey, drive election
holder=relayId, keyed on the platform `ref.id`); `!delegate` seeds a task DAG;
`task-scheduler` claims/assigns/bids ready tasks and fails a lapsed claim over on a
half-TTL reconcile tick. All INSERT-derived, so it converges cross-machine on
Postgres (SQLite is same-machine only). Pure logic in `lib.ts`, tested in
`tests/lib.test.ts` + `tests/ledger/coordination*.test.ts`. Plain-language intro:
**`docs/how-coordination-works.md`**; full technical design:
**`docs/knock-knock-coordination.md`**.

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

### Messaging platforms (`messaging-adapter.ts` + `adapters-msg/`)

`AgentHost` speaks a platform-neutral `MessagingAdapter` interface (send / edit /
react / dm / start-thread, plus `capabilities()` and reaction normalization), not
a Discord SDK directly. `makeMessagingAdapter(agent.platform ?? 'discord')`
(`adapters-msg/index.ts`) builds the concrete adapter; `discord.js` is confined to
`adapters-msg/discord.ts`. **Discord is the live surface and the only `Platform`.**
Supporting another platform is one new adapter file in `adapters-msg/` implementing
the seam plus a branch in the factory — nothing else changes. Pure formatting/fallback
helpers live in `messaging-fallback.ts` + `lib.ts`.

### `AgentHost` (`agent-host.ts` + `host/`)

A messaging ↔ ledger adapter (Discord today, via the `MessagingAdapter` seam
above). Inbound: `handleInbound` gates the message
(`guildSenderAllowed`, rate cap, mention check), resolves the **scope** (thread,
or channel) and **room** (parent), and admits a `channel.message` under the
scope — the synchronizer chain does the rest. It owns the per-scope `Driver`
session (adapter instances are per-process), the live `Approvals` service, the
`scopeToRoom` cache + `roomForScope`, and turn driving; it exposes callbacks the
synchronizations call back into (`getDriveHandle`, `discordSend`,
`postConflictCard`, `dmUser`, `updateWorkbench`, `auditProfileForScope`,
`resolveWatch`).

Its cohesive UI/feature clusters are separate collaborators in `host/`, each
owning its own state and reaching shared host capabilities through the narrow
`HostContext` (`host/context.ts`): `Workbench` (§4.1 per-turn activity log),
`ConfigCard` (the pinned per-thread setup card), `ConflictUI` (§4.2 cards),
`WatchControl` (arm/disarm/list + `resolveWatch`), `ChannelConfigControl` (owner
`!config`), `ContextControl` (owner `!context`), and `SessionSharing` (import +
per-scope context delivery; resume stays in the host, delegated via a callback
because it's tied to the Driver/Session lifecycle).

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
   task scope (a thread); the profile is the room member's inline
   `Membership.profile`, resolved via `resolveRoomProfile` (which re-unions the
   `DENY_FLOOR` at read time). Both enforcement paths resolve scope→room first —
   the adapter's `applyPolicy` (via `getOrCreateSession` → `resolveRoomProfile`)
   and the audit-only `classify-on-tool-request` (relay injects a scope→room
   `readPolicy` over `auditProfileForScope`). An absent profile fails restrictive
   (deny-floor only), never to an empty profile (which would drop the deny floor).

ACP detail: a tool's subject (command / path) may arrive in `rawInput`, the
`content` blocks, or `locations` — `AcpAdapter` probes all three and merges
across `tool_call_update`s so deny patterns match regardless of where the agent
put it.

**Presets (`lib.ts`).** `PRESET_MODES` (strict / ask-per-edit / auto / bypass)
are named profiles `setup.ts` stamps into a member's inline profile via `expandPreset`,
**expanded at write time** so `resolveRoomProfile`/`classifyTool` are unchanged.
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

### File-edit sync (`workspace.edit` → versionable; AOCM)

Two agents editing the same file converge over the ledger (no Discord
conversation) under **Authority-Ordered Convergent Merge** — dominance, exclusion,
and conflict are **derived** from the immutable ops at projection time, never from
a mutated lifecycle column. Full concept + algebra in
**`docs/authority-ordered-convergent-merge.md`**.
- `capture-workspace-edit` (sync) correlates a successful `tool.executed` with its
  parent `tool.requested` (which carries the Edit/Write input), builds a Yjs
  update against a live per-artifact `Y.Doc`, and admits a `workspace.edit` to
  `vers:<scope>/<relpath>` with a stable whole-file anchor `{range,0,0}` and
  `caused_by` chained onto the artifact's applied edits (so sequential edits don't
  contend; concurrent ones do). It also carries the normalized path-free
  `intent` for the interference test.
- `admit.ts` admits versionable edits (`verb: 'workspace.edit', effect: 'workspace'`)
  **`applied`**, bypassing the role-ordered lifecycle gate — the whole contended set
  reaches the fold. (Non-versionable verbs keep the gate.)
- `versionableFold` + `projectVersionable` (`ledger/artifacts/versionable.ts`)
  derive the live set by the total order `(role_rank DESC, content_hash ASC)`:
  greedily keep edits, **exclude** any concurrent op an already-kept higher-or-equal
  op interferes with (region-overlap on the common base), then fold the live set via
  `applyEdits` (Yjs `applyUpdate` is order-independent). Different-role interference
  excludes silently; equal-role interference records a first-class `ConflictRegion`.
- `conflict-card` (sync) fires on each admitted versionable edit and posts when the
  edit joins a derived conflict region (cross-relay claim-deduped on the sorted
  branch set). `resolve-conflict.ts` resolves by admitting an **owner-role copy of
  the chosen branch** (concurrent → dominates both branches → conflict clears); it
  still emits a `surfaceToInbox` INSERT so `dm-on-supersede` fires.
- `write-back-versionable` (sync) writes the merged text to disk under a
  per-file `withClaim` + content-compare (idempotent; dedups multi-relay writes).
- **Cross-machine:** because dominance is derived from immutable ops and the merge
  emits only INSERTs (no lifecycle UPDATE), replicas converge from the operations
  alone — closing the old gap where a `superseded` UPDATE never crossed via Postgres
  `NOTIFY`. The R9 ship gate is the property battery in `ledger/aocm.test.ts`
  (hand-authored AE corpus + separate-store skew fuzz + role-blind teeth check).
- v1 scope: whole-file anchor retained (different-role exclusion is whole-op;
  interval anchors deferred). Capture is reliable for Claude-Code-shaped Edit/Write
  tools (`claude-sdk`); other ACP agents' edit formats are deferred.

### File exchange (inbound ingest + outbound share)

Move files between the chat surface and the workspace (see
**`docs/file-exchange.md`**). The seam carries `IncomingMessage.attachments`,
`SendOpts.files`, and `Capabilities.files` (`messaging-adapter.ts`); Discord is
the live surface. Pure policy is in `lib.ts` (`sniffFileKind` magic-byte typing,
`sanitizeAttachmentName`, `withinBudget`, `looksLikeSecret`, `SECRET_PATH_GLOBS`,
`formatAttachedFilesBlock`, `parseShareCommand`) and unit-tested in `lib.test.ts`.

- **Inbound** — `ingest-attachment` (sync) fires on a `channel.message` carrying
  attachments. It's registered **before** `prompt-on-message` ON PURPOSE: the
  synchronizer fires subs sequentially and awaits each, so the file is downloaded
  + materialized + recorded as `file.received` before the turn is prompted — the
  same turn the file rode in on sees it. The signed/expiring attachment URL is
  **never persisted** (KTD2): only URL-free descriptors ride the
  `channel.message` args; the real handles stay in the host side table
  (`loadInboundAttachments`). Pipeline: budget → download (timeout-bounded) →
  magic-byte sniff → v1-type allowlist → secret scan → traversal-safe name →
  materialize inside the workspace (containment via `relativizeWorkspacePath`) →
  admit `file.received`. `AgentHost` buffers `file.received` per scope (only the
  serving host buffers) and `runTurnForChannel` prepends a `<attached-files>`
  **untrusted** block (delivered once, confirmed after the turn succeeds).
- **Outbound** — owner `!share <relpath>` short-circuits before any admit (like
  `!watch`/`!config`) and admits a `file.shared` request; `share-file` (sync)
  resolves it inside the workspace (realpath + containment + size guard), refuses
  a credential path/content, classifies `FileShare` (`deny` ⇒ refuse; `ask`/`allow`
  proceed since the owner command is consent), sends under an `external_claim`
  (cross-relay dedup), and records `file.shared` completed. Agent-initiated
  sharing via a `share_file` tool + interactive consent is a deferred fast-follow.
- **Secret floor** — `DENY_FLOOR` gains `Read(<secret>)` + `FileShare(<secret>)`
  patterns (`SECRET_PATH_GLOBS`); `resolveRoomProfile` re-unions the floor at read
  time so it holds for rooms written by older builds. v1 types: text/code/image/
  gif/pdf; audio/video transcription, the concrete Slack file flow, and inline
  multimodal prompt blocks are deferred.

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
- **Workbench** (`host/workbench.ts`, `renderWorkbench`/`workbenchEntryForTurn`) —
  one **per-turn** (per agent-tag "call") activity log, **not pinned**, posted
  inline and edited in place. Driven by a relay-level subscriber on
  `turn.*`/`tool.*` that resolves the turn (`findTurnForInteraction`) →
  `AgentHost.updateWorkbench(scope, promptHash)` (throttled). A finished turn keeps
  its step log as a trace (status `working|done|failed`). The agent's **plan** —
  its latest `TodoWrite` list, parsed by `parseTodos` — renders as a per-item
  checklist (`○` planned / `◐` in progress / `✓` done) above the tool steps, and
  those `TodoWrite` calls drop from the step trace so repeated updates don't spam
  it (Claude-Code-shaped `TodoWrite` only; other ACP agents get no plan block).
- **Config card** (`host/config-card.ts`, `renderConfigCard`) — the **pinned**
  per-thread setup card: the resolved (thread ⊕ room) persona/objective/model/
  thinking/effort/mode + attached context-note count, refreshed on thread spawn
  and on `!config`/`!context` edits (`HostContext.refreshConfigCard`). Takes the
  pin slot the Workbench used to hold.
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
- **Continuity after restart / cold join** — two complementary mechanisms keep a
  bot from going blank. (1) **Automatic binding persistence:** every *successful*
  turn writes the same per-scope `session.json` binding (gated on a resume-capable
  `sessionRuntimeForAgent` + the live `Driver.currentSessionId`), so a same-bot/
  same-runtime/same-workspace restart rebinds and resumes its *real* runtime session
  — no explicit `sess:resume` needed. (2) **Cold-session `<thread-recap>`:** a
  `Session.cold` flag (set true at creation, cleared when a binding is rebound or the
  first turn completes) gates `threadRecapPrefixFor`, which on a genuinely cold turn
  injects a once-only recap of the scope's prior transcript (pure `selectThreadRecap`/
  `wrapThreadRecap` over the durable `channel:transcript` fold, current inbound message
  excluded). This covers exactly the cases binding-resume can't: a newly-added bot, a
  cross-runtime switch, or a runtime whose foreign-session load fails. Plain-language
  writeup in `docs/how-coordination-works.md`.

📥 is the session-sharing glyph (`GLYPHS.session`); like ✅/❌/🛑 it is reserved.

### State layout

All persistent config lives in `~/.knock-knock/` (overridable via `KNOCK_KNOCK_STATE_DIR`):
- `access.json` — written in the **channel-centric authoring shape** (`AuthoringAccess`, `lib.ts`): `{ me?, bots, channels, roster, mentionPatterns?, ackReaction? }`.
  - `me` — `Partial<Record<Platform, userId>>`: the owner's id per platform, entered **once** and reused (no per-bot owner re-entry).
  - `bots` — `Record<botId, Bot>`: `{platform, tokenEnv, runtime, sandbox?, displayName?, blurb?}`. A bot is a **portal** — a platform identity, not a fixed coding agent. Its `runtime` is only the **default** coding agent. The name/avatar live on the platform (fetched live, never typed).
  - `channels` — `Record<"${platform}:${channelId}", Channel>`: a channel = a project = a permission boundary. Each lists `members` (`Membership[]`, one per *my* bot active here, carrying that bot's per-project `workspace`, inline `profile`, `preset`, and an optional per-channel `runtime` override — the same bot can drive `claude-sdk` in one channel and `codex` in another) and `collaborators` (roster refs), plus `requireMention?`/`approvalActorId?`. The effective runtime per channel is `Membership.runtime ?? Bot.runtime`, resolved in `getOrCreateSession`. Runtime is terminal-written only (it selects which local binary runs with workspace access), never chat-settable.
  - `roster` — `{people: Record<id, Person>, peers: Record<id, Peer>}`: known humans + peer bots, entered once and referenced by id from a channel's `collaborators`.
  - **Read via `readAccessFile()`**, which projects this to the agent-keyed runtime `Access` (`{agents: Record<botId, AgentConfig>}`) via the pure `projectToRuntime` — so the relay/hosts/folds are unchanged. `readAuthoringAccess`/`saveAuthoringAccess` operate on the authoring shape (setup only). Written only by the setup CLI — never mutated from channel messages (prompt-injection protection).
- Permission profiles are **inline** on each `Membership.profile` in `access.json` (`{allow, ask, deny, tiers?}`, expanded from a named `preset`). They are the only profile store — there is no separate on-disk profile file. The enforced profile is resolved through the pure `resolveRoomProfile` (re-unions `DENY_FLOOR`; an absent profile fails restrictive to deny-floor-only).
- `settings.json` — machine-global, setup-written: `ledger` backend (`{backend, url?}`) and any user-defined `presets`. Read by `relay.ts` via `resolveLedgerConfig`. Same prompt-injection invariant as `access.json`.
- `ledger.sqlite` — the interaction DAG (SQLite backend; override path with `KNOCK_KNOCK_LEDGER_FILE`). Postgres is used instead when configured (settings.json or `KNOCK_KNOCK_LEDGER_URL`).
- `.env` — bot tokens (one per bot, keyed by each bot's `tokenEnv`) and any other secrets.

The redesign of this config/identity/setup layer (and what is intentionally *not* changed — the ledger core) is documented in **`docs/redesign.md`**.

`state.ts` is the only module that reads/writes the config files; `lib.ts` holds
all pure decision logic and has no I/O; the ledger owns its own storage.

### Setup (`setup.ts`)

`bun setup.ts` is the standalone, agent-agnostic, **channel-centric** setup CLI,
built on `@clack/prompts` (+ `picocolors`). With no args it runs an interactive
flow: a guided wizard on first run (bot → sandbox → channel [members + per-channel
workspace + preset + collaborators] → token → ledger), then a status dashboard +
action menu once bots exist (add bot, add/edit channel, add person/peer to the
**roster**, save tokens, choose ledger backend, remove). Key UX: the owner id is
asked **once per platform** (`me`), bot names are **not typed** (they live on the
platform), and channel collaborators are **picked from the roster** rather than
re-pasted. It writes the `AuthoringAccess` shape (`readAuthoringAccess` /
`saveAuthoringAccess`), inline preset-expanded permission profiles
(`expandPreset` per membership), and `settings.json` (ledger via `saveSettings`);
tokens and the Postgres URL are masked on input. Permission profiles + access are
written **only** here — never from chat.

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
| `KNOCK_KNOCK_STATE_DIR` | no | Override the state directory (default `~/.knock-knock`) |
| `KNOCK_KNOCK_LEDGER_URL` | no | Postgres connection string; **overrides** the setup-managed `settings.json` ledger choice. Neither set → SQLite. Prefer choosing the backend in `bun setup.ts`. |
| `KNOCK_KNOCK_LEDGER_FILE` | no | Override the SQLite ledger path (default `<state-dir>/ledger.sqlite`) |
| `KNOCK_KNOCK_ACP_COMMAND` | when `runtime=acp` | Spawn command for the ACP subprocess |
| `KNOCK_KNOCK_ACP_ARGS` | no | Space-separated args for `KNOCK_KNOCK_ACP_COMMAND` |
| `KNOCK_KNOCK_DEBUG` | no | Set to `1` to log every SDK stream event and ACP permission decision |
| `ANTHROPIC_API_KEY` | for claude-sdk/claude-acp | Claude auth (or use existing `claude` login) |
| `OPENAI_API_KEY` | for codex | OpenAI auth |
