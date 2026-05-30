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
Claude Code Monitors — §3). This fold **is** the watch state; nothing else holds
it. On relay boot it replays from the log, so still-armed watches survive a
restart for free — same mechanism as every other fold.

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

- **Permission floor (non-negotiable).** The command is classified via
  `classifyTool(readRoomSettings(agent, channel), {toolName:'Bash', subject:
  command})` at arm time **and** the deny floor applies. A watch whose command
  is `rm -rf …` is refused — the supervisor admits `watch.disarmed{reason:
  'denied'}` and never spawns it. In the skeleton, `ask` is treated as refuse
  too: a background process can't sensibly route an interactive approval, so only
  an `allow`-classified command arms. (Designed, not yet shipped: arm an `ask`
  command in a *held* state and let the owner approve it once.)
- **Prompt-injection invariant.** Declarative watches come only from trusted
  config (the setup CLI / `access.json`), never synthesized from channel text —
  the same rule that protects `rooms/*.settings.json`. Imperative arming in the
  skeleton is **owner-only** (`!watch …`, short-circuited in `handleInbound`
  like the share/resume commands), so a peer agent can't arm a watch by talking.
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
  but the OS resource must run on the host that owns that workspace/file/process.
  The spec carries `agentKey`; only the owning `AgentHost`'s supervisor arms the
  live child. (Designed, not yet shipped: the skeleton assumes a single relay.)

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
6. Owner-only `!watch` / `!unwatch` arming in `AgentHost.handleInbound`, gated by
   `classifyTool` + the deny floor; wired into `relay.ts`.

**Designed, not yet shipped:**

- An **MCP `watch` tool** the relay exposes so the *agent itself* arms watches
  from natural language ("start watching the notes file") — the productionized
  arming path, replacing the owner `!watch` command. This is the right long-term
  UX; the owner command is the testable stand-in.
- Workbench rendering + reaction-to-cancel.
- Held-`ask` watches with one-time owner approval.
- Loop-guard fold exempting watch-descended turns.
- Cross-machine host affinity.
- A `poll` sugar (`every 30s: <cmd>`) and a `file` specialization using native
  `fs.watch` instead of a polling loop, as efficiency passes over the one
  command-based kind.

---

## 9. The one-line version

knock-knock turns are instantaneous request→reply. A **watch** adds the missing
third verb — a turn that *defers* and is *resumed by the world*. The relay owns
the wait, the ledger records the intent, and the agent just gets re-prompted when
reality changes.
