---
date: 2026-06-14
topic: local-first-hosting-version-control
focus: Can we drop Supabase and become local-first? And how do four related papers (Local-First Software, Peritext, Denicek, Pijul/post-Git) reshape the path/anchor, the effect taxonomy, the merge algorithm, conflict resolution, and reversibility?
mode: repo-grounded
---

# Ideation: Local-first hosting + a paper-grounded rethink of the version-control layer

Two questions that turn out to be one. The user asked (a) whether knock-knock can drop its
Postgres/Supabase dependency and be genuinely *local-first*, and (b) how four named papers
should sharpen the version-control layer — the edit **path/anchor**, the **effect**
taxonomy, the **merge algorithm**, conflict resolution, and reversibility.

The deepest finding: **these are the same question.** The substrate (append-only,
content-addressed DAG + pure folds) is already the local-first / Merkle-CRDT shape the
literature converges on; Postgres is the one anti-local-first feature. But you can only drop
the central server if your merge is *commutative* (Pijul's thesis), and knock-knock's
role-ordered supersede layer is not — it mutates a `lifecycle` column order-sensitively,
which is precisely the cross-machine bug `CLAUDE.md` already flags. So "go local-first" and
"rethink the merge" are one program, sequenced below.

---

## Grounding Context

### Codebase context — the substrate and its seams

knock-knock is **ledger-native**: the only persisted thing is an append-only,
content-addressed DAG of immutable **Interactions**; every view is a pure **fold**.

- `ledger/interaction.ts` — `{actor, role, channel, target:{artifactId, anchor}, verb, patch, effect, caused_by[]}` + mutable bookkeeping (`lifecycle`, `supersedes`, `signature`, `createdAt`). `Anchor` is a union: `none | range{from,to} | crdt{rgaPos} | key{path} | proxy{proxyId}` — **`crdt` and `proxy` are declared but unused**. `Effect = 'pure' | 'workspace' | 'external'`. `frontier.rewind`/`turn.retry`/`frontier.checkpoint` and `external.compensate` verbs exist; `Patch.external.compensates?: Hash` exists. Several are **inert**.
- `ledger/canonical.ts` — `hashInteraction` = SHA-256 over the **immutable fields only**; `lifecycle`/`supersedes`/`signature` are deliberately excluded ("the hash names what the actor proposed, not what later happened to it").
- `ledger/merge.ts` — role-ordered gate. `ROLE_RANK` owner 3 > human 2 > agent 1. Higher role supersedes lower at the same anchor; equal-role concurrent → `conflict` held; **external effects bypass the gate entirely** (merge.ts:70-76). Cross-machine determinism via lower-hash tiebreak.
- `ledger/concurrency.ts` — `anchorMatches` is **strict equality** on `{from,to}` (line 28). Comment admits: range overlap is deferred, "worst case is missed conflicts" (lines 11-15).
- `ledger/admit.ts` — runs the gate, then **mutates** `lifecycle` via `store.updateLifecycle` and surfaces supersession to the loser's inbox (lines 96-108).
- `ledger/artifacts/versionable.ts` — Yjs CRDT for file edits. `WHOLE_FILE_ANCHOR = {range,0,0}` sentinel hack (line 110). `parseEditIntent` computes a structured `EditIntent` (line 113) that is **discarded** once the Y.update is built.
- `ledger/store.ts` / `store-sqlite.ts` / `store-pg.ts` — backend-agnostic `Store` interface (`kind: 'sqlite'|'postgres'`); `channelFrontier()` exists (store.ts:42). SQLite is in-process with synchronous fanout; Postgres uses `LISTEN/NOTIFY`. **NOTIFY fires on INSERT, not UPDATE** (store-pg.ts:359-361) → peer relays miss remote supersessions until restart; no backfill on listener disconnect (Neon scale-to-zero, store-pg.ts:183).
- `ledger/artifacts/external.ts` — `withClaim` serializes external effects by a **TTL lease** (default 30s); a holder that crashes after acting but before releasing → second relay re-acts (double-apply).
- `lib.ts` `resolveLedgerConfig` — backend chosen by `KNOCK_KNOCK_LEDGER_URL` env > settings.json > SQLite default.

### External context — the four named papers (primary grounding)

- **Local-First Software** (Kleppmann, Wiggins, van Hardenberg, McGranaghan — Onward! 2019, DOI 3359591.3359737). Seven ideals (no-spinners, not-trapped-on-one-device, network-optional, seamless-collab, the-Long-Now, security/privacy-by-default, ownership). **Servers are "cloud peers"** — store-and-forward relays, *not* authority; "CRDTs sync via any communication channel"; the **closed-laptop problem** needs one always-on relay. Open problems they admit: access control, schema migration, history bloat, version-history UX. knock-knock satisfies ideals 4 & 5 better than most; **Postgres violates ideals 1, 3, 6, 7.**
- **Peritext** (Litt, Lim, Kleppmann, van Hardenberg — CSCW 2022, DOI 3555644). Anchor formatting spans by **stable character IDs** (Yjs `RelativePosition`-equivalent `{type: before|after, opId}`), *not* byte offsets, so spans survive concurrent edits; tombstones keep anchors valid after deletion; `before`/`after` boundary discipline controls whether appended text joins a span; conflict = **interval overlap** resolved by **subdivision** into only-A/both/only-B; auto-merge (LWW) by default, surface conflict as future work.
- **Denicek** (Petricek & Edwards — UIST 2025, DOI 3746059.3747646). The closest published articulation of knock-knock's own thesis: the **edit log is the program**, document is a fold, and **three primitives — apply / merge / conflict-detect** — generate collaboration + PbD + incremental recompute + schema-evolution + provenance. **Effect-typed conflict**: StructureEffect/ValueEffect/TagEffect, conflict iff same-kind AND one target is a prefix of the other. **Rewind = fork-before / fix / merge-forward** (non-destructive); the **`retract`** dual ("e₂′ with the same effect as e₂ but orderable before e₁") is the principled "undo earlier, keep later." Merge is defined purely over edits (never over state), so edits cannot be conditional — conditions compile to concrete per-target edits. **Replay-via-merge** PbD survives structural drift.
- **Version control post-Git / Pijul** (Meunier — FOSDEM 2024). Merge as a **categorical pushout** (always exists; associative + commutative); "the pushout doesn't exist" ≡ "a conflict happened." Conflicts are **first-class graph states** ("zombies") resolved by ordinary cherry-pickable patches. **Commutativity is the precondition for dropping the central server.** **Order-independent multiset state digest** `e^(∏hᵢ)` (elliptic-curve, O(1) updatable, forge-resistant) = a one-value peer-agreement handshake. Sanakirja: forkable storage in O(log n).

### External landscape (2026 sync engines)

The "sync engine" market (Electric GA Mar 2025, Zero, PowerSync) has **converged on Postgres-as-source-of-truth + a read-path relay** — none replaces an event-log sync. The genuinely server-optional options are **cr-sqlite** (CRDT-in-SQLite, DIY transport, LWW today / causal-log v2 pending), **Automerge/automerge-repo**, **OrbitDB** (Merkle-CRDT OpLog over IPFS — the closest structural match, but IPFS-heavy), and **DXOS** (P2P mesh, "server only serves the app shell"). The honest blockers the whole field admits: **auth/access-control, schema migration, peer discovery/NAT, server cost**. Postgres `LISTEN/NOTIFY` itself: no backfill on reconnect, 8KB payload cap; the resilient pattern is "write to a table, NOTIFY only signals 'pull from your cursor'" (logical replication / CDC for durability).

### Past learnings

Repo has no `docs/solutions/` yet. From source rationale: the hash-order sort in `projectVersionable` is for cross-machine byte-identical determinism (Yjs converges regardless) — preserve it. Determinism rests on lower-hash tiebreaks in three places + `canonical.ts` stability. The `{0,0}` sentinel is a deliberate hack around strict-equality `anchorMatches`. A prior ideation (`2026-06-09-version-control-crdt-conflict-ideation.md`) explored the merge/conflict layer in depth (anchor-lattice, conflicts-as-pushout, lifecycle-as-fold, signed frontier, intent-witness, ocap authority); this run was a fresh re-run centered on the **hosting** axis and the four named papers, and several survivors here sharpen ideas from that doc with paper-specific evidence.

---

## Topic Axes

- **A. Hosting & sync topology** — drop Supabase; local-primary + thin relay vs P2P vs Merkle-DAG anti-entropy; closed-laptop problem; LISTEN/NOTIFY replacement.
- **B. Anchoring & the edit path** — byte-range → stable-ID spans; interval-overlap conflict detection; the `{0,0}` sentinel; what the edit records.
- **C. Merge algorithm & commutativity** — role-ordered merge vs pushout; commutativity as the server-less precondition; conflicts-as-objects; supersession representation.
- **D. Effect / action re-categorization** — `pure|workspace|external`; effect-kind + target-prefix conflict; reversibility vs kind; intent preservation.
- **E. History operations & UX** — rewind/retract/fork-fix-merge-forward; replay-via-merge; provenance; snapshots; reversibility of external effects.

---

## Ranked Ideas

> #2 and #3 are the net-simplifying first steps (each retires a hack). #1 depends on #3 being
> sound. #6 is the trust/snapshot backbone layered after #1. #4, #5, #7 ride the algebra.

### 1. Local-first by inversion — SQLite-primary + content-addressed anti-entropy; server demoted to optional "cloud peer"
**Description:** Invert the authority relationship. Each relay's **local SQLite is authoritative**; admits return immediately (no spinner, works offline). Cross-machine sync becomes **Git-style have/want over the content-addressed DAG**: a peer advertises its head hashes, the other walks `caused_by` back to a common frontier and ships exactly the delta — transport-agnostic (WebSocket mesh, libp2p, periodic HTTP, even `export(channel)→ndjson` on a USB stick). Postgres/Supabase is demoted to an *optional* dumb store-and-forward "cloud peer" that solves the closed-laptop problem, never the source of truth. The existing `Store.kind` seam (`sqlite|postgres`) absorbs a `p2p` backend; folds/merge/sync stay backend-agnostic.
**Axis:** A
**Basis:** `external:` Local-First (2019) "server as cloud peer; CRDTs sync over any channel; closed-laptop problem"; OrbitDB Merkle-CRDT OpLog; Git have/want; Merkle-CRDTs (Sanjuán 2020). `direct:` `canonical.ts` already content-addresses immutable fields; `store.ts` is a clean backend-agnostic interface; the documented NOTIFY-on-INSERT gap is a symptom of leaning on Postgres as orderer.
**Rationale:** The architecture is *already* local-first-shaped; the one property anti-entropy needs (content addressing + immutability) is already present. Dropping Postgres-as-authority reclaims 4 of Kleppmann's 7 ideals the design currently violates, and makes the SQLite backend a first-class cross-machine peer instead of a single-machine fallback.
**Downsides:** Closed-laptop case still wants one always-on relay; NAT traversal / peer discovery is the unglamorous hard part the whole field admits is unsolved; at-least-once delivery means external effects *will* be re-seen (needs #4's compensable typing); **soundness depends on #3** (a non-commutative supersede layer cannot drop the central orderer safely).
**Confidence:** 75%
**Complexity:** High
**Status:** Unexplored

### 2. Stable-ID span anchors + interval-overlap conflict — retire the `{0,0}` sentinel
**Description:** Replace the byte-range anchor and its strict-equality check with **Peritext-style spans anchored to stable Yjs `RelativePosition`s** (the reserved `Anchor.crdt` variant). Conflict becomes **interval overlap in stable-ID coordinates**, not equality. Whole-file edits become `startOfText→endOfText`, and the `{0,0}` sentinel disappears. Adopt Peritext's `before`/`after` boundary discipline (does an append at an edit's edge join it?), and **subdivide** overlaps into only-A / both / only-B so the non-overlapping parts of two edits both apply and only the contended sub-region escalates. If an endpoint no longer resolves (anchored char deleted), fail toward the conflict card, never silent drop.
**Axis:** B
**Basis:** `direct:` `concurrency.ts:11-28` strict equality + "worst case is missed conflicts"; `versionable.ts:110` sentinel ("a content-length-dependent `to` would never match"); `interaction.ts:30` reserved-but-unused `crdt` anchor. `external:` Peritext (2022) stable-ID anchoring, `before`/`after` boundaries, overlap-by-subdivision.
**Rationale:** Byte offsets are not stable under concurrent edits *and* the equality check requires them identical — so `[0,10]` vs `[5,15]` (a real overlap) silently both-apply (corruption), while disjoint whole-file edits falsely conflict (alarm fatigue). Stable-ID intervals fix both at once and confine conflicts to genuine overlap. Yjs already maintains the stable positions the anchor is currently throwing away.
**Downsides:** Resolving overlap needs the live `Y.Doc` (cost); transitive-overlap closure needs a defined policy; the interval coordinates must feed the existing hash-order determinism contract or cross-machine byte-identity breaks; precursor metric (a "shadow-conflict" counter) is worth shipping first to quantify how often the gap bites.
**Confidence:** 82%
**Complexity:** Medium-High
**Status:** Unexplored

### 3. Commutativity-organized merge — auto-merge when patches commute, reify conflicts as first-class foldable objects, derive supersession as a dominance fold (delete the mutable `lifecycle` column)
**Description:** Three moves that are one. **(a)** Auto-merge when two patches commute — Denicek's over-approximation suppression: if both merge orders converge to the same projection, don't raise a card. **(b)** When they don't commute, materialize the conflict as a **first-class foldable object** (Pijul "zombie") with its own lifecycle the fold keys on — not a transient `proposed` hold awaiting human rescue. **(c)** Stop *mutating* `lifecycle`: compute "is this superseded/denied?" as a **pure dominance fold** over `{role, anchor, caused_by, hash}`; supersession becomes an appended `merge.supersede`/`merge.resolve` **INSERT**, not an in-place UPDATE. Role stays — as *priority on the resolution*, not pre-merge deletion. (c) is the keystone: the cross-machine UPDATE-propagation gap **vanishes by construction** (there is nothing to propagate; the existing INSERT-trigger / #1's anti-entropy carries it), and the "everything is a fold" claim stops being false.
**Axis:** C
**Basis:** `direct:` `admit.ts:96-108` (mutates lifecycle + side-effects); `canonical.ts:9-11` (lifecycle excluded from hash → two relays can verifyHash and still disagree on applied/superseded, undetectably); `merge.ts:105` (every equal-role peer → conflict, regardless of whether outcomes diverge). `external:` Pijul pushout / commutativity / conflicts-as-objects; Denicek over-approximation suppression; Peritext auto-merge default.
**Rationale:** This is the single place the architecture contradicts its own thesis, and it is the root of the documented cross-machine bug *and* the blocker to dropping the central orderer (#1). One reframe restores purity, fixes a correctness gap by construction, and removes the friction of cards for non-decisions (most concurrent edits commute).
**Downsides:** Moving the supersede→inbox side-effects out of `admit` is nontrivial; recomputing dominance per fold step needs indexing; "role-priority on a pushout cocone" is novel and its confluence/associativity is **unproven** — must be established before trusting cross-machine; reifying conflicts changes the projection contract every fold depends on.
**Confidence:** 76%
**Complexity:** High
**Status:** Explored

### 4. Re-axis "effect" — split reversibility × kind; effect-typed conflict; auto-classify from observed behavior; a `compensable` external sub-type
**Description:** `effect: pure|workspace|external` conflates three orthogonal questions onto one field: *reversible? mergeable? world-touching?* Split into a **reversibility flag** (drives whether the merge gate can supersede) and an **effect-kind tag** (Denicek's Structure/Value/Tag) where **conflict = same effect-kind AND one target is a prefix of the other** — so two agents adding *different* fields to a file don't conflict, but two structural renames of the same node do. Derive the effect from **what the tool actually did** (touched workspace dir? opened a socket?) instead of trusting the agent's self-reported `ToolKind` — extending the deny-floor's existing "distrust agent labels" stance to effect typing. Make the dormant `compensates`/`external.compensate` load-bearing: split `external` into `external-idempotent` (safe to replay under anti-entropy) vs `external-compensable` (needs its inverse first).
**Axis:** D
**Basis:** `direct:` `merge.ts:70-76` (all external bypass identically); `interaction.ts:23` (flat 3-way effect); `interaction.ts:50,96` (`external.compensate` verb + `compensates` field both inert); `CLAUDE.md` deny-floor checks `denyLiteralHit` first, "regardless of the ToolKind the agent labels it." `external:` Denicek effect-typed conflict (kind + target-prefix).
**Rationale:** Effect type decides whether an op hits or bypasses the merge gate — so a mislabeled effect is a correctness/security hole, and `external` currently means *irreversible* AND *unmergeable* AND *world-touching* at once. Untangling these makes conflict detection sharper (a structural rename vs a value edit aren't a conflict) and is the precondition that makes serverless sync (#1) safe for side effects, not just pure folds.
**Downsides:** Observed-behavior classification needs a sandbox/syscall signal the system doesn't yet have for the in-process SDK adapter; effect-kind conflict is a heuristic that can over- or under-fire; touches the gate's hot path.
**Confidence:** 68%
**Complexity:** Medium-High
**Status:** Unexplored

### 5. Intent-witness — keep the `EditIntent`, detect interleaving anomalies, arbitrate instead of silently corrupting
**Description:** The capture path computes a structured `EditIntent`, builds the Y.update, then discards the intent — the ledger keeps only an opaque base64 Y.update. But Yjs converges to *a* string, not the *intended* one: two agents inserting at the same point can produce syntactically-merged, semantically-garbage code with **no conflict signal** (a broken build is the only symptom). Persist the `EditIntent` (+ an expected post-state hash) alongside the ops; when the merged text violates a contributor's declared intent, **demote the merge to a held conflict** the role gate can arbitrate. Turns a fundamentally-unpreventable CRDT anomaly into a *detectable* one, and gives every future diff/provenance view a structured witness.
**Axis:** B
**Basis:** `direct:` `versionable.ts:113` (the `EditIntent` is parsed then thrown away once the Y.update is built; patch carries only `ops: string`). `external:` Weidner & Kleppmann 2023 (interleaving is fundamental to position-based CRDTs; FugueMax only minimizes it); Denicek provenance-via-retained-pre-state.
**Rationale:** Directly answers the deepest critique — convergence is the *wrong goal* for multi-agent code, where silent garbled merges cause downstream build failures with no signal. Detection is the only available defense (prevention is impossible) and is nearly free: the witness is already computed and discarded.
**Downsides:** Inflates patch payloads; "did the merge preserve intent?" is itself a heuristic that can over-conflict; only works for runtimes that surface a structured `EditIntent` (claude-sdk), not arbitrary ACP agents whose edit formats are already deferred.
**Confidence:** 67%
**Complexity:** Medium
**Status:** Unexplored

### 6. The signed, named **frontier** as the one history object + an order-independent scope digest
**Description:** Promote the ephemeral `channelFrontier()` into a first-class `Frontier{name, tipHashSet, role, signature, scope}`. One object then simultaneously is: a **snapshot boundary** (fold resumes from it → bounded replay, kills O(genesis) restart cost), a **branch/checkpoint/undo ref** (the dangling `frontier.checkpoint`/`frontier.rewind` verbs finally have a referent), a **Byzantine commitment** (it signs the `lifecycle` the per-interaction hash deliberately excludes → cross-machine divergence becomes *detectable*, roles stop being forgeable), and an **anti-entropy watermark** (advertise on reconnect, diff, pull the missing causal closure → #1's sync self-heals). Pair it with **Pijul's order-independent multiset digest** `e^(∏hᵢ)` (or a simpler XOR/Merkle accumulator given content-addressing is in place) — an O(1) value two relays compare to confirm "we agree on this scope" with no replay.
**Axis:** A
**Basis:** `direct:` `store.ts:42` (`channelFrontier` already computed, ephemeral); `interaction.ts:56-60` (frontier verbs declared with no backing object); `canonical.ts:9-11` (lifecycle excluded from hash → divergence in *what got superseded* is currently undetectable). `external:` Pijul EC state digest; Merkle-CRDTs (frontier = traversal); Certificate Transparency signed tree heads + consistency/inclusion proofs; eg-walker (frontier + transient reconstruction).
**Rationale:** One object collapses four roadmap items (snapshots, branching/undo, Byzantine detection, self-healing sync) into a single investment whose verbs are already written and currently dangle. It is the cryptographic backbone that makes #1 *safe* once machines you don't control share the DAG — without it, role is just a string an actor wrote.
**Downsides:** Needs a PKI/identity layer the system lacks (roles map to Discord ids today); frontier-subset detection + cache-eviction cost; partial-undo-via-exclusion interacts badly with CRDT causal-delivery assumptions; likely the *last* piece to build, after #1 and #3.
**Confidence:** 70%
**Complexity:** High
**Status:** Unexplored

### 7. History operations made real — rewind = fork-fix-merge-forward, `retract`, compensating entries for external undo, replay-via-merge macros
**Description:** Today ⏪/🧷 are recorded purely for the audit trail and explicitly *not* wired into resume. Make them real, non-destructively. Model **rewind as Denicek's fork-before / fix / merge-forward** (later work is *replayed* on top of the correction, never lost). Implement Denicek's **`retract`** dual to make "undo an *earlier* action while keeping later ones" sound. Because you cannot un-send a Discord message or un-run `rm`, borrow **double-entry accounting's compensating entry**: rewinding past an `external` effect appends a *reversing* effect (the inert `external.compensate` verb's purpose), never a deletion. Finally, **replay-via-merge**: select a span of the agent log, name it, replay it in another scope by merging from the recorded tip-hash — a macro that survives structural drift (Denicek PbD over the agent log).
**Axis:** E
**Basis:** `direct:` `retry-on-reaction.ts:11-13` ("⏪/🧷 are recorded for the audit trail; wiring them into frontier-resume is the next step and intentionally not done here"); `interaction.ts:50,96` (`external.compensate` + `compensates` inert). `external:` Denicek fork-fix-merge-forward + `retract` dual + replay-via-merge PbD; double-entry bookkeeping reversing entries.
**Rationale:** A rewind button that silently no-ops is worse than none — it teaches users the affordance is a lie. Modeling reversal as forward, non-destructive entries keeps append-only intact while making undo sound *for side effects too* (which the current frontier-only model silently isn't), and replay-via-merge turns the audit log into an executable one.
**Downsides:** Partial-undo-via-exclusion interacts badly with CRDT causal-delivery (undo in CRDTs is a genuine open problem) — scope carefully; compensating-entry UX is new; replay-via-merge depends on #2's stable anchors and #3's algebra to re-anchor on drift.
**Confidence:** 64%
**Complexity:** Medium-High
**Status:** Unexplored

---

## Rejection Summary

| # | Idea | Reason rejected / absorbed |
|---|------|-----------------|
| 1 | Idempotency keys + ZooKeeper fencing tokens (external double-apply) | Real gap (TTL-lease race), but standard distributed-systems patterns, not a novel contribution; absorbed into **#4**'s `compensable` typing + **#1**'s at-least-once handling. |
| 2 | HLC / light-cone constant-time concurrency (replace maxDepth-64 ancestor walk) | Optimization of a safe-direction cost; lower value than survivors; can ride **#6**'s frontier index. |
| 3 | Per-artifact causal slices; forkable store (Sanakirja/cr-sqlite); zero-relay edge fold; sneakernet export/import | All facets of **#1**'s topology spectrum; absorbed rather than listed separately. |
| 4 | Role as signed scoped capability; Certificate Transparency tree heads; sign-every-interaction-and-verify-at-admit | The authority/Byzantine backbone is **#6** (the signed frontier); presenting separately would inflate the list with one decision. |
| 5 | Conflict-blindness telemetry (shadow-conflict counter) | Valuable as a *de-risking precursor* to **#2/#3** (quantify how often the silent-corruption gap actually fires); noted in #2's downsides, not a standalone survivor. |
| 6 | Owner-never-online arbiter policy (pre-committed resolution rules) | A brainstorm variant of **#3**'s resolution layer, not a separate near-term contribution. |
| 7 | Time-travel `fold-at(hash)` / `fold-between` as a UX verb | The read-side payoff of **#6**'s snapshots + **#7**'s parameterized folds; absorbed. |
| 8 | Auto-classify effect from observed side-effects (as standalone) | Absorbed into **#4** as one of its legs. |

**Axis coverage:** all five carry a survivor — A (#1, #6), B (#2, #5), C (#3), D (#4), E (#6, #7). No deliberate gaps.

---

*Generated by `/ce-ideate` (fresh re-run; complements the 2026-06-09 merge/conflict ideation with a hosting axis and four named papers as primary grounding). Next step: `/ce-brainstorm` on a chosen idea. Natural seeds — #3 (lifecycle-as-fold, the keystone that unlocks #1), #2 (stable-ID anchors, the net-simplifying first step), or #1 (the local-first hosting question the user led with).*
