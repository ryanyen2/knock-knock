# Watches — giving a turn a way to wait

A design note for a new ledger primitive: the **watch**. It lets an agent
register interest in something that will happen *later* — a file changing, a
training job finishing, a script exiting, a deadline passing — and be woken to
act (and post to Discord) the instant it does, without holding a turn open and
without polling on a human cadence.

This is the generalization behind a cluster of requests that all look different
but are the same shape: *"post diffs of `notes_and_todo.md` as it changes,"*
*"tell me when the W&B run finishes,"* *"run this build and report the result,"*
*"remind me in two hours."*

> **Convention** (same as `knock-knock-ledger-model.md`): sections marked
> **Shipping in the skeleton** are what the first cut builds; **Designed, not
> yet shipped** is the fuller vision the skeleton grows into. The walking
> skeleton is deliberately the smallest thing that makes all four requests above
> work end-to-end.

---

## 1. The gap: a turn can't defer

A knock-knock turn has exactly two outcomes today: it **replies** (which posts
to Discord via `post-on-reply`) or it is **stopped**. There is no third outcome —
*"I can't finish yet; wake me when the world changes."* Every request above is
that missing third outcome:

| Request | Waiting on |
|---|---|
| Post diffs of `notes_and_todo.md` | a file changing |
| "notify me when the W&B run is done" | a remote condition becoming true |
| "run `./train.sh` and report" | a process exiting |
| "remind me in 2h" | a deadline elapsing |

Two structural facts make this impossible to bolt on at the agent layer, and
both are worth stating because they're *why the obvious attempts fail*:

1. **The only path from an agent to Discord is a completed turn.**
   `turn.replied` → `post-on-reply` → `AgentHost.discordSend`. A detached
   background process (a `while … sleep` loop, a `tail -f`) is not a turn, so it
   has no route back to the channel — its output goes into the void. A
   *foreground* loop never returns, so `turn.replied` never fires and nothing is
   ever posted. (This is the "stuck terminal script" failure.)

2. **The agent's own scheduler can't reach the channel, and floors at 60s.**
   Even when an agent calls `CronCreate`/the `loop` skill, (a) the minimum
   cadence is one minute, and (b) the job fires as a fresh detached run with no
   connection to the relay's turn→post pipeline, so its result can't be posted.
   The agent's scheduler and the relay's posting model do not compose.

And holding the turn open to `await sleep(2h)` is not the answer either: it pins
the adapter session, blocks the channel's serial turn queue, breaks stop/abort
semantics, and bills idle time. **The wait must live outside any turn — and the
relay, not the agent, must own both the wait and the re-prompt.**

---

## 2. The primitive: a watch

A watch drops into the existing anatomy of the system — *concept fold +
synchronization + relay subscriber* — exactly the way the Workbench pill already
posts to Discord outside of any turn (`relay.ts`, the `store.subscribe` →
`updatePill` block). Four parts:

### 2.1 Three verbs, recorded like everything else

Added to the `Verb` union in `ledger/interaction.ts`:

- **`watch.armed`** — an agent (or the owner) registers a watch. Carries the
  `WatchSpec` as an `external` patch intent (`{channel:'tool', op:'watch.arm',
  args: WatchSpec}`), the same transport shape `channel.message` uses to carry
  its text.
- **`watch.fired`** — emitted by the supervisor when the watch's gate matches.
  Carries the synthesized prompt as `external`/`args.text` — *structurally
  identical to an inbound `channel.message`*, which is the whole trick: it makes
  the existing `drive-turn` run a normal turn from it with zero new code (see
  §2.3).
- **`watch.disarmed`** — fired-and-done, expired (TTL / max-fires), or
  owner-canceled. Removes the watch from the live set.

Because the fired *line* is recorded as data on the interaction, replay is
deterministic: re-folding the ledger reproduces the same fires without re-running
the process. (Rubric #1 holds.)

### 2.2 The `watch` concept fold

`ledger/concepts/watch.ts` folds `watch.armed` / `watch.disarmed` into the live
set: `Map<watchKey, WatchSpec>`, keyed `${channel}:${name}` so a re-arm with the
same `name` replaces rather than duplicates (the dedup key idea, borrowed from
Claude Code Monitors — §3). `channel` here is the task **scope** (the thread the
watch was armed in), so a fired watch resumes its turn right there. This fold
**is** the watch state; nothing else holds it. On relay boot it replays from the
log, so still-armed watches survive a restart for free — same mechanism as every
other fold.

### 2.3 The `resume-on-watch` synchronization

`ledger/synchronizations/resume-on-watch.ts` matches admitted `watch.fired` and
admits a `turn.prompted` whose `caused_by[0]` is the `watch.fired` hash. This is
the proven pattern `retry-on-reaction` already uses to synthesize a turn from a
non-message event. `drive-turn` then reads `caused_by[0]`, sees an `external`
patch with `args.text`, and drives the adapter — **it never checks the parent's
verb**, so a `watch.fired` and a `channel.message` are interchangeable to it.
The agent runs, replies, and `post-on-reply` posts the result. No new posting
path; the watch result reaches Discord through the front door.

### 2.4 The `WatchSupervisor` (relay-level, owns the OS resource)

`watch-supervisor.ts` is the one piece that touches the operating system. It
`engine.subscribe`s to the watch fold and reconciles desired-vs-running: for each
armed watch not yet running it spawns the command as a long-lived child process
in the agent's workspace; for each running watch no longer in the fold it kills
the child. Each stdout line is run through the **pure `watchGate`** (in `lib.ts`,
unit-tested like `loopGuard`); on a match it `admit`s a `watch.fired` directly
against the store — exactly as `AgentHost.handleInbound` admits a
`channel.message` from outside any wave.

The live child process is **not** in the ledger; it's relay runtime state rebuilt
from the fold, the same way the Discord client and the pill timers are. The
ledger holds the *intent* (armed/fired/disarmed); the supervisor holds the
*handle*.

```
file/process/poll changes
  → WatchSupervisor reads a line → watchGate → admit(watch.fired)   [outside any turn]
  → resume-on-watch → admit(turn.prompted)
  → drive-turn → adapter.prompt → turn.replied
  → post-on-reply → Discord post
```

---

## 3. Borrowed from Claude Code's Monitors

Claude Code ships a closely-related primitive — **Monitors**
(`tools-reference#monitors`, `plugins-reference#monitors`) — and its design
sharpened this one. What we took:

- **One shape covers everything: a supervised long-running command whose every
  output line is an event.** Claude Code's monitor is just `{name, command,
  description, when}` — `tail -F error.log`, a poll script that sleeps and echoes
  on change, a CI poller. We adopt this wholesale instead of inventing separate
  `file`/`process`/`poll`/`timer` kinds: a file watch is `tail -F`, a poll is a
  `while … sleep` loop, a timer is `sleep 7200 && echo`, a job-watch is the job
  command itself. The only thing we add on top is a **fire gate** (§5), because
  knock-knock can't afford to spawn a turn per noisy line.
- **`name` as a stable dedup key** so reload/re-arm doesn't spawn duplicate
  processes. Our fold key is `${channel}:${name}`.
- **Permission = the Bash rules.** *"Monitor uses the same permission rules as
  Bash, so allow and deny patterns you have set for Bash apply here too."* We
  classify a watch command through the exact same `classifyTool` path as any
  Bash call, against the room's `allow/ask/deny` profile, with the deny floor in
  force (§5).
- **Declarative vs imperative.** Claude Code has both plugin-declared
  (`when: always`) and tool-invoked monitors. Our analog: imperative arming
  (an agent/owner arms a watch in the moment) and, later, declarative watches in
  `access.json` armed at boot.

Where we **diverge**: a Claude Code monitor *interjects a notification into an
ongoing interactive session*. knock-knock has no idle session to interject into —
turns are discrete and there's a Discord channel, not a human at a prompt. So a
fired watch **re-prompts a fresh turn** (cron-like) rather than streaming a
notification. We keep Claude Code's wisdom of *"react only when it matters"* by
putting the gate in the watch spec instead of asking the model per line.

---

## 4. How the requests map

| Request | Watch |
|---|---|
| Diffs of `notes_and_todo.md` | `command: diff-on-change script`, `fireOn: change` → agent posts the diff |
| W&B run done | `command: poll wandb status; echo when done`, `fireOn: match /done/`, `oneShot` → agent posts "✅ training done" + @mentions owner |
| `./train.sh` then report | `command: ./train.sh`, `fireOn: exit` → agent posts the tail + exit code |
| Remind in 2h | `command: sleep 7200 && echo remind`, `fireOn: each-line`, `oneShot` |

One primitive, four behaviors. The file-collaboration experiment that started
this is just the first row — and the *applying* agent on the other side already
works: it's prompted the instant the diff lands, through the normal inbound path.

---

## 5. Safety & runaway control

This is the part to get right from day one, because a watch *runs a script,
repeatedly, unattended.*

- **Permission floor, three-way (non-negotiable).** The command is classified
  via `classifyTool(resolveRoomProfile(membership.profile), {toolName:'Bash', subject:
  command})` at arm time — the watch's `channel` is the task scope (a thread), so
  the profile is read against the **room** it resolves to (`roomForScope`), never
  an empty profile. The arm-gate is `WatchControl.arm` (`host/watch-control.ts`):
  - **`deny`** → refused outright (the hard floor — `rm -rf …` never arms,
    never runs).
  - **`allow`** → armed immediately.
  - **`ask`** → *held*: the owner gets one ✅/❌ for the **exact command** (via
    the existing `Approvals.postDiscord` + `awaitVerdict`, anchored on a
    `watch.requested` interaction), and `watch.armed` is admitted only on
    approve. This is essential because the tier order is `deny → ask → allow`
    (first match wins): a typical `ask:[Bash(*)]` profile **shadows every Bash
    `allow`**, so pre-allowlisting a watch command is impractical — approving the
    command once is the usable path. The owner's own `!watch` is pre-approved
    (typing the command *is* the approval). The supervisor then backstops the
    **deny floor only** — an armed watch has already cleared arm-time gating, but
    a `deny` command is refused at spawn no matter how it got armed.
- **Prompt-injection invariant.** Declarative watches come only from trusted
  config (the setup CLI / `access.json`), never synthesized from channel text —
  the same rule that protects `rooms/*.settings.json`. The owner `!watch` command
  is owner-only (short-circuited in `handleInbound`); the agent self-arms via the
  MCP tool but every `ask`-tier command it proposes is held for owner approval,
  so a peer can never cause an unapproved command to run in the background.
- **The gate prevents turn spam.** `fireOn` (`each-line | change | match | exit`)
  decides which lines escalate to a turn. A chatty `tail -F` with `fireOn: change`
  fires only on distinct lines, not every line.
- **TTL / max-fires.** Every watch carries an optional `ttlMs` and `maxFires`;
  the supervisor auto-disarms when either trips, so a forgotten watch can't poll
  forever.
- **Loop-guard interaction (known, documented).** `resume-on-watch` admits
  `turn.prompted` directly, bypassing the loop-guard *decision* (a watch fire is
  an external trigger, like an owner's 🔁 — legitimately exempt). The loop-guard
  *fold* still counts these turns, so a burst of watch fires can transiently
  raise the consecutive-agent counter for ordinary chat. The watch's own
  TTL/max-fires is the real bound; teaching the loop-guard fold to skip
  watch-descended prompts is a clean follow-up (Designed, not yet shipped).
- **Feedback loops.** A watch on a file the agent itself edits can self-trigger.
  `fireOn: change` compares against the last fired line, which damps the trivial
  case; the durable fix (ignore changes the agent just authored) is a §7-style
  causal check, deferred.

---

## 6. The §4 surface

A watch is ledger state, so it surfaces the same way every other cue does
(pure renderer + thin glue), reusing the existing glyph vocabulary — no new UI
invented:

- **Armed watches appear in the Workbench** — e.g. `⏳ wandb-done · poll · every
  30s`. (Designed, not yet shipped; the skeleton logs arm/fire/disarm to the
  operator console.)
- **Owner cancels** with `!unwatch <name>` (skeleton) → a reaction on the
  workbench line (later), mirroring the 🛑 stop control.
- **Attribution.** A watch-driven reply is `caused_by` the `watch.fired`, so the
  attribution line already reads *"↳ triggered by watch «notes_and_todo.md»"*
  with no extra plumbing.

---

## 7. Lifecycle, reboot, cross-machine

- **Reboot.** The `watch` fold replays armed-minus-disarmed watches; the
  supervisor's initial `engine.subscribe` callback re-arms them (re-spawns the
  children), deduped by `name`. Live children die with the process and are
  rebuilt — never persisted.
- **Cross-machine.** With the Postgres backend a watch is in the shared ledger,
  but the OS resource must run on exactly one host. The spec carries `agentKey`;
  only an `AgentHost` that owns that channel arms the live child. When several
  relays serve the same agent off one ledger, two extra elections keep the
  spawn/fire story single-owner — each gated behind the relay's `relayId`, so a
  single-relay setup omits it and is unaffected:
  - **Single-owner spawn.** Before spawning, the `WatchSupervisor` wins a
    cross-relay `external_claim` on the watch's stable identity
    (`watch-run/<agentKey>/<channel>/<name>`, the same key on every relay), so the
    command runs on exactly one machine; the others stand by. The owner renews the
    claim at half-TTL while the child runs.
  - **Failover.** On kill/stop the renewal stops and the claim lapses (no explicit
    release — the TTL hands it off). A half-TTL periodic reconcile tick
    (multi-relay only) re-reconciles against the current fold, so a standby relay
    re-takes a dead owner's lapsed claim even when the watch fold is quiescent.
  - **Single fire → single resume.** `resume-on-watch` gates the resumed
    `turn.prompted` behind a per-fire `external_claim` keyed on the fire's hash
    (`watchfire/<hash>`, identical on every relay). A replicated `watch.fired` is
    seen by every relay's synchronizer, but exactly one wins the claim and
    resumes the agent.

---

## 8. Walking-skeleton scope

**Shipping in the skeleton** — the smallest end-to-end that makes all four
requests in §4 work:

1. `watch.armed` / `watch.fired` / `watch.disarmed` verbs (`interaction.ts`).
2. Pure `WatchSpec`, `watchGate`, `parseWatchCommand`, `renderWatchPrompt` in
   `lib.ts`, unit-tested in `lib.test.ts`.
3. `watch` concept fold (`ledger/concepts/watch.ts`) + test.
4. `resume-on-watch` synchronization + test.
5. `WatchSupervisor` (`watch-supervisor.ts`) with an injectable `spawn` seam +
   test using a fake process.
6. Owner-only `!watch` / `!unwatch` — detected in `AgentHost.handleInbound` and
   handled by `WatchControl` (`host/watch-control.ts`), gated by `classifyTool`
   + the deny floor; wired into `relay.ts`.
7. **Agent self-arming via an in-process MCP tool** (`adapters/watch-mcp.ts`):
   the SDK adapter exposes `watch` / `unwatch` / `watch_list` so the agent arms
   from natural language ("start watching the notes file"). Both paths — the
   owner `!watch` command and the agent tool — funnel through one
   permission-gated arm path (`WatchControl.arm`), so the deny floor applies
   identically.
   The tool calls auto-allow (the *command* is still classified); the agent is
   nudged toward the capability by a one-line preamble entry, shown only for
   runtimes that wire the tool (`runtimeSelfArmsWatches`).
8. **Held-`ask` arm approval** (`WatchControl.requestApproval`): an agent-armed
   command that classifies `ask` is posted to the owner for one ✅/❌ (reusing
   `Approvals` + `awaitVerdict`, anchored on a `watch.requested` verb); the watch
   arms only on approve. The supervisor's spawn gate relaxed to **deny-floor
   only**. This is what makes self-arming usable under a real `ask:[Bash(*)]`
   profile — see §5.
9. **Robust profile resolution** (`lib.ts`/`resolveRoomProfile`): the member's
   inline `profile` is the single source, with the `DENY_FLOOR` always re-unioned
   at read time and an absent profile failing restrictive (deny-floor only) — so a
   missing or stale profile can never silently drop the deny floor. (Profiles are keyed by room; `roomForScope` resolves
   a threaded turn's scope back to its room before the read.)

### How the agent self-arming works (§3 "imperative" path)

The tool surface mirrors Claude Code's Monitor schema (`{name, command, …}`).
The handler runs **in-process** (no extra process, native to the SDK adapter):
the agent calls `mcp__knock-knock__watch`, the handler translates the flat args
to a `WatchArmPartial` (`armArgsToPartial`, pure + tested), the host fills in
channel + agentKey, deny-floors the command, and admits `watch.armed` — the
same interaction the `!watch` command produces. From there the supervisor and
`resume-on-watch` are unchanged. The host stays SDK-free: only plain
`WatchToolHandlers` functions cross the seam (defined in `agent-adapter.ts`),
and the SDK import lives entirely in `adapters/watch-mcp.ts`.

ACP agents don't get the in-process tool yet — they'd self-arm through their own
MCP config, which is runtime-specific (deferred). The owner `!watch` command is
the universal fallback and works for every runtime.

**Designed, not yet shipped:**

- ACP self-arming (per-runtime MCP config so out-of-process agents get the tool).
- Workbench rendering + reaction-to-cancel.
- Loop-guard fold exempting watch-descended turns.
- A `file` specialization using native `fs.watch` instead of a polling loop, as
  an efficiency pass over the one command-based kind. (The `every=<dur>` poll
  sugar — which desugars a one-shot check into a `while … sleep` loop — already
  ships in `parseWatchCommand`, but **only on the owner `!watch` path**: the agent
  MCP `watch` tool still asks the agent to write its own loop.)

---

## 9. The one-line version

knock-knock turns are instantaneous request→reply. A **watch** adds the missing
third verb — a turn that *defers* and is *resumed by the world*. The relay owns
the wait, the ledger records the intent, and the agent just gets re-prompted when
reality changes.
