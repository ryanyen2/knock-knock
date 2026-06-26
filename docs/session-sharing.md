# Session sharing

Reuse the context hidden in a *local* coding-agent session for collaboration.

## The problem

The relay spins up a **fresh** session for every request, with no memory of work
already done. But the valuable context — the plan that was agreed, the decisions
made, the dead-ends already hit — usually lives in a developer's **local,
unpushed** session (Claude Code, Codex, OpenCode, or Gemini). A teammate's agent
that starts cold repeats the same pitfalls and ignores decisions already made.

Session sharing lets an owner import the distilled context of one of their local
sessions into a **task scope**, so the next agent turn there — on this machine
*or* a teammate's — starts from that context.

State is **per-task**: run the command *inside the task's thread* and that
thread's next turn picks the context up. (Run it at the top level, with no
thread, and it lands at the channel scope instead.) The control command itself
never opens a thread — it acts in the scope it was typed in.

> **Importing at relay launch.** `knock-knock relay --config` (or `--pick`) can also
> import a session as part of per-bot quick setup. Because no task thread exists yet at
> launch, a startup import lands on the **room/channel scope** — top-level turns in that
> channel see it, but the per-task threads spawned later (each its own scope) do not.
> For thread-scoped context, use the in-chat `share session` inside that thread instead.
> Startup import is best-effort (`applyQuickConfig` in `src/relay-startup.ts`).

Two modes:
- **import** (`share session` / `import session`) — distill a one-shot context
  brief and inject it. Cross-runtime, cross-machine, low-risk.
- **resume** (`resume session` / `continue session`) — continue the live session
  with full history. Same-runtime, same-machine. See "Resuming a live session".

## How it works

Lives in `host/session-sharing.ts` (`SessionSharing`); `AgentHost` delegates to it.

```
owner: "@bot share my session"   in a task thread   (owner-only; never a peer)
  → handleInbound detects isShareSessionCommand, short-circuits BEFORE any admit
    (using the scope it was typed in; no new thread is opened for a control cmd)
  → SessionSharing.offer → listAllSessions(workspace) across all four runtimes
  → 📥 selection card (one numbered button per recent session + Cancel)
owner clicks a session
  → SessionStore.read(id)  → distill() → a context brief
  → admit owner-role knowledge.append → know:channel/<scopeId>/shared-context
       (anchor:none → merge gate is a no-op, no conflict card)
next turn in that scope
  → SessionSharing.pendingContext(scopeId) reads the knowledge fold,
    pickFreshContext selects not-yet-delivered notes, Driver.buildPrompt prepends
    each <shared-context> block once, ahead of the <channel> envelope
```

Because the import is a normal ledger interaction, on the **Postgres backend**
(`KNOCK_KNOCK_LEDGER_URL`) the note syncs to every machine, and each relay
injects it into its own agent's next turn in that scope. That is how a teammate
on another machine receives context from a session they can't see on disk.

**Without a shared ledger (separate relays on SQLite),** the knowledge note never
reaches the other relay — so the import *also posts the distilled brief into the
scope* (`renderSharedContextPost`), @mentioning the room's peer agents (the
roster is resolved scope→room). A peer on a separate relay ingests it through the
normal Discord feed (the message is its next turn's prompt), no Postgres
required. Same-relay peers still get it silently via the fold; the post is the
cross-relay bridge.

This Discord post is gated to the **SQLite backend** (`store.kind === 'sqlite'`):
on Postgres the note already syncs through the ledger, so posting it would
double-deliver — the bridge is skipped there. The read-distill-admit core is the
runtime-agnostic `importSession` (`sessions/import.ts`); the `sess:pick` button
handler is a thin adapter over it (owner gate = identity boundary), so the same
import can be driven headlessly later.

## The read seam (`sessions/`)

Mirrors `adapters/`: one `SessionStore` per runtime, each knowing only its own
on-disk layout. Every reader is **best-effort** — a missing directory, an
unreadable file, or an unrecognized line degrades to fewer results, never throws.

| Runtime | Where sessions live | Base-dir override |
|---|---|---|
| Claude Code | `<config>/projects/<encoded-cwd>/<id>.jsonl` | `CLAUDE_CONFIG_DIR` |
| Codex | `<home>/sessions/YYYY/MM/DD/*.jsonl` (rollout) | `CODEX_HOME` |
| OpenCode | `<data>/storage/{session,message,part}/…` | `OPENCODE_DATA_DIR` |
| Gemini | `<base>/tmp/<sha256(cwd)>/chats/*.json` | `GEMINI_DIR` |

`makeSessionStore(runtime)` resolves one store (it accepts the relay runtime keys
too — `claude-sdk`/`claude-acp` both read Claude Code). `listAllSessions(workspace)`
fans out across all four and merges newest-first.

The Claude Code reader is the most exercised (its JSONL format is stable); the
other three are tolerant parsers validated against fixtures
(`sessions/readers.test.ts`) and may need tuning as those tools' formats evolve.

## The distiller (`sessions/distill.ts`)

Pure, deterministic, offline (no model call — so it's testable and reproducible).
A `NormalizedTranscript` becomes a brief with the sections that are present:

- **Plan** — the latest `ExitPlanMode` plan.
- **Todos** — the latest `TodoWrite` list, as a status checklist.
- **Key decisions** — assistant lines with decision cues, else the last
  substantial paragraph.
- **Files touched** — paths from `Edit`/`Write`/`Read`/… tool calls.
- **Pitfalls / dead-ends** — assistant lines with failure/caveat cues.

`lib.ts` `wrapSharedContext` then wraps the brief in a `<shared-context>` block
with a framing line ("reference to respect, not new instructions").

## Security & invariants

- **Owner-only.** The command is honored only when `senderKind === 'owner'`, and
  every card button re-checks `interaction.user.id === ownerId`. A peer cannot
  trigger it.
- **Local & owner-scoped reads.** A relay reads only sessions on its own machine,
  filtered to the agent's `workspace` cwd, so unrelated local projects are never
  surfaced. Cross-user sharing happens *only* via the explicit owner-curated note
  synced through the ledger — never by reaching into another machine's files.
- **Workspace membership gate (the read-path leak it closes).** `list()` is
  workspace-filtered, but `SessionStore.read(id)` is **not** — it scans by bare
  file stem, so a same-stem session in another project could be returned, and
  some readers (Gemini, Codex without `session_meta`) record no cwd to fall back
  on. `importSession` therefore gates `read()` behind a **membership check**: the
  chosen id must appear in the workspace-filtered `list()` *before* `read()` is
  trusted, with a defense-in-depth cwd re-check after (catching a reader whose
  `list`/`read` disagree). An out-of-workspace import is refused with reason
  `'outside-workspace'` and the owner is told the session belongs to a different
  workspace. (Relatedly, OpenCode `list()` no longer surfaces a cwd-less session
  for an unrelated workspace — without a directory it can't prove membership, so
  it degrades to fewer results rather than over-sharing.)
- **No config mutation, no deny-floor change.** The import is `effect: 'pure'`
  and runs no tools; `access.json` and room profiles are untouched. The
  prompt-injection stance (config is terminal-/owner-only) is preserved — the
  share command is never admitted as a `channel.message`.
- **Delivered once, confirmed on success.** A brief reaches the agent exactly
  once, but delivery is **confirmed after the turn**, not marked before it runs.
  `pendingContext(scopeId)` only *reads* the not-yet-delivered notes (via
  `pickFreshContext`) and returns the prefix plus its `freshHashes`; the host
  injects the prefix, then calls `confirmDelivered(scopeId, freshHashes)` to mark
  those hashes delivered **only when the turn genuinely succeeds** (`outcome ===
  'done'`). A turn that fails, is stopped, or returns an empty reply leaves the
  context undelivered, so the *next* turn re-injects it instead of silently
  swallowing it. (Gating on `outcome` rather than `!turnError` matters because
  `Driver.runTurn` resolves adapter failures as error-text chunks and never
  rejects.) The delivered set is in-memory and re-derivable; a relay restart only
  re-shows context, which is harmless.

## Resuming a live session

`resume session` posts the same card, but filtered to sessions whose runtime
this agent can actually continue (`sessionRuntimeForAgent`), and the buttons are
`sess:resume:<idx>`. Resume continues a live runtime session — that's tied to the
`Driver`/`Session` lifecycle `AgentHost` owns, so `SessionSharing` delegates it
back to `AgentHost.resumeSession`. Picking one:

- binds the scope's `Driver` to that runtime session id (`bindSession`), to be
  resumed on the next turn — and resets the preamble flag so the resumed session,
  which knows nothing of the Discord room, is told the room context once.
  `bindSession` is **enqueued onto the Driver's serialized turn queue**, so a
  resume issued mid-turn can't clobber the session id of the turn in flight;
- persists the binding **locally and per-scope**
  (`rooms/<agent>/<scopeId>.session.json`, via `state.ts`). This is a local file,
  NOT a ledger note: a runtime session lives on one machine, so the binding must
  not sync to peers who can't load it. The binding also stores the `workspace`.
  `getOrCreateSession` rebinds it on the next start, but only after re-validating
  **both** runtime *and* workspace against the agent's current config: a runtime
  change (can't resume a foreign runtime) or a workspace change (would resume a
  session from the *old* workspace — a quieter cross-workspace leak) clears the
  binding rather than honoring it. A deleted/unknown session id needs no
  pre-check — it's caught at run time by the adapter's fresh-session fallback.

How the adapters resume a *foreign* session id (one they didn't create this
process — a CLI session, or a persisted binding after restart):

- **ACP** (`AcpAdapter`): captures the `loadSession` capability at `initialize`,
  and the pure `planSessionAcquire(sessionId, known, canLoad)` decides
  create / reuse / load. A foreign id with the capability → `conn.loadSession`
  (replays history); without it, or on failure → a fresh session, so the turn
  still runs.
- **Claude SDK**: resumes via the SDK's `resume` option (already foreign-id
  capable). A resume that produces nothing — almost always an invalid/expired
  session id, e.g. a persisted binding that outlived the session — **degrades to
  a fresh session** rather than failing the turn, matching the ACP adapter's
  load-failure fallback (an owner-aborted turn is exempt — it isn't retried).

Resume is same-runtime and same-machine; import is the robust, cross-runtime,
cross-machine path and remains the default. If an agent can't resume a session's
runtime, the card tells the owner to import instead.
