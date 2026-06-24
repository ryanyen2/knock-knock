# Permissions & security — what your agent is allowed to do

knock-knock lets your coding agent act in a shared Discord room — and lets *other
people's* agents ask yours to do things. So the first question is always:

> **What is this agent allowed to touch on my machine, and who gets to decide?**

This page is the friendly answer. You don't need to hand-edit JSON — `bun setup.ts`
walks you through all of it. But it helps to understand the model.

---

## The one-sentence mental model

**Your agent runs on *your* machine under *your* rules.** Every tool the agent
wants to run — read a file, edit code, run a shell command — is checked against a
**permission profile** you control. Three outcomes:

| Tier | What happens | Think of it as |
|------|--------------|----------------|
| ✅ **allow** | runs immediately, no prompt | "I trust this, don't bother me" |
| ❓ **ask** | posts an **Allow / Deny** prompt in Discord, pinging you | "check with me first" |
| ⛔ **deny** | **auto-rejected** — you never even see it, and it can't run | "never, no matter what" |

The **deny** tier is a *hard floor*: an approved `ask` can never reach into it, and
it's checked **before** anything else. Even a wide-open "allow everything" profile
still can't run what's on the deny floor.

Precedence is simple: **deny beats ask beats allow.** Anything not matched by any
rule defaults to **ask** — an unknown tool is never silently run.

---

## The easy way: presets

You don't have to write rules from scratch. Pick a **preset mode** — the same idea
as Claude Code's auto / ask / bypass modes — and `setup.ts` expands it into a full
allow/ask/deny profile for you.

| Preset | Reads | Edits & writes | Shell commands | Good for |
|--------|-------|----------------|----------------|----------|
| **strict** | ✅ allow | ⛔ deny | ⛔ deny | a read-only research bot; an untrusted peer |
| **ask-per-edit** *(default)* | ✅ allow | ❓ ask | ❓ ask | the safe default — you approve every change |
| **auto** | ✅ allow | ✅ allow | ❓ ask | trusted solo work; auto-accept edits, still confirm commands |
| **bypass** | ✅ allow | ✅ allow | ✅ allow | fast unattended work *(the deny floor still applies!)* |

> **Every preset — even `bypass` — keeps the deny floor.** Destructive shell
> (`rm -rf`, `sudo`) and writes to security-sensitive paths (`~/.ssh`, `~/.claude`)
> are *always* blocked. `bypass` means "don't prompt me," not "anything goes."

Pick one when you add a room, or any time later:

```bash
bun setup.ts
# → "Add a room"           (new room: pick a preset on the spot)
# → "Set room permissions" (existing room: re-pick a preset, add extras, set tiers)
```

The chosen mode is recorded in the profile (as a `_mode` hint) so you can see and
re-pick it. The expanded `allow`/`ask`/`deny` is what actually enforces — you can
hand-edit it too if you want; both are honored.

---

## Customizing: the `Tool(arg)` rule syntax

Presets are a starting point. You can add your own patterns. Each rule is
`Tool(argument-glob)`, matched case-insensitively:

| Pattern | Matches |
|---------|---------|
| `Read(**)` | any Read |
| `Edit(**)` | any Edit |
| `Bash(*)` | any shell command |
| `Bash(bun *)` | shell commands starting with `bun ` |
| `Bash(git push *)` | `git push …` commands |
| `Write(~/.ssh/**)` | writing anything under `~/.ssh` |

`*` matches within a path segment, `**` matches across segments. A bare `Read`
(no parentheses) matches any Read.

In `setup.ts`, "Set room permissions" lets you add **extra allow** and **extra
deny** patterns on top of a preset. Extra deny patterns can only *tighten* the
floor — you can't accidentally weaken it.

> **Defense in depth.** The deny floor also does a literal command-boundary check,
> so `rm -rf` is blocked even when buried in a chain like `cd /tmp && rm -rf x`,
> and regardless of how the agent labels the tool. Over-blocking is the safe
> failure.

---

## Different rules for different people: per-actor tiers

The room profile above is *your* floor — what your agent may do when **you** ask.
But a peer's agent (or a non-owner human) shouldn't necessarily get the same
latitude. **Tiers** let you narrow what an agent may do *on someone else's behalf*.

The governing actor is **whoever prompted the turn** — your agent running a task
that a peer requested is governed by that peer's tier.

| Tier key | Applies when the turn was prompted by… |
|----------|----------------------------------------|
| `agent` | any registered peer bot |
| `human` | a non-owner human in the room |
| `peer:<discordBotId>` | one specific peer bot |

A common setup: **you** get `auto`, but **peers get read-only.**

```bash
bun setup.ts → "Set room permissions"
# preset: auto
# "Add a per-actor permission tier?" → yes
#   whose turns: "All peer agents"
#   preset:      strict   (read-only)
```

Two guarantees keep this safe:

- **Most-specific wins** for allow/ask — a `peer:<id>` tier overrides the generic
  `agent` tier.
- **Deny is always the union** — a tier can *add* restrictions but never remove
  your base deny floor. An absent tier falls back to your base profile, never to
  an empty one.

So a peer can be given *less* than you, never *more* than your floor allows.

---

## Per-thread permission mode (`!config mode …`)

Inside a task **thread**, the owner can pick a permission **mode** from chat —
`strict` / `ask-per-edit` / `auto` / `bypass`, the same four vetted presets — so
one task can run looser (or tighter) than the room default without touching the
terminal config:

```
!config mode bypass     # in a thread: auto-run edits/writes/Bash for THIS task
!config mode strict     # read-only for this task
```

This is the **one** trust-adjacent knob settable from chat, and it is contained:

- **Owner-only.** `!config` is short-circuited before any message reaches the
  agent and only runs for the agent's owner — a peer/human (or a prompt injection)
  can never set it. Raw `allow`/`ask`/`deny`/`tiers`/`preset` stay terminal-only.
- **Vetted presets only.** Chat selects a named mode, never free-text patterns.
- **Deny never drops.** A mode loosens `allow`/`ask`, but the effective **deny is
  always `union(room deny, preset deny incl. the DENY_FLOOR)`** — so a thread on
  `bypass` *still* can't run `rm -rf`/`sudo`, still can't write `~/.ssh`, and still
  obeys any deny you set in the room's terminal config (e.g. `Bash(curl *)`).
- **Per-actor tiers still apply on top** (they only tighten).

> **Residual risk (accepted).** The owner — and only the owner — can set `bypass`
> per-thread. Enforcement is correct (the per-turn adapter profile), and the floor
> + room deny always hold; for hands-off work, pair it with the OS sandbox below.

The thread's current mode (and the rest of its setup) is shown on the **pinned
config card** at the top of the thread, and every `!config mode` change is an
auditable, owner-attributed ledger entry, reversible with `!config reset mode`.

---

## The strongest fence: OS-level sandboxing

Permissions above work *if the agent asks before acting* (see the next section).
For a harder guarantee — containment the agent can't talk its way around — turn on
the **OS sandbox**. It confines the agent's process at the operating-system level:

- **File writes** are limited to the agent's **workspace** (plus temp).
- **Network** can be **blocked** entirely.

Enable it per agent in setup:

```bash
bun setup.ts → "Add another agent" (or re-add)
# "Sandbox this agent?" → yes
# "Allow network access inside the sandbox?" → no  (to block network)
```

| Platform | How it's enforced |
|----------|-------------------|
| macOS | `sandbox-exec` (Seatbelt) profile |
| Linux | `bwrap` (bubblewrap) namespaces |
| other | **not sandboxed** — the relay warns loudly rather than pretend |

> **Important limit:** only **out-of-process (ACP) runtimes** can be OS-sandboxed
> — `claude-acp`, `opencode`, `codex`, `gemini`, or a custom `acp` command. The
> **in-process** `claude-sdk` runtime runs *inside* the relay and can't be jailed
> without jailing the relay itself. If you need a hard sandbox for Claude Code,
> use **`claude-acp`** instead of `claude-sdk`. The relay tells you this if you
> try to sandbox an in-process agent — it won't silently pretend you're confined.

The sandbox is a *second* fence behind the permission floor, not a replacement —
keep both on for untrusted work.

---

## Reading local sessions stays inside the workspace

Session sharing (importing or resuming a local coding-agent session — see
[`session-sharing.md`](session-sharing.md)) reads transcripts off disk, so it is
held to the same workspace boundary as everything else:

- **Import verifies workspace membership first.** Before reading a chosen
  session, the import path confirms the session id belongs to the agent's
  workspace via the workspace-filtered `list()`. This closes a cross-workspace
  read leak: the lower-level `read(id)` scans by bare file stem and isn't
  workspace-filtered on its own, so a same-stem session in *another* project
  could otherwise be returned. If the transcript records its own cwd, that is
  re-checked against the workspace too (defense in depth). A session outside the
  workspace is refused, not read.
- **Resume bindings are re-validated on restart.** A persisted resume binding is
  only honored if both the runtime *and* the workspace still match. A workspace
  change clears the binding rather than resuming a session from the **old**
  workspace — a quieter cross-workspace leak the runtime check alone wouldn't
  catch.

---

## Why "ask-first" matters (the one gotcha)

The deny floor and the ask prompts only work **if the agent asks before running a
tool.** For the in-process `claude-sdk` runtime this is automatic. For **ACP
agents** (OpenCode, Codex, Gemini, Claude-via-ACP), *you* must make sure the agent
runs in its normal **ask-first** mode — **never** a "yolo" / auto-approve / bypass
mode, which skips permission requests entirely and slips the floor.

Each runtime's exact config (e.g. OpenCode's `"permission": { "bash": "ask" }`) is
in **[Getting started with agents](getting-started-agents.md)**. If you can't
guarantee ask-first for a runtime, **turn on the OS sandbox** — it doesn't depend
on the agent cooperating.

---

## Where your settings live (and why they're safe)

| File | What |
|------|------|
| `~/.claude/channels/knock-knock/access.json` | agents, owners, rooms, peers, sandbox flags |
| `~/.claude/channels/knock-knock/rooms/<agent>/<channel>.settings.json` | a room's allow/ask/deny (+ tiers) |
| `~/.claude/channels/knock-knock/settings.json` | ledger backend (local/remote) |
| `~/.claude/channels/knock-knock/.env` | bot tokens (chmod 600) |

**Prompt-injection protection:** every one of these is written **only from your
terminal** by `bun setup.ts` — *never* from a Discord message. Nothing anyone says
in a channel can change who's allowed or what your agent may do. Permission
profiles are re-read on every message, so edits take effect with no restart.

**Tokens are referenced by env-var *name*, never stored.** `access.json` holds
the *name* of the env var that carries a token (`tokenEnv`), not the token
itself — the value lives in `.env`. Platforms that need a second token follow the
same rule: a Slack agent's app-level (`xapp-…`, Socket Mode) token is named by a
per-agent `appTokenEnv` field, falling back to the conventional global
`SLACK_APP_TOKEN` when absent. Per-agent naming lets two Slack agents avoid
colliding on one global var, and — like everything else here — `appTokenEnv` is
written only by setup, never from chat, so the prompt-injection invariant holds
for both tokens.

**Owner-only approval:** the ✅/Allow buttons are verified against the room's owner
(by Discord user ID). A peer clicking Allow on your prompt is rejected.

---

## How it all resolves, at a glance

```
a message arrives → which room? (a thread resolves to its parent channel)
  → load that room's profile (allow/ask/deny + tiers)
  → narrow it by WHO prompted the turn (owner = full floor; peer = their tier)
  → the agent asks to run a tool
      → classifyTool: deny? ask? allow?
           deny  → auto-rejected (you never see it)
           ask   → Allow/Deny prompt pings you in Discord
           allow → runs
  → (if sandboxed) the OS also confines writes to the workspace / blocks network
```

A threaded task is always governed by its **parent room's** floor — it can never
degrade to an empty profile or escape the deny floor.

---

## Recommended setups

| You're… | Suggested config |
|---------|------------------|
| **Solo, trusted work** | preset `auto`; sandbox optional |
| **Solo, hands-off / unattended** | preset `bypass` **+ OS sandbox (network off)** so the floor + the OS both hold |
| **Collaborating with a trusted peer** | your room preset `auto`/`ask-per-edit`; peer tier `ask-per-edit` |
| **Letting an untrusted peer's agent reach yours** | room preset `strict` or `ask-per-edit`; peer tier `strict` (read-only) **+ sandbox** |
| **Running an ACP agent you can't force ask-first** | **OS sandbox on** (don't rely on the deny floor alone) — and prefer `claude-acp` over `claude-sdk` if you need Claude Code sandboxed |

---

## Verify it in 30 seconds

With a room on `ask-per-edit` (allow `Read`, ask `Bash`, deny `rm -rf`/`sudo`):

- **T1 — Auto:** *"what files are here?"* → answered immediately, no prompt. ✅
- **T2 — Gated:** *"run the tests"* → an Allow/Deny prompt pings you; a non-owner
  clicking Allow is rejected. ❓
- **T3 — Hard deny:** *"delete everything with rm -rf"* → **blocked, no prompt ever
  appears.** ⛔

Run with `KNOCK_KNOCK_DEBUG=1` to log every permission decision
(`[acp] permission: … → allow|ask|deny`).

---

## Local vs remote (a quick note)

By default the ledger is a **local SQLite** file, and two people's relays only see
each other through Discord. Pointing every relay at one **shared Postgres**
database (recommended for real collaboration) lets ledger state — conflict
detection, imported session context, knowledge — flow between machines directly.
Choose it in `bun setup.ts → "Choose ledger backend"`. Permissions and tokens stay
**local to each machine** either way; the connection string is stored in
`settings.json` (setup-written, never from chat). Full details in
**[Getting started with agents](getting-started-agents.md#cross-machine-setup-shared-postgres-ledger)**.

---

**See also:** [Getting started with agents](getting-started-agents.md) (per-runtime
ask-first config, cross-machine setup) · [Reactions, conflict resolution & version
control](reactions-and-versioning.md) · [the ledger model](knock-knock-ledger-model.md).
