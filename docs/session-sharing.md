# Session sharing

Reuse the context hidden in a *local* coding-agent session for collaboration.

## The problem

The relay spins up a **fresh** session for every request, with no memory of work
already done. But the valuable context — the plan that was agreed, the decisions
made, the dead-ends already hit — usually lives in a developer's **local,
unpushed** session (Claude Code, Codex, OpenCode, or Gemini). A teammate's agent
that starts cold repeats the same pitfalls and ignores decisions already made.

Session sharing lets an owner import the distilled context of one of their local
sessions into a channel, so the next agent turn — on this machine *or* a
teammate's — starts from that context.

> MVP scope is **retrieve & inject**: a one-shot context brief. *Resuming* a live
> session (continuing it with full history) is a planned phase 2 — see the end.

## How it works

```
owner: "@bot share my session"        (owner-only; never a peer)
  → handleInbound detects isShareSessionCommand, short-circuits BEFORE any admit
  → listAllSessions(workspace) across all four runtimes
  → 📥 selection card (one numbered button per recent session + Cancel)
owner clicks a session
  → SessionStore.read(id)  → distill() → a context brief
  → admit owner-role knowledge.append → know:channel/<id>/shared-context
       (anchor:none → merge gate is a no-op, no conflict card)
next turn in the channel
  → pendingSharedContext reads the knowledge fold, pickFreshContext selects
    not-yet-delivered notes, Driver.buildPrompt prepends each <shared-context>
    block once, ahead of the <channel> envelope
```

Because the import is a normal ledger interaction, on the **Postgres backend**
(`KNOCK_KNOCK_LEDGER_URL`) the note syncs to every machine in the channel, and
each relay injects it into its own agent's next turn. That is how a teammate on
another machine receives context from a session they can't see on disk.

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
- **No config mutation, no deny-floor change.** The import is `effect: 'pure'`
  and runs no tools; `access.json` and room profiles are untouched. The
  prompt-injection stance (config is terminal-/owner-only) is preserved — the
  share command is never admitted as a `channel.message`.
- **Delivered once.** `pickFreshContext` tracks per-channel delivered note hashes
  so a brief reaches the agent exactly once. The set is in-memory and
  re-derivable; a relay restart only re-shows context, which is harmless.

## Phase 2: resuming a live session

The `AgentAdapter.prompt({ text, sessionId })` seam already threads a session id;
the Claude SDK adapter resumes via its `resume` option. To resume an *ACP* agent:

- capture `init.agentCapabilities` in `AcpAdapter.doInit`,
- when a `sessionId` is supplied and `loadSession` is advertised, call
  `conn.loadSession({ sessionId, cwd, mcpServers: [] })` instead of `newSession`,
- add a `sess:resume:<idx>` button that binds the channel's Driver to the chosen
  runtime session id (runtime must match), persisting it across restarts.

Resume is same-runtime and same-machine; the import flow above is the robust,
cross-runtime, cross-machine path and remains the default.
