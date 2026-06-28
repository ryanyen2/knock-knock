---
title: "feat: Thinner, self-healing, scope-isolated mesh transport"
type: feat
status: active
date: 2026-06-28
depth: deep
origin: architecture discussion — "can we get rid of mesh if we focus on CRDT more?"
revision: 2 — reworked after ce-doc-review (6 personas). Scope decision: all 3 phases, minimized;
  drop-at-ingest channel guard is now core; instrumentation phase added before reliability phasing.
---

# feat: Thinner, self-healing, scope-isolated mesh transport

## Summary

The no-Postgres mesh (`KNOCK_KNOCK_MESH=1`, SQLite) has two distinct weaknesses, and the goal here is
a **thinner, informative** mesh that fixes both without growing the transport's footprint:

1. **No scope isolation on ingest (the headline).** `MeshSync.ingest()` appends every provenance-valid
   line **verbatim** (`src/host/mesh-sync.ts:120`) with no check that the event's logical channel is one
   this relay actually serves. The plan used to claim "ingest restores `i.channel`" as if routing were
   filtering — it is not. When a dedicated transport channel multiplexes events for several
   channels/projects (exactly what `transportScope` enables), every relay on that channel ingests and
   folds **every other project's** coordination state. That is cross-channel (cross-project) pollution,
   and history replay would amplify it from a live trickle to a full-history flood.

2. **Fire-and-forget transport (no self-heal).** `start()` subscribes only to *future* local inserts;
   `ingest()` appends what arrives. There is **no recovery path**: a line the chat platform drops,
   rate-limits, or delays past a peer's downtime is lost, and the two ledgers **diverge permanently**.
   This is a correctness bug, not just staleness: cross-machine election is deterministic *only when
   every relay elects over the same event set* (`meshTaskClaimant` / `projectCoordinationBoard`), so a
   diverged ledger means two bots can elect **different winners** → double-answer / double-claim.

The data model is already a CRDT (content-addressed, append-only, idempotent `store.append`,
deterministic `(createdAt, hash)` fold ordering). We are not introducing one. The work is: (a) make
ingest **scope-respecting** so a relay's ledger only ever holds channels it serves, and (b) make the
transport **self-healing** so a CRDT has the reconciliation step it is designed to lean on. The chat
channel stays the bus.

A third, independent gap — **identity is spoofable** (`meshProvenanceOk` trusts `senderUserId`, no
signatures) — is carried as a **flagged, not-committed** track (Phase 3) because it touches a prior
decision to drop signing and is orthogonal to convergence.

## Goals → coverage (this is the contract the plan is verified against)

| Stated goal | Where it's served | Status |
|---|---|---|
| **No cross-channel / project pollution** | Phase 1a — drop-at-ingest guard: `i.channel` not served ⇒ not appended | **New core work** |
| **No cross-platform pollution** | Existing: each `AgentHost` is single-platform; `i.channel` is platform-scoped via `channelKey`. Phase 1a guard reinforces it | Confirm + reinforce |
| **No cross-thread / task pollution** | Existing: `roomForScope` collapses a thread to its parent room; coordination keys on the room, not the thread. Phase 1a guard applies at room granularity | Confirm |
| **Workers coordinate without conflict / racing** | Phase 1b (replay) restores the converged event set that deterministic election presupposes | Phase 1 |
| **Workers know when to step in / out** | Election correctness — requires converged event set **and** that task age derives from `createdAt`, not local ingest time (see §Critical detail 3). Verified, not assumed | Phase 1 + explicit test |
| **Thinner layer** | `fetchRecent` stays off the `MessagingAdapter` interface (duck-typed dep); Phase 2 gated behind a configured transport channel + evidence; Phase 3 not committed | Throughout |

## Non-goals (constraints this plan must not violate)

- **No shared database anyone must register against.** Each relay keeps its own local SQLite ledger.
- **No P2P / NAT traversal / broker** (WebRTC, libp2p, DHT, Raft/Paxos quorum) — each reintroduces a
  server, a member registry, or stalls when one of two peers is offline.
- **The model is never in the merge path.** Merge stays pure and deterministic (hash equality + total
  order). The LLM may *author* an action (decide to claim a task); it must never *arbitrate* how actions
  combine. A model-generated "merge DSL" is rejected: it makes divergence non-reproducible and re-opens
  the integrity surface the content-hash check (`src/lib.ts:1878`) closes.
- **No change to the Interaction record or to `encodeMeshEvent`/`decodeMeshEvent`'s security filter.**
  New sync messages (Phase 2) are *new line types* with their **own** explicit filter (§Phase 2), not
  changes to the existing one.
- **Anti-entropy beacons never post to human rooms.** Phase 2's periodic traffic is gated on a
  configured transport channel, so the cleanliness the transport-channel work already bought is not
  silently traded back.
- **The replay path must be no weaker than the live path** (same sender-trust gate; see Phase 1b).

## Design

Three mechanisms, ordered by leverage and dependency. Phase 1a (the isolation guard) lands first because
replay *amplifies* the pollution it fixes — never ship replay before the guard.

- **Phase 0 — Instrumentation.** Before committing to a Phase-1-then-2 sequence, measure what the misses
  actually are. Replay-on-reconnect only recovers **offline** gaps; if the dominant failure is a live
  drop while both peers are online, replay never fires. Cheap counters/logs settle this empirically
  instead of by assumption (origin is `none`, so nothing upstream validated the premise).

- **Phase 1a — Scope-isolated ingest (the no-pollution fix).** In `ingest()`, after decode and before
  append: if `i.channel !== 'agent-directory'` and `resolveRoom(i.channel)` is `undefined`, **drop** the
  event (debug-log it). A relay's ledger then only ever holds channels it serves. This also closes the
  pre-existing live-path hole, and is a prerequisite for safe replay.

- **Phase 1b — History replay on reconnect (recovers the offline gap).** The chat channel is itself a
  durable, ordered log the platform retains while a bot is offline, so the dominant offline gap is
  recoverable by reading the channel back on connect and re-ingesting each `⟦kk-mesh⟧` line through the
  (now scope-guarded) `ingest()`. Idempotent append + `(createdAt, hash)` ordering make dup/reorder
  non-issues. One duck-typed adapter capability; no new wire protocol.

- **Phase 2 — Causal-gap backfill (precise self-heal beyond the window).** When an ingested event's
  `caused_by` references a hash this relay lacks, broadcast a compact authenticated "want"; a holding
  peer re-posts. A periodic frontier digest (`store.channelFrontier`) lets peers notice divergence
  proactively. **Gated, authenticated, scope-bounded, rate-limited** (§Phase 2). Build only on Phase 0
  evidence that gaps survive Phase 1b.

### Critical correctness detail 1 — replay must be identity-first, and the cross-window hole is real

Provenance is checked at **decode time against the current directory** (`decodeMeshEvent` →
`meshProvenanceOk`, `src/lib.ts:1879`). `agent.identity` lines self-certify (`d.userId === senderUserId`,
`:1829`); `coord.note`/`task.*` do not — they are dropped unless the actor is already in the directory.
So replay/backfill must ingest identity lines **before** the coordination lines that depend on them:
a **two-pass replay** (pass 1 = identity verbs, pass 2 = the rest).

**Known residual the two-pass does NOT close:** a long-lived peer whose `agent.identity` beacon predates
the `WINDOW` but whose recent `coord.note` is inside it. Pass 1 finds no identity in the window → pass 2
drops the note. The locally-persisted directory (rebuilt on bootstrap from this relay's own ledger) only
saves this if this relay previously persisted that beacon. Mitigations, in order of preference:
(a) page back until every actor referenced by an in-window coord line is resolved ("identity-complete"
stop condition), or (b) accept it as a gap Phase 2's want/backfill closes — but then **do not** claim
two-pass is "robust regardless of interleave." Pick (a) or (b) explicitly during implementation.

### Critical correctness detail 2 — the task fold is NOT idempotent under a *bounded* replay

Idempotent append makes the LWW coord board safe under any subset. The **task** fold is not: replaying
`task.claimed` whose later `task.completed` lies outside the window rebuilds the task as `claimed`, and
`encodeMeshEvent` drops `i.supersedes` entirely (no allowlisted verb carries it), so `apply-supersession`
can never fire from a replayed line. A settled task can therefore resurrect as claimable. The plan must:
state that task-fold correctness under replay depends on the terminal event being *in the window*; add a
test (replay `created`+`claimed` without `completed` → task must NOT reappear claimable); and separately
confirm whether any allowlisted verb should carry `supersedes` (if so, dropping it is a pre-existing bug
the replay path will exercise far more often).

### Critical correctness detail 3 — "step in / out" needs age from `createdAt`, not ingest time

Election (`meshTaskClaimant`) is a pure function of the eligible set, the task id, **and** `ageMs`. A
relay that learns a task via replay must compute `ageMs` from the event's `createdAt` (the original post
time), not from "now." The scheduler already reads `createdAt` — the risk is the **replay storm**: each
appended line re-fires the scheduler synchronization against a half-built board, and a fresh peer with a
large `ageMs` is exactly the failover slot the ladder hands the claim to. Mitigation: ingest the whole
window, **then** fold/schedule once on the settled set (suppress per-insert scheduler firing during
replay). Verify two relays compute the **same** claimant slot post-replay.

---

## Phase 0 — Instrumentation (miss classification)

- `src/host/mesh-sync.ts`: the existing `sendLine` catch already logs publish failures — promote it to a
  counter and tag it `online-drop` (both peers connected when a send fails).
- Add a **causal-gap counter**: in `ingest()`, when a decoded event's `caused_by` contains a hash with no
  local `getByHash`, increment a `gap-detected` counter and debug-log it. This is the metric that tells
  you whether gaps survive — and it is the Phase 2 trigger signal. (Building the *counter* now is cheap;
  the *responder* is Phase 2.)
- On reconnect replay (Phase 1b), log `replayed N, ingested M new, window-saturated=<bool>`.
- **Decision gate:** run two real relays for a representative period. If `online-drop` / `gap-detected`
  while-connected dominate offline-recoverable gaps, Phase 2's timer-driven frontier digest is the real
  fix and should be sequenced ahead of (or instead of) leaning on replay. Record the finding in the plan.

---

## Phase 1a — Scope-isolated ingest

- `MeshSyncDeps` already carries `resolveRoom: (scope) => string | undefined`. In `ingest()`, after
  `decodeMeshEvent` returns a valid `i` and before `store.append`:
  `if (i.channel !== 'agent-directory' && !this.deps.resolveRoom(i.channel)) { dbg('dropped foreign-channel ' + i.verb + ' for ' + i.channel); return false }`
- This changes live-path behavior too (today foreign-channel events are appended). That is the intended
  no-pollution fix; document it in `docs/how-coordination-works.md`.
- `agent.identity` is exempt (channel `agent-directory`) — beacons must always be ingested so the
  directory converges; they carry `rooms` for discovery and cannot themselves drive a turn.

**Execution note:** characterization-first. Add a test that today's `ingest` appends a foreign-channel
event, then flip it to assert the guard drops it.

## Phase 1b — History replay on reconnect

### Adapter capability (kept OFF the `MessagingAdapter` interface — thinness)

- Do **not** widen `MessagingAdapter` (17 methods today). Define a mesh-local function type
  `FetchRecent = (scope: ScopeId, limit: number) => Promise<{ authorId: string; text: string }[]>`
  (oldest-first; `createdAt` is in-band, so no `ts` field). In `agent-host.ts`, duck-type the connected
  adapter (`const fr = (this.messaging as { fetchRecent?: FetchRecent }).fetchRecent`) and pass it to
  MeshSync only when present. Discord/Slack export `fetchRecent`; no other adapter is touched.
- **This is new code, not a reuse.** `discord.ts:220` is the single-message-by-id overload; paging needs
  `channel.messages.fetch({ limit, before })` — capped at 100/call (so `WINDOW=200` ≥ 2 calls with a
  `before` cursor), returned newest-first → reverse for the oldest-first contract. Slack:
  `conversations.history` with `cursor`.

### MeshSync replay

- `MeshSyncDeps`: add `fetchRecent?: FetchRecent` (optional → undefined preserves today's behavior) plus
  a sender-trust predicate (below). Reuse `transportScope`/`allRooms` to pick the scope(s) to replay.
- New `MeshSync.reconcileOnConnect()`, called after `start()` + `announceIdentity`: `fetchRecent(scope,
  WINDOW)`, filter to `isMeshLine`, **two-pass** (identity then rest), ingest the whole window, then let
  folds/scheduler settle once (per §Critical detail 3).
- `WINDOW = 200` (a const, not config — CLAUDE.md §3 Simplicity). **Warn-on-saturation:** if the fetched
  batch size equals `WINDOW`, log a loud "replay window may not cover the offline gap — divergence
  possible." A bounded replay must never report success without flagging that it may have under-covered.
- **Sender-trust parity:** the live path gates on `guildSenderAllowed` (`agent-host.ts:1025`) *before*
  ingest; replay calls ingest directly and must apply the **same** predicate. Pass the room's allowlist
  check into MeshSync (or a `senderAllowed(scope, authorId)` callback) and skip any replayed line whose
  author the live path would reject. This specifically bounds who can inject `agent.identity` beacons on
  replay (closing the self-inflation vector security flagged).

### Risks (state in the plan, don't discover at runtime)

- **Slack bot-author provenance:** `conversations.history` may return `bot_id` rather than the `user`
  id for bot messages. Mesh lines are bot-authored, so `authorId` must equal the `userId` the peer
  published in its identity beacon, or every replayed Slack line fails provenance silently. Verify the id
  shape (the codebase already distinguishes these at `slack.ts:476`); resolve `bot_id`→user id if needed.
- **Concurrency:** replay runs alongside the live `messageCreate` stream; an event can be ingested twice.
  Correct by idempotent append; the `ingested M new` count is best-effort, not exact.
- **Retention/pagination:** if platform retention is shorter than the gap or paging truncates, replay
  under-covers — the warn-on-saturation log is the only signal; Phase 2 is the actual coverage proof.

---

## Phase 2 — Causal-gap backfill (gated, authenticated, scope-bounded)

Build only on Phase 0 evidence, and **only when a transport channel is configured** (never emit
anti-entropy traffic to human rooms). Two new line types behind their own prefixes (siblings of
`MESH_PREFIX`), each with an **explicit decode filter** (the existing filter is unchanged, per Non-goals):

- **Want** `⟦kk-want⟧[hashes]` — "I am missing these hashes." Emitted on a causal-gap detection or an
  unknown head in a received digest. Decoder: reject if not from a sender in the agent directory; cap the
  hash-list length (e.g. ≤100); strict hex-format-validate every hash before any `getByHash`.
- **Frontier digest** `⟦kk-frontier⟧{channel: heads[]}` — periodic, slow, peer-gated like the identity
  heartbeat. **Scope-bounded:** only digest channels the requester is known to serve (via the
  `agentKey→rooms` directory), so a transport-channel member cannot enumerate another project's
  event graph (cross-channel exfiltration).

Backfill responder: on a Want for hashes we hold **whose `i.channel` the requester serves**, re-post them
as ordinary `⟦kk-mesh⟧` lines (identity-first). **Suppression to avoid amplification/racing:**
jitter + "skip my re-post if I already saw another peer answer this Want within W ms" (the same
observe-the-channel pattern the identity heartbeat uses). Rate-limit re-posts per sender. State the
expected duplicate-message bound.

**Scope guard:** no Merkle-range / IBLT set-reconciliation. At a few bots and thousands of events,
causal-gap want + bounded digest converge and stay debuggable.

---

## Phase 3 — Identity hardening (flagged, NOT committed)

Kept in this doc only so the threat model is on record; **recommend deferring** unless the channel
becomes adversarial. A prior decision (a `project-vc-crdt-redesign` memory in another session — **not
present in this repo's memory dir, treat as unverified**) dropped signing; this plan does not reopen it
unilaterally.

- Gap: `meshProvenanceOk` (`src/lib.ts:1821`) authenticates by "platform `senderUserId` owns this
  `actor`" — spoofable by anyone who can post as that account. Residual even with Phase 1b's allowlist:
  a trusted-but-malicious member can self-inflate (register any `agentKey` under their own `userId`).
- No-registration fix: **TOFU + self-sovereign Ed25519 keys** (public key in the beacon; sign every line;
  remember a bot's key on first sight, like `known_hosts`). If pursued, the doc must specify:
  (a) first-sight tie-break (lowest-timestamp beacon wins, or operator pre-seeding) to close the
  substitution window; (b) a rotation ceremony (re-announce signed by the old key); (c) **no silent
  downgrade** — once any peer enables signing, unsigned beacons are rejected.

---

## What this explicitly does NOT do

- Does **not** delete `MeshSync` or the chat-channel transport. CRDT is merge semantics; mesh is the
  pipe. You make the pipe self-healing (this plan), you don't remove it by improving the merge.
- Does **not** add a model-generated merge DSL.
- Does **not** widen the `MessagingAdapter` interface, post anti-entropy traffic to human rooms, or change
  Postgres behavior (`MeshSync` is never constructed there).

## Files

- `src/host/mesh-sync.ts` — Phase 0 counters; Phase 1a scope guard in `ingest`; Phase 1b `fetchRecent`
  dep + `senderAllowed` dep + `reconcileOnConnect` (two-pass, ingest-then-settle, warn-on-saturation);
  Phase 2 want/frontier + suppressed responder
- `src/agent-host.ts` — duck-type `fetchRecent`, pass `resolveRoom`/`senderAllowed`/`fetchRecent` to
  MeshSync, call `reconcileOnConnect` on connect
- `src/adapters-msg/discord.ts`, `src/adapters-msg/slack.ts` — export `fetchRecent` (paging; not on the
  interface)
- `src/lib.ts` — Phase 2 only: `⟦kk-want⟧`/`⟦kk-frontier⟧` encode/decode + `isWantLine`/`isFrontierLine`
  with their own length/hex/sender filters
- `docs/how-coordination-works.md` — scope-isolation behavior change; "what happens when a line is missed"
- Tests: `tests/host/mesh-sync.test.ts` (foreign-channel drop; replay recovers a missed event;
  identity-first; task-fold terminality; election-slot agreement post-replay; want/backfill round-trip),
  adapter `fetchRecent` unit tests

## Test scenarios

- **Phase 1a (no-pollution):** a relay serving only H1 ingests a transport-channel line whose
  `i.channel = H2` → the event is **dropped**, does not appear in this relay's board/task fold/election
  set. An `agent.identity` line is still ingested.
- **Phase 1b regression-first:** with no replay, a coord event posted while a peer is "offline" never
  appears in that peer's ledger; after `reconcileOnConnect`, it does.
- **Identity-first:** a window with a fresh peer's `agent.identity` *and* its `coord.note` ingests both
  (note not dropped for unknown actor).
- **Task-fold terminality:** replay a window with `task.created`+`task.claimed` but NOT `task.completed`
  → the task does **not** reappear as claimable.
- **Election agreement:** two relays, one having learned a task via replay, compute the same
  `meshTaskClaimant` slot for it at the same wall-clock moment (age from `createdAt`).
- **Sender parity:** a replayed line from a sender the live path rejects is not ingested.
- **Idempotent replay / capability gating / backward-compat:** replaying an already-held window appends
  nothing; `history:false` adapter no-ops; absent `fetchRecent` dep ⇒ behavior identical to today.
- **Phase 2:** a `caused_by` gap triggers a Want; a holding peer re-posts; gap closes. A Want from a
  non-directory sender, an over-long hash list, or for a channel the requester doesn't serve is rejected.

## Verification (end-to-end)

Two SQLite relays, both `KNOCK_KNOCK_MESH=1 KNOCK_KNOCK_DEBUG=1`, sharing a transport channel; A also
serves project H2 that B does not.

1. **Isolation:** B never folds H2 events from the shared transport channel — B's board shows only what
   B serves. (No cross-project pollution.)
2. **Offline recovery:** stop B; on A run a task in a channel B serves → coord lines post to transport
   while B is down. Start B → trace shows `replayed N … ingested M new`; B's board now matches A with no
   new live message. If the window saturated, B logs the loud coverage warning.
3. **Step-in/out:** a task created on A while B was down is claimable on B after replay, and both relays
   elect the **same** claimant slot (no double-claim), with age derived from `createdAt`.
4. **Backward-compat:** unset the `fetchRecent` dep / `history:false` adapter → behavior reverts to
   today's fire-and-forget; confirms the change is additive.
5. **Phase 0 evidence is recorded** before Phase 2 is built.
