# Getting started: running knock-knock with different agents

> **New to knock-knock?** Start with the **[Setup guide](setup.md)** for the
> full zero-to-running-group-chat journey. This page is the per-runtime
> reference it links into.

The relay drives **any** coding agent through one `AgentAdapter` seam. You pick
the agent with the `runtime` field on the agent, set during `bun setup.ts` —
not with an environment variable. Nothing in `relay.ts` / `agent-host.ts` /
`driver.ts` / `lib.ts` knows which agent is underneath; only the adapters do.

There are two transports behind that seam:

| Transport | Agents | How it talks |
|-----------|--------|--------------|
| In-process SDK | Claude Code (`claude-sdk`) | Claude Agent SDK, in this process |
| **ACP over stdio** | **OpenCode, Codex, Gemini, Claude Code, Cursor, …** | spawns the agent as a subprocess, JSON-RPC on stdin/stdout ([Agent Client Protocol](https://agentclientprotocol.com)) |

ACP is the universal path: one adapter (`adapters/acp.ts`) drives every
ACP-speaking agent — the agent is chosen by **which command we spawn**, not by
any agent-specific code.

| `runtime` | agent / transport |
|-----------|-------------------|
| `claude-sdk` | Claude Code, in-process SDK (default; no install) |
| `claude-acp` | Claude Code, via ACP (`npx @agentclientprotocol/claude-agent-acp`) |
| `opencode` | OpenCode, via ACP (`opencode acp`) |
| `codex` | OpenAI Codex, via ACP (`npx @agentclientprotocol/codex-acp`) |
| `gemini` | Gemini CLI, via ACP (`gemini --experimental-acp`) |
| `acp` | any agent — set `KNOCK_KNOCK_ACP_COMMAND` / `KNOCK_KNOCK_ACP_ARGS` yourself |

All modes start the same way:

```bash
bun relay.ts
```

### Prerequisite: configure an agent

```bash
bun setup.ts                  # guided wizard: agent identity → runtime → room → token
bun relay.ts                  # start the relay — picks up everything from access.json
```

`bun setup.ts` with no arguments runs an interactive wizard (arrow-key runtime
picker, masked token input, inline validation). After the first agent exists it
opens an action menu instead; re-run it whenever you need to add agents, rooms,
peers, humans, or bot tokens. The runtime you pick is written to the agent's
`runtime` field in `access.json`.

---

## ⚠️ The one thing that matters for the deny floor

The room profile (`allow` / `ask` / `deny`) is enforced **inside the adapter**
when the agent asks permission to run a tool:

- **deny** → auto-rejected; the owner never even sees it (hard floor)
- **allow** → auto-approved; no Discord prompt
- **ask** → posted to Discord for the owner to Allow/Deny

This only works if **the agent actually asks before running tools.** ACP has no
policy you hand the agent up front — if an agent is configured to run shell
commands autonomously, it never sends a permission request and the floor is
bypassed. So for each ACP agent you must ensure it runs in an **ask-first** mode
(its normal default — just don't put it in a "yolo"/auto-approve mode). The
per-agent sections below say exactly how.

> Verified behaviour (OpenCode): out of the box OpenCode auto-ran both `echo`
> and `rm -rf` with **zero** permission requests. After adding
> `"permission": { "bash": "ask" }` to its config, every shell call surfaced as
> an ACP permission request and the `deny` floor blocked `rm -rf` correctly,
> even when OpenCode mislabelled the tool kind. `classifyTool` therefore blocks
> a denied command literal regardless of the reported tool kind.

**Can't guarantee ask-first? Use the OS sandbox.** If you can't be sure a runtime
asks before acting, turn on the **OS-level sandbox** for that agent in
`bun setup.ts` ("Sandbox this agent?") — it confines file writes to the workspace
and can block the network at the operating-system level, so containment doesn't
depend on the agent cooperating. It applies to **ACP runtimes only** (macOS
`sandbox-exec`, Linux `bwrap`); the in-process `claude-sdk` can't be jailed, so
use **`claude-acp`** when you need Claude Code sandboxed. The relay warns rather
than silently pretend on an unsupported platform or an in-process agent.

**Picking what an agent may do** is a one-step preset in `bun setup.ts` (strict /
ask-per-edit / auto / bypass), plus optional per-peer tiers (e.g. peers get
read-only). See **[Permissions & security](security-and-permissions.md)** for the
friendly, complete guide.

---

## Claude Code

**In-process SDK (simplest, nothing to install) — `runtime: claude-sdk`:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # or an existing `claude` login
bun relay.ts
```

The SDK enforces `deny` natively (`disallowedTools`) and routes `ask` through
`canUseTool` — the deny floor is solid without extra config.

**Via ACP (same code path as the other agents) — `runtime: claude-acp`:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bun relay.ts
```

`npx` fetches `@agentclientprotocol/claude-agent-acp` on first run (binary
`claude-agent-acp`). Claude Code asks before non-allowlisted tools by default,
so the floor holds.

---

## OpenCode — `runtime: opencode`

1. Install: `brew install sst/tap/opencode` (or see opencode.ai).
2. Configure a provider/model — OpenCode won't prompt without one:
   `opencode auth login` (pick Anthropic / OpenAI / etc.).
3. **Make it ask before tools** — add to `opencode.json` in your workspace
   (or `~/.config/opencode/opencode.json`):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" }
   }
   ```

4. Run:

   ```bash
   bun relay.ts
   ```

The relay spawns `opencode acp` and drives it over stdio. (No global install of
an adapter needed — ACP is built into OpenCode.)

---

## OpenAI Codex — `runtime: codex`

1. Auth: `export OPENAI_API_KEY=sk-...` (the `codex-acp` server reads it).
2. **Approval mode:** the default `codex-acp` behaviour surfaces tool calls as
   ACP permission requests — no extra config needed. Do **not** launch it with
   `--yolo`, `--full-auto`, or `--dangerously-bypass-approvals-and-sandbox`,
   as those skip all permission requests and bypass the deny floor.
3. Run:

   ```bash
   bun relay.ts
   ```

`npx` fetches `@agentclientprotocol/codex-acp` on first run. If you have a
locally built `codex-acp` binary instead, point at it directly with the generic
ACP runtime:

```bash
KNOCK_KNOCK_ACP_COMMAND=codex-acp bun relay.ts   # agent's runtime set to "acp"
```

---

## Any other ACP agent (Gemini, Cursor, …) — `runtime: acp`

Use the generic escape hatch — set the spawn command yourself:

```bash
KNOCK_KNOCK_ACP_COMMAND=gemini \
KNOCK_KNOCK_ACP_ARGS="--experimental-acp" \
bun relay.ts
```

`gemini` also has a built-in preset (`runtime: gemini`), so for the Gemini CLI
you can just set the runtime and run `bun relay.ts`.

---

## Multi-agent collaboration

One relay process can host several bot identities simultaneously — each with its
own Discord bot token, runtime, workspace, and rooms. The bots can share a
channel and `@`-mention each other.

```bash
# Re-run setup to add a second agent (different bot token, different workspace),
# add it to the same room, and save its token.
bun setup.ts

# One relay starts both
bun relay.ts
# relay [research-bot]: connected as agent-a#1234
# relay [deploy-bot]:   connected as agent-b#5678
```

**Collaborative features baked in:**

- **Identity preamble** — each bot knows its own name, blurb, and the
  owner/human/peer priority (`owner > human > peer`). Injected into the first
  turn of each session.
- **Peer roster** — the agent sees who else is in the room (peer name + blurb)
  so it can address them by `<@botId>`.
- **`<channel>` envelope** — every inbound message is wrapped with sender kind,
  user ID, message ID, and timestamp so the agent has structured context.
- **Loop guard** — prevents two bots from ping-ponging indefinitely: after 4
  consecutive agent-to-agent turns, the relay stops auto-responding until an
  owner/human message resets the counter.
- **Per-channel approvals** — each bot's tool-permission prompts go to *that
  bot's* owner, not a shared approver.
- **Tasks run in threads** — a top-level `@mention` opens a Discord thread for
  that task; the reply, tool steps, approvals, and activity log all live there.
  The parent channel is the **room** (permissions, roster, allowlist); threads
  inherit it. Each thread gets its own agent session, so tasks don't bleed.
- **Live "Workbench"** — one pinned message per task thread, edited in place as
  each agent works: the agent's **plan** as a live checklist (`✓` done / `◐` in
  progress / `○` planned, from its TodoWrite list) above a per-agent log of tool
  steps with status (`→ Terminal git status ✓`), kept afterward as the trace of
  the turn.
- **Outcome reactions** — 👀 while a turn runs, swapped for a persistent **🏁
  done** / **⚠️ failed** on the triggering message. ✅ / ❌ stay approval-only.
- **Stop** — react **🛑** (owner only) on a message while the bot is working to
  abort the in-flight turn promptly; the relay posts a short "Stopped" note.
- **Conflict cards & override DMs** — when two equal-role drafts collide at the
  same anchor, the relay posts a 🔀 **Take A / Take B / Write my own** card (only
  the owner resolves; the loser is kept); the overridden agent's owner gets a 🔁
  DM. React **🔁 / ⏪ / 🧷** on a bot message to retry, rewind, or checkpoint a turn.
  The full reaction vocabulary, conflict resolution, and how the ledger versions
  every action (nothing deleted, only superseded) are in
  [reactions-and-versioning.md](reactions-and-versioning.md).
- **Session sharing** 📥 — an owner can start collaboration from the plan and
  decisions in one of their local coding sessions: `share session` imports a
  distilled context brief into the channel; `resume session` continues the live
  session. See [session-sharing.md](session-sharing.md).
- **Watches** ⏳ — let a turn defer and be resumed by the world (a file changing,
  a job finishing, a deadline passing). See the next section and
  [knock-knock-watches.md](knock-knock-watches.md).

---

## Watches — deferring a turn until the world changes

A watch lets an agent register interest in something that happens *later* and be
re-prompted to act (and post to Discord) the instant it does — without holding a
turn open or polling. It runs a supervised command; each output line is gated,
and a matching line resumes a fresh turn. Two ways to arm one:

- **Owner command** (every runtime): `!watch <name> on-change|each-line|on-exit|match:<regex> [every=10s ttl=10m max=5 once] <command>`, plus `!watch list` and `!unwatch <name>`. Owner-only, short-circuited in `handleInbound` before any admit — a peer can't arm a watch by talking.
- **Agent tool** (Claude SDK runtime today): the in-process MCP server
  (`adapters/watch-mcp.ts`) exposes `watch` / `unwatch` / `watch_list`, so the
  agent arms from natural language ("start watching the notes file"). Only
  runtimes wired for it self-arm (`runtimeSelfArmsWatches`); ACP agents use the
  owner `!watch` fallback.

Both paths funnel through one permission-gated arm path (`WatchControl.arm`, in
`host/watch-control.ts`):

```
agent calls watch (or owner types !watch)   in a task scope (thread)
  → WatchControl.arm — classifyTool({toolName:'Bash', subject: command}) against
    the room's profile (resolved scope→room), three-way:
       deny  → refused;  allow → armed;  ask → held for one owner ✅/❌
  → admit(watch.armed)                         [the watch fold records the intent]
  → WatchSupervisor reconciles desired-vs-running → spawns the command
  → each stdout line → watchGate → admit(watch.fired)
  → resume-on-watch → admit(turn.prompted) → drive-turn → reply → post-on-reply
                                               (resumes in the scope it was armed in)
```

**Safety:** the watch command is classified exactly like a Bash call against the
room's `allow / ask / deny` profile (the floor resolves scope→room, never an
empty profile):

- **deny** → refused outright; the command never arms and never runs.
- **allow** → armed immediately.
- **ask** → *held*: the owner gets one ✅/❌ for the exact command (via the
  `Approvals` flow, anchored on a `watch.requested` interaction), and the watch
  arms only on approve. The owner's own `!watch` is pre-approved — typing the
  command is the approval. This matters because a typical `ask: [Bash(*)]` profile
  shadows every Bash `allow`, so approving the command once is the usable path.

The `WatchSupervisor` then backstops the **deny floor** at spawn time regardless
of how a watch got armed, and TTL / max-fires bound a runaway watch.

---

## Cross-machine setup (shared Postgres ledger)

By default each relay keeps a **local SQLite ledger**, so two relays on different
machines only see each other through the Discord channel. That's enough for the
agents to talk — but anything coordinated through *ledger state* (an imported
session brief, cross-machine conflict detection, collaborative file edits,
knowledge notes) stays on the relay that created it. To share that across
machines, point **every** relay at one **shared Postgres** database.

**Easiest:** `bun setup.ts → "Choose ledger backend" → Remote (Postgres)` and
paste the connection string — it's stored (masked) in `settings.json` and the
relay picks it up. The first-run wizard recommends remote by default. Setting the
`KNOCK_KNOCK_LEDGER_URL` env var still works and **overrides** the stored choice.
Either way, if a configured Postgres can't be reached the relay **refuses to
start** rather than silently splitting history onto a local SQLite ledger.

> **What's shared vs. local.** Only the **ledger** (all Interactions, and the
> folds derived from them) is shared in Postgres. Each machine keeps its own
> `access.json` (its agent), `.env` (its bot token), room permission profiles,
> and **runtime session files** (`~/.claude/projects`, …). So **resuming a live
> session stays same-machine** — the session file isn't on the other host; use
> `share session` (import) to carry *context* across machines. Don't merge
> `access.json` between machines.

### Setting it up with Neon (tested on Postgres 18)

1. Create a Neon project on **Postgres 18** and a database (e.g. `neondb`).
2. Copy the **direct** connection string — the host must **not** contain
   `-pooler`. Neon's pooled endpoint runs PgBouncer in transaction mode, which
   **drops `LISTEN`/`NOTIFY`** — cross-machine notifications would then silently
   never arrive. Direct host looks like `ep-xxxx.REGION.aws.neon.tech`; pooled is
   `ep-xxxx-pooler.REGION.aws.neon.tech` (do not use the pooled one here).
3. Prefer `sslmode=verify-full` (Neon presents a valid cert, and it avoids a
   `pg` deprecation warning that `sslmode=require` now triggers).
4. Set the **same** URL on **both** machines — in
   `~/.claude/channels/knock-knock/.env`:
   ```
   KNOCK_KNOCK_LEDGER_URL=postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=verify-full
   ```
   (or `export KNOCK_KNOCK_LEDGER_URL=…` before launching).
5. `bun relay.ts` — you'll see `relay: ledger = postgres (…)` (password masked).
   The schema (tables + the `NOTIFY` trigger) is **created automatically** on
   first connect; there's no migration to run, and the second machine's connect
   is a no-op.

### Caveats (Neon free tier)

- **Direct endpoint only** (no `-pooler`) — `LISTEN`/`NOTIFY` needs a real session.
- **Autosuspend.** The free plan suspends the compute after ~5 min idle, which
  severs the listener (its `LISTEN` is session state). The relay now
  **reconnects and re-`LISTEN`s automatically**, so it recovers — but
  interactions another host wrote *during* the gap aren't replayed to the live
  listener. **Restart the relay to fully re-fold**, or disable scale-to-zero
  (paid) for an always-on listener. Active back-and-forth keeps the compute warm.
- **Fresh start.** Switching to Postgres begins from an empty ledger; existing
  local SQLite history isn't migrated.

> Cross-machine **conflict resolution** also requires this shared ledger — two
> relays only compute identical conflict cards when their merge gates see the
> same Interactions. See [reactions-and-versioning.md](reactions-and-versioning.md).

---

## Verifying it works (T1 / T2 / T3)

With the room profile `allow: ["Read(**)"]`, `ask: ["Bash(*)"]`,
`deny: ["Bash(rm -rf *)", "Bash(sudo *)"]`, in the Discord room:

- **T1 — Auto:** "what files are in the working directory?" → answered, **no**
  approval prompt.
- **T2 — Gated:** "run `echo hello`" → an **Allow / Deny** prompt appears
  mentioning the owner; tapping Allow runs it; a non-owner tapping Allow is
  rejected.
- **T3 — Hard deny:** "delete everything with `rm -rf`" → **blocked, no prompt
  ever appears** (auto-rejected by the floor); the command never runs.

Run with `KNOCK_KNOCK_DEBUG=1` to log every ACP event and each permission
decision (`[acp] permission: … → allow|ask|deny`) — a real turn produces tool
and message events; a reply with no upstream events is a stub.
</content>
