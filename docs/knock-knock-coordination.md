# Coordination — multi-agent turn-taking, awareness, and task allocation

A design note for the **coordination layer**: how multiple agents — co-resident on
one machine or federated cross-machine over a shared Postgres ledger — stop talking
over each other, share what they're doing, and divide work, **without a server**.

> **Convention** (as in `knock-knock-ledger-model.md`): sections marked **Shipping
> in the skeleton** are what the first cut builds; **Designed, not yet shipped** is
> the fuller vision it grows into.

The plan that produced this layer is
`docs/plans/2026-06-25-001-feat-ledger-native-agent-coordination-plan.md`.

---

## 1. The gap

Removing the central server left coordination to the append-only ledger alone. Four
gaps appeared:

- **(A) No turn-taking.** Each `AgentHost` decides to reply independently, so two
  bots both answer one message ("Got it" twice). The loop-guard caps *consecutive*
  agent turns (depth); it does nothing about *two agents answering one message*
  (breadth).
- **(B) No shared awareness.** No agent can see what the others are doing or what a
  thread is about, so they re-derive it by knocking.
- **(C) No task allocation.** "Set up 5 subagent tasks" has no notion of who-first /
  who-next / who-owns-what.
- **(D) No topology abstraction.** Different teams want different collaboration
  shapes; one hard-coded answer fits only some.

**The dominant constraint:** cross-machine state propagates only via Postgres
`LISTEN/NOTIFY`, which fires on **INSERT, never UPDATE**. So every coordination
decision is expressed as a new immutable interaction and *derived*, never as a
mutated lifecycle column. Contention resolves through the `external_claim` table,
whose atomicity is the database row lock — **not** NOTIFY — so exactly-one holds
even under replication skew.

---

## 2. Mechanism vs. policy (the keystone)

The primitives are pattern-agnostic **mechanism**; the collaboration topology is
pure **policy** selected per-room/per-thread through the existing `config` fold
(`!config`). The same claim/fold/board/scheduler carries every pattern.

| Pattern | `responder` | `allocation` | Feels like |
|---|---|---|---|
| **Peer / co-equal** (default) | `race` | `pull-claim` | whoever grabs it first |
| **Orchestrator–worker** | `designated` | `push-assign` | one lead fields + assigns |
| **Pipeline / handoff** | `designated`/`role-priority` | `pull-claim` | DAG unlocks in order |
| **Contract-net / market** | `race` | `bid` | best bid wins |

Switching topology is a config value; mechanism code is unchanged. Defaults
(`race` + `pull-claim`) reproduce decentralized peers, so a room that sets nothing
behaves as before.

Pure decision logic lives in `lib.ts` (unit-tested in `tests/lib.test.ts`):
`ResponderPolicy`/`preferredResponderDelayMs`, `AllocationPolicy`/`claimantFor`,
`winningBid`/`scoreBid`, `projectTaskDag`/`readyTasks`, `projectCoordinationBoard`,
`selectRelatedContext`.

---

## 3. Turn-taking — exactly one agent replies (A) · Shipping in the skeleton

`reply-claim` (`ledger/synchronizations/reply-claim.ts`) replaces the old
`prompt-on-message`. On an admitted `channel.message` it composes two claims:

1. **reply election** — `replyClaimKey(channel, msgId)` held by **agentKey**, so
   distinct eligible agents contend to a single winner.
2. **drive election** — `driveClaimKey(channel, agentKey, msgId)` held by
   **relayId**, so the same agent on multiple relays is driven exactly once.

Claim keys use the **shared platform message id** (`IncomingMessage.ref.id`), never
the per-host interaction hash (each host stamps a distinct `targetAgent`, so the
hashes differ). The loop-guard gate is kept (on the original message role). The
`ResponderPolicy` biases *who* wins via a short start delay (`designated` /
`role-priority` step aside for the preferred agent), degrading to a plain race if
the preferred agent is silent — the claim guarantees exactly-one regardless.

Addressing is **platform-neutral** (R11): it reads the `MessagingAdapter` seam
(`mentionsBot` / `replyToMessageId` / `Capabilities.mentions`), never `<@id>` text.

---

## 4. Shared awareness — the coordination board (B) · Shipping in the skeleton

A per-scope board on its own fold (`ledger/concepts/coordination-board.ts`), keyed
`coord:channel/<scopeId>`, append-only, anchor `none` (knowledge-fold conventions).
`coord.note` interactions record **presence** (what an agent is doing) and
**designation** (who has taken a message). `capture-presence` derives presence from
`turn.prompted`→working / `turn.replied`→done — runtime-neutral (R13), keyed on
turn verbs common to every adapter, never a Claude-specific shape. `reply-claim`'s
winner posts a designation so peers don't re-knock.

The board is delivered into each turn as a once-only `<coordination>` prefix
(`pickFreshCoordination`, excluding self), prepended in `Driver.buildPrompt`. On
separate-store SQLite there is no shared state, so an agent simply sees only local
peers — correct degradation, no duplicate channel posts.

---

## 5. Task allocation (C) · Shipping in the skeleton

A per-scope task DAG (`ledger/concepts/task-dag.ts`), keyed `task:channel/<scopeId>`,
folded from `task.created` / `task.bid` / `task.claimed` / `task.completed`. The
projection derives **op-derived status only** (`open`/`claimed`/`done`); claim
*liveness* (a lapsed `external_claim`) is the scheduler's concern, never folded in.
`readyTasks` derives the dependency frontier ("who's next") with no scheduler, so
every replica agrees.

```
open --> ready (deps done, derived) --> [bid window] --> claimed --> done
                                   ^                         |
                                   +---- claim lapsed --------+  (failover)
```

Owner `!delegate` (owner-only short-circuit, prompt-injection-safe) seeds tasks:
`id: label [after deps] [@assignee]`, with cycles rejected at parse time.

`task-scheduler` (`ledger/synchronizations/task-scheduler.ts`) allocates ready
tasks under the `AllocationPolicy`, composing the same two-claim pattern
(`taskClaimKey` holder=agentKey, `taskDriveKey` holder=relayId), then admits
`task.claimed` + a `turn.prompted` wake. **Failover**: claim renewal is gated on
`host.isTurnLive`, so a crashed/ended owner stops renewing; a half-TTL **reconcile
tick** in `relay.ts` re-takes the lapsed claim even when no new event arrives (the
watches §7 lesson). Reassignment rides immutable INSERTs (a new `task.claimed`), so
it converges cross-machine with no lifecycle UPDATE.

**Contract-net** (`allocation=bid`): agents submit a `task.bid` (deterministic
`scoreBid` utility) on sight; claiming defers to the reconcile pass (the bid
window), where `winningBid` (highest utility, deterministic tiebreak) claims via the
same claim. A no-bid task falls back to pull, so bidding never strands work.

---

## 6. Cross-thread retrieval (D / R8) · Shipping in the skeleton

`selectRelatedContext` scores candidate messages from *other* threads by three
signals (recency + `caused_by`/reply lineage + keyword/participant overlap) over a
**pre-bounded** candidate set (a lookback window applied before scoring — never a
full-log scan). The host injects a once-only `<related-context>` block from a
bounded window of sibling-thread messages. Embedding-based relevance is **designed,
not yet shipped**, behind the same `scoreRelatedInteraction` seam.

---

## 7. Cross-machine reach

| | SQLite (same machine) | Postgres (cross-machine) |
|---|---|---|
| claim contention | process-local (one store) | cluster-wide atomic (row lock) |
| board / task convergence | in-process | INSERT + NOTIFY replication |
| coordination across machines | **no** (separate stores share nothing) | **yes** |

All coordination is INSERT-derived and claim-arbitrated, so it converges from the
operations alone. The ship gate is the property battery
`tests/ledger/coordination-cross-machine.test.ts` plus the per-pattern integration
`tests/ledger/coordination-policies.test.ts`.

---

## 8. Designed, not yet shipped

- Capability-aware / learned bid scoring (v1 `scoreBid` is deterministic pseudo-utility; ST-SR-IA class).
- Agent-initiated task proposal (v1 seeds via owner `!delegate` only).
- Embedding relevance for retrieval.
- Finer stall detection (progress heartbeat) — v1 fails over on crash/turn-end via active-turn liveness.
- Loop-guard fold exemption for scheduler/reply-synthesized turns (shared with the watches follow-up).
- A second messaging platform adapter — the layer is platform-*neutral*, but Discord is the only live surface today.
