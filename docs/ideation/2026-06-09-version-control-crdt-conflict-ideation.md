---
date: 2026-06-09
topic: version-control-crdt-conflict
focus: how the CRDT/version-control/conflict layer works, its tradeoffs and loopholes, and a novel cohesive algorithm/data-structure contribution
mode: repo-grounded
---

# Ideation: The version-control / CRDT / conflict layer — walkthrough, critique, and a cohesive redesign

This document does three things, in order:

1. **Walks through what exists today** with small worked examples — how commands are reified, how artifact versions are hashed, how edits become a CRDT, and how conflicts are arbitrated.
2. **Critically analyzes** whether the design is generalizable and robust — the loopholes, with severity.
3. **Proposes a cohesive redesign** that is a genuine algorithm + data-structure contribution, plus the ranked component ideas it is built from.

---

## Grounding Context

### Codebase context — the substrate

knock-knock is **ledger-native**: the only persisted thing is an append-only, content-addressed DAG of **Interactions**. Every artifact version — a file's text, what an agent knows, a side effect — is a **fold** (pure projection) over the log, never stored state. The relevant files:

- `ledger/interaction.ts` — the one persisted shape: `{actor, role, channel, target:{artifactId, anchor}, verb, patch, effect, caused_by[]}` + mutable bookkeeping (`lifecycle`, `supersedes`, `deniedReason`, `signature`, `createdAt`).
- `ledger/canonical.ts` — `hashInteraction`: SHA-256 over canonical JSON of the **immutable fields only**.
- `ledger/artifacts/versionable.ts` — the Yjs-backed CRDT for file/text edits.
- `ledger/merge.ts` + `ledger/admit.ts` + `ledger/concurrency.ts` — the role-ordered merge gate.
- `ledger/store-*.ts` — SQLite / Postgres backends; Postgres shares the DAG cross-machine via `LISTEN/NOTIFY`.

### External context — the literature this design sits in

- **CRDT text algorithms** (YATA/Yjs, RGA, Logoot, Fugue/FugueMax — Weidner & Kleppmann 2023) all share one guarantee (Strong Eventual Consistency = *convergence*) and one shared weakness: **convergence ≠ the intended value**. Every surveyed algorithm exhibits *interleaving anomalies*; tombstone/metadata grows O(edit-history), not O(doc-size) (josephg, "CRDTs go brrr").
- **eg-walker** (Gentle & Kleppmann, EuroSys 2025): models editing as a *causal DAG of operations* (git at keystroke granularity), discards CRDT metadata in steady state and reconstructs it transiently at merge — 1-2 orders of magnitude less memory. **knock-knock is structurally eg-walker, one level up, at Interaction granularity.**
- **Pijul / categorical patch theory** (Mimram & Di Giusto 2013): patches are morphisms, merge is a **pushout**, and *conflicts are first-class objects*. Git content-addresses *snapshots*; Pijul (and knock-knock) content-address *operations* — the precondition Pijul needs that git lacks.
- **Matrix state resolution v2** + **ERA** (2025, "duelling admins"): authority-weighted merge over a hash-DAG (power levels, hash tiebreak) — structurally identical to the role-ordered gate, production-validated, but with known divergence bugs under rapid membership churn.
- **Kleppmann BFT-CRDT** (PaPoC 2022) + **Blocklace** (2024): sign ops + hash-chain to causal parents → tamper-evident Byzantine *detection*. Excluding mutable fields from the hash is the exact gap they patch. **Byzantine Eventual Consistency is impossible** without a trusted coordinator (Kleppmann & Howard 2020) — detection is the ceiling.
- **Merkle-CRDTs** (Psaras 2020): Merkle-DAG ancestry replaces vector clocks; the frontier becomes a traversal. knock-knock already does this.
- **Event sourcing**: replay determinism requires purity; projection rebuild → snapshots; event-schema versioning is the hard part (Datomic reified transactions; excision for GDPR).

### Past learnings (from source rationale; repo has no `docs/solutions/` yet)

- The hash-order sort in `projectVersionable` exists for **cross-machine byte-identical determinism**, not for convergence (Yjs converges regardless). Preserve it if you change projection.
- The whole-file sentinel anchor `{range,0,0}` is a deliberate hack: `anchorMatches` is strict equality, so a content-length-dependent `to` would never match and concurrent edits would silently both-apply. The sentinel forces contention.
- Determinism rests on a lower-hash tiebreak in three places (merge peers/branches, projection order, conflict-card letters) and on `canonical.ts` stability (sorted keys; `caused_by` sorted+deduped; `NaN`/`Infinity` throw). Touch one, re-verify all.
- Don't reach for version vectors to fix range overlap — that's an *anchor-semantics* problem, not an ordering problem.

---

## Topic Axes

- **A. Operation reification & content-addressed identity** — what becomes an Interaction; in/out of the hash; signatures; dedup; artifact-version identity.
- **B. CRDT merge & anchoring** — the Yjs layer; whole-file vs fine-grained anchors; interleaving; tombstones; range-overlap detection.
- **C. Authority-ordered arbitration** — the role gate on top of the CRDT; conflict holds; supersession; resolution; per-actor authority.
- **D. Cross-machine convergence & failure modes** — the determinism contract; LISTEN/NOTIFY gaps; claim TTL; fold re-notify; replay cost; Byzantine.
- **E. Semantic correctness & history operations** — converge-to-intended; rewind/undo/checkpoint; staleness cascade; patch algebra for non-text artifacts.

---

## Part 1 — Current state, walked through with small examples

### 1.1 How a command is reified

Every action is an immutable Interaction. When an agent edits `foo.ts`, the edit becomes **two** interactions and then a third:

```
tool.requested   patch.intent = { op:'edit', args:{ file_path:'foo.ts',
                                   old_string:'a', new_string:'b' } }   effect: external
   │  (the SDK actually runs the edit)
   ▼
tool.executed    patch.result = { ok:true, ... }                       effect: external
   │  capture-workspace-edit correlates executed→requested (caused_by[0]),
   │  parses the EditIntent, builds a Yjs update against a live Y.Doc
   ▼
workspace.edit   patch = { kind:'versionable', ops:'<base64 Y.update>' }  effect: workspace
                 target = { artifactId:'vers:<scope>/foo.ts',
                            anchor:{ kind:'range', from:0, to:0 } }
                 caused_by = [ tool.executed.hash, ...current applied edit hashes ]
```

The `workspace.edit` is the version-control record. Note the design choice that the **CRDT operation is derived from the tool call, not from a diff of the file** — capture replays the parsed `EditIntent` against a per-artifact live `Y.Doc` and re-encodes a whole-file replace (`text.delete(0,len); text.insert(0,newText)`).

### 1.2 How an artifact version is hashed

`hashInteraction` (canonical.ts:46-63) hashes **only** the immutable subset:

```js
hashInput = { actor, role, channel, target, verb, patch, effect,
              caused_by: dedup(sort(caused_by)) }
hash = sha256( canonicalJson(hashInput) )   // sorted keys, no whitespace
```

`lifecycle`, `supersedes`, `deniedReason`, `signature`, `createdAt` are **excluded** — "the hash names what the actor *proposed*, not what later happened to it." Two actors that independently produce the same proposal get the same hash; the store dedups on it (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`). **The version of an artifact is not itself hashed** — there is no Merkle root over the projected text. The artifact "version" is the *set of edit-interaction hashes folded so far*; identity lives at the operation level, never the state level.

### 1.3 How edits merge (the CRDT)

`projectVersionable` builds a fresh `Y.Doc`, applies every admitted `workspace.edit`'s Y.update in **hash order**, and reads `doc.getText('content')`. Yjs `applyUpdate` is a CRDT merge, so the *final text is order-independent*; the hash-order sort only guarantees two machines compute byte-identical intermediate states.

**Example A — sequential edits, no conflict.** Agent edits, then edits again:

```
E1: workspace.edit  caused_by=[...]           → applied
E2: workspace.edit  caused_by=[E1.hash, ...]  → E1 is an ancestor of E2
```

`findConcurrentAtAnchor` sees E1 is an ancestor of E2 ⇒ not concurrent ⇒ E2 admits straight. Projection applies E1 then E2 → merged text. Clean.

**Example B — concurrent equal-role edits, conflict.** Agent A and Agent B both edit `foo.ts` from the same base (neither's `caused_by` contains the other):

```
A: workspace.edit  anchor={range,0,0}  role=agent  → applied
B: workspace.edit  anchor={range,0,0}  role=agent  → mergeProposal(B, [A])
                                                      same anchor, equal role
                                                    → CONFLICT, branches=sort([A,B])
                                                      B.lifecycle = 'proposed'
```

`versionableFold.key` admits only `lifecycle ∈ {admitted, applied}`, so the projection shows **only A's text**. The relay posts a **conflict card** (🅰/🅱 hash-sorted, so two machines render identical letters). The owner clicks 🅱 → an **owner-role `merge.resolve`** is admitted that supersedes A; A flips to `superseded`, B flips to `applied`; the projection converges to B on every machine. Nothing is deleted — A stays in the log, and a note lands on A's author's inbox.

**Example C — role override.** An owner edits while the agent's edit holds the anchor:

```
agent: workspace.edit  role=agent  → applied
owner: workspace.edit  role=owner  → mergeProposal(owner, [agent])
                                      owner(3) > agent(1)
                                    → ADMIT, supersede=[agent]
```

The agent's edit is superseded immediately (no card), and `dm-on-supersede` DMs the agent's owner.

### 1.4 How history operations work

Rewind (⏪), retry (🔁), and checkpoint (🧷) are just interactions (`frontier.rewind`, `turn.retry`, `frontier.checkpoint`) recorded against the frontier. "Nothing is deleted — only superseded" makes the log a version-control system: every losing draft and retracted note stays, with a `superseded` lifecycle.

### 1.5 The honest scope

This is a **walking skeleton**: whole-file replace/append against one sentinel anchor; capture is reliable only for Claude-Code-shaped Edit/Write tools; folds don't re-notify on supersession; signatures and snapshots are deferred. The algorithm is proven by tests; the integration is partial.

---

## Part 2 — Critical analysis: is it generalizable and robust?

The architecture is unusually principled — content-addressed operations, pure folds, deterministic cross-machine arbitration. But it has a **coherent set of loopholes that all trace to three roots**: (i) anchors are scalars, not regions; (ii) lifecycle is the one mutable column that escaped the fold discipline; (iii) the hash certifies *proposals* but nothing certifies *outcomes*.

### Loophole 1 — Range-overlap blindness (the central gap) · severity: HIGH · axis B

`anchorMatches` is **strict equality** on `{from,to}` (concurrency.ts:21-43). The whole-file sentinel `{0,0}` papers over this with a hack that is *both too loose and too tight*:

- **Too tight (false conflict):** every whole-file edit shares `{0,0}`, so two agents editing **non-overlapping** regions of the same file are forced into a conflict card the merge gate never needed.
- **Too loose (false convergence, the dangerous one):** the moment fine-grained ranges are introduced with strict equality, an edit at `[0,10]` and one at `[5,15]` **don't match**, so both silently apply with no conflict — the projection is a corrupted interleaving of two overlapping intents. concurrency.ts:13 admits it: *"The worst case is missed conflicts, never false ones"* — but missed conflicts on overlapping ranges are exactly value corruption.

This is the load-bearing limitation. Fine-grained convergence is impossible without replacing equality with **interval overlap**, and the literature (Peritext) says the overlap must be computed in *stable-ID coordinates*, not byte offsets, because the CRDT renumbers positions under concurrent edits.

### Loophole 2 — Lifecycle is mutable state outside the hash · severity: HIGH · axes A, D

`lifecycle` is the only per-row field that is mutated in place (`store.updateLifecycle`) and is excluded from the hash. This single choice spawns three distinct bugs:

- **Fold re-notify gap** (admit.ts:96-98): supersession does **not** re-notify live fold subscribers. A subscriber that already folded the loser keeps showing it as active. *Replay-correct, live-stale* — the store tells the truth, the running projection drifts until the next insert or a restart.
- **Byzantine hash gap** (Kleppmann BFT-CRDT): two relays can `verifyHash(i) == true` on the same interaction while one calls it `applied` and the other `superseded`. Convergence of the hash DAG does **not** imply convergence of effective state. Nothing detects the disagreement.
- **Forgeable authority:** `role` is snapshotted onto the interaction and **unsigned**. A malicious relay sharing the Postgres DAG can author an interaction claiming `role:'owner'` and the gate will believe it.

The architecture's headline claim is "everything is a fold over the immutable log." Lifecycle is the place that claim is *false*, and every bug above is downstream of that.

### Loophole 3 — Convergence is not correctness · severity: MEDIUM-HIGH · axis E

Even with the CRDT working perfectly, Yjs guarantees a *single* converged string, not the *intended* one. Two agents inserting at the same position interleave deterministically-but-garbled (Fugue's interleaving result: *every* surveyed algorithm has this). In a multi-agent coding system the failure is silent: the file converges to text neither agent wrote, no conflict fires, and the only signal is a broken build later. The system discards the parsed `EditIntent` the instant it builds the Y.update — it throws away the one artifact that could *detect* the anomaly.

### Loophole 4 — External effects can double-apply · severity: MEDIUM · axis D

External effects (Discord posts, shell) **bypass** the merge gate (two posts can both have realized) and are serialized only by `external_claim`'s TTL lease. A holder that crashes between acquire and release leaves a lease that expires; a second relay acquires and re-realizes the effect → **two identical Discord posts**. A TTL lease fundamentally cannot distinguish "holder died before acting" from "holder acted, then died."

### Loophole 5 — No backfill on LISTEN/NOTIFY disconnect · severity: MEDIUM · axis D

`LISTEN/NOTIFY` is best-effort pub/sub. Writes that land during a listener disconnect (e.g. Neon scale-to-zero) are **never replayed** — they're in the DB, but no notification fires, and there is no anti-entropy round on reconnect. Result: silent cross-machine divergence *until a relay restart*. The system has every primitive needed to self-heal (content-addressed ancestry) but doesn't wire it into reconnect.

### Loophole 6 — Unbounded replay · severity: MEDIUM (latent) · axis D

Folds rebuild from genesis: O(all-time interactions). The log grows monotonically and there is no snapshot mechanism, even though `frontier.checkpoint` exists as a reserved verb. For a long-lived channel this is a guaranteed scaling wall.

### Lower-severity / safe-direction

- **maxDepth-64 ancestor walk** returns false past depth 64 → treats a long *sequential* chain as concurrent (an extra conflict; safe direction, but UX noise and unbounded cost as histories grow).
- **TOCTOU in capture** (read `versionableEditHashes` then admit) → can mislabel sequential as concurrent (benign by design).
- **Cross-verb staleness** stops at the artifact boundary: invalidating a knowledge note does *not* taint a downstream `tool.executed` that consumed it.

### Verdict on generalizability

The **substrate** generalizes beautifully — content-addressed operation DAG + pure folds is the right foundation, and it is independently the eg-walker and Merkle-CRDT architecture. The **conflict layer does not yet generalize**: it is hardcoded to Yjs text, scalar anchors, a flat 3-level honest-participant authority model, and a mutable lifecycle column. The redesign below makes the conflict layer as principled as the substrate it sits on.

---

## Part 3 — Ranked ideas

> Idea 1 is the cohesive contribution the brief asked for; ideas 2-7 are the components it composes (each independently shippable and independently valuable).

### 1. The cohesive contribution — *an anchored patch-category over a signed frontier*

**Description:** Recast the whole conflict layer as one coherent algebraic object built from four interlocking pieces, replacing four bespoke mechanisms:

1. **Anchors become a lattice, not scalars (the merge *domain*).** Every anchor (`range`, `key`, `crdt`, `proxy`, `none`) is a *region* in a coordinate space and "conflict" is `region∩region ≠ ∅` — one `anchorOverlaps` meet replaces strict-equality `anchorMatches`. `range` overlaps by interval intersection in stable Yjs-position coordinates; `key` by path-prefix containment (so `know:x/p` overlaps `know:x/p/*`); `none` is bottom (never overlaps); a new `whole` is top. The whole-file sentinel disappears.
2. **Merge becomes a pushout with role as priority (the merge *operation*).** Two concurrent patches from a common base (recoverable from `caused_by`) merge as a categorical pushout (Pijul). A genuine conflict is **reified as a first-class artifact object** with its own anchor and lifecycle — not a `lifecycle:'proposed'` flag. The role order (owner>human>agent) is not a pre-merge filter that *deletes* the loser; it is a **priority labeling on the pushout's cocone** that chooses which residual renders as canonical while keeping the loser as a live, cherry-pickable branch.
3. **Each artifact type carries a typed patch algebra (the merge *interface*).** A small contract — `apply`, `invert`, `compose`, `commute(p,q):bool` — implemented once per artifact kind (Yjs for text, append/tombstone for knowledge, intent for external). `commute` *is* the anchor-overlap test; `invert` *is* undo; `compose` *is* the pushout. New artifact types become "implement four methods," exactly mirroring the `AgentAdapter` seam the project already trusts.
4. **A named, signed frontier is the one history object (the *cut*).** A frontier is a content-hash of the DAG's tip-set *plus* the signed arbitration decisions up to it. This single object simultaneously is: a **snapshot boundary** (fold resumes from it → bounded replay), a **branch/undo/checkpoint ref** (move a named cut over the op-DAG; partial undo = exclude an interaction, impossible with git's snapshot-refs), a **Byzantine commitment** (it covers lifecycle, which the per-interaction hash deliberately excludes → disagreement becomes a divergent signed frontier, *detectable*), and an **anti-entropy watermark** (advertise your frontier on reconnect, diff, pull the missing causal closure → LISTEN/NOTIFY self-heals).

**Axis:** spans all five (B domain, C operation, E interface/history, A+D the frontier).
**Basis:** `external:` Pijul/Mimram 2013 (pushout, conflicts-as-objects), Peritext CSCW 2022 (stable-ID anchoring), eg-walker EuroSys 2025 (transient reconstruction + frontier), Kleppmann BFT-CRDT 2022 + Merkle-CRDTs 2020 (signed frontier commitment); `direct:` it closes loopholes 1, 2, 3 (via #6 intent-witness riding the algebra), 5, 6 simultaneously, each tied to a cited file/gap above. The novel synthesis is **role-priority on a pushout cocone over a lattice-anchored, signed operation-DAG** — authority-weighted categorical merge with Byzantine-detectable history, which no single prior system combines (Pijul has no authority; Matrix has authority but textual not categorical merge and mutable power-state; eg-walker has neither authority nor anchors-as-regions).
**Rationale:** Three primitives (anchor-lattice, frontier, signature) each unlock a *family* of fixes, and they compose — the frontier is signed by the same infra as the capabilities (#7), the lattice is the domain the algebra's `commute` (#6/interface) operates over, the pushout consumes `compose`. One coherent investment retires four hacks (sentinel anchor, mutable lifecycle, ad-hoc conflict hold, fire-and-forget NOTIFY).
**Downsides:** Large scope — risks reinventing Pijul+Automerge; role-priority-pushout's confluence/associativity is *unproven* and must be established before trusting it cross-machine; reifying conflicts changes the projection contract every fold depends on; the signed frontier needs an identity/PKI layer the system lacks (roles are Discord ids today). Strong temptation to over-build past the walking skeleton. **Sequence it:** ship #2 (lattice) and #4 (lifecycle-as-fold) first as they are net-simplifications; layer the pushout and signing behind them.
**Confidence:** 70%
**Complexity:** High
**Status:** Explored

### 2. Anchor overlap-lattice (replace strict-equality `anchorMatches`)

**Description:** The standalone, highest-leverage first step: replace `anchorMatches`'s five disjoint equality checks with one `anchorOverlaps(a,b)` region-intersection predicate. `range` anchors carry a pair of Yjs `RelativePosition` handles (stable item-IDs that survive concurrent insertion, computable at capture time since a live `Y.Doc` is already held) and overlap by interval intersection *after mapping to a common frame*. Disjoint concurrent edits stop contending; overlapping ones always contend.
**Axis:** B
**Basis:** `direct:` loophole 1 (concurrency.ts:8-15 "central gap"; the sentinel hack); `external:` Peritext stable-char-ID anchoring (CSCW 2022); SIRead/predicate range-locks (Cahill et al., SIGMOD 2008) as the database precedent for "conflict = predicates intersect."
**Rationale:** Closes the one gap that can *silently corrupt a file* and simultaneously removes the false-conflict-on-disjoint-edits problem — the sentinel was a single knob forced to pick between two failures; a lattice needs neither.
**Downsides:** Resolving `RelativePosition` overlap requires the live doc (cost); transitive-overlap closure (A∩B, B∩C, A∩C=∅) needs a defined policy; the interval coordinates must feed the existing hash-order determinism contract or cross-machine byte-identity breaks.
**Confidence:** 82%
**Complexity:** Medium-High
**Status:** Unexplored

### 3. Conflicts as first-class pushout objects; role = priority, not deletion

**Description:** Stop modeling a held conflict as two `proposed` interactions awaiting a pick. Materialize the conflict as a real artifact object (the pushout of the two patches) whose projection is a well-defined "conflicted document," with both intents live and addressable. `merge.resolve` becomes a morphism *into* the pushout (composable, reorderable), and supersession becomes "choose the canonical residual" while the loser survives as a cherry-pickable branch.
**Axis:** C
**Basis:** `external:` Pijul/Mimram categorical patch theory (merge as pushout, conflicts as objects, clean cherry-pick); the grounding's note that knock-knock content-addresses *operations* — the precondition Pijul needs.
**Rationale:** Fixes the fold re-notify gap *by construction* (a conflict object has its own lifecycle the fold keys on — no mutated flag to go stale), and unlocks cherry-pick/selective-supersede the current all-or-nothing model can't express. The losing agent's edit is often the better one; first-classing it makes it recoverable in the artifact, not just the audit log.
**Downsides:** Categorical patch theory is famously hard to implement correctly (Darcs's O(2^n) commutation is the warning); "conflicted document" is new UX; role-as-cocone-priority is novel and unproven; changes the projection contract.
**Confidence:** 64%
**Complexity:** High
**Status:** Unexplored

### 4. Lifecycle as a derived fold + a two-layer signed Merkle identity

**Description:** Stop mutating `lifecycle` in place. Make "is this superseded/denied/held" a **pure dominance relation** computed by a fold over `{role, anchor, caused_by, hash}` — supersession is a *consequence* of the DAG, not a stored column. To keep dedup stable, **don't** put lifecycle into the per-interaction hash; instead add a *second*, signed Merkle layer (an arbitration certificate hash-chained to the interaction it ranks). The immutable-core hash stays for dedup; the signed layer makes outcomes tamper-evident.
**Axis:** A
**Basis:** `direct:` loophole 2 (admit.ts:96-98 re-notify; canonical.ts lifecycle exclusion; unsigned forgeable role); `external:` Kleppmann BFT-CRDT (sign + hash-chain to causal parents), Merkle-CRDTs.
**Rationale:** Three independent bugs (live-stale folds, Byzantine lifecycle disagreement, forgeable authority) share one root cause — lifecycle escaped the fold discipline. Reifying it as a derived projection collapses all three: there's nothing to re-notify (it's an insert), nothing to forge (the dominance order is a function of signed immutable ops), no replay-vs-live asymmetry.
**Downsides:** Moving the supersede→inbox side effects out of `admit` is nontrivial; recomputing dominance per fold step can be expensive without indexing; the second signed layer adds verification cost and a key-management story.
**Confidence:** 71%
**Complexity:** High
**Status:** Unexplored

### 5. The named signed frontier — snapshot + branch + undo + anti-entropy in one object

**Description:** Reify a *frontier* as a first-class `(name, tip-hash-set, role, signature)` object. Then: rewind/branch/checkpoint/undo all become "publish a new named cut" (undo = a cut excluding an interaction — impossible over git's snapshot-refs, natural over an op-DAG); fold rebuild resumes from the latest frontier whose tip-set is an ancestor-subset of the current one (bounded replay, Merkle-keyed memo); reconnect advertises the frontier, diffs against a peer's, and pulls the missing causal closure (LISTEN/NOTIFY self-heals).
**Axis:** D
**Basis:** `direct:` loopholes 5, 6 (store-pg.ts:182-188 no backfill; no snapshotting; `frontier.checkpoint` verb already reserved); `external:` Merkle-CRDTs (frontier = traversal), eg-walker (frontier + transient reconstruction), Dynamo/Cassandra Merkle anti-entropy.
**Rationale:** Three distinct cross-machine failure modes and the entire history-operation surface reduce to manipulating one object the system can already name. The investment compounds: the same frontier is the snapshot, the branch ref, and the convergence watermark.
**Downsides:** Frontier-subset detection cost; cache eviction policy; signing infra + identity bootstrap; partial-undo-via-exclusion interacts badly with CRDT causal-delivery assumptions (undo in CRDTs is a genuine open problem) and must be scoped carefully; anti-entropy adds a gossip protocol to maintain.
**Confidence:** 73%
**Complexity:** High
**Status:** Unexplored

### 6. Intent-witness: converge-to-intended-or-conflict

**Description:** A `workspace.edit` carries only an opaque Y.update today, so interleaving anomalies converge silently to garbage. Attach an **intent witness** to each edit: the parsed `EditIntent` (already computed in versionable.ts:113, then thrown away) plus the agent's expected post-state hash. The fold validates that the merged text preserved each contributor's intent; when interleaving violates it, **demote the merge to a held conflict** instead of shipping a corrupted convergence — turning a fundamentally unpreventable CRDT anomaly into a *detectable* one the role gate can arbitrate.
**Axis:** E
**Basis:** `external:` Weidner & Kleppmann 2023 (interleaving is fundamental to position-based CRDTs; FugueMax only *minimizes* it); `direct:` the `EditIntent`/`applyEditIntent` machinery already exists and is discarded once the Y.update is built.
**Rationale:** Directly answers the deepest critique — the system's stated goal (convergence) is the wrong goal for multi-agent code, where silent garbled merges cause downstream build failures with no signal. Detection is cheap (carry the witness) and is the only available defense, since prevention is impossible.
**Downsides:** Inflates patch payloads; "did the merge preserve intent?" is itself a heuristic that can over-conflict; only works for runtimes that surface a structured `EditIntent` (claude-sdk), not arbitrary ACP agents whose edit formats are already deferred.
**Confidence:** 66%
**Complexity:** Medium
**Status:** Unexplored

### 7. Object-capability authority — signed, scoped, delegable roles

**Description:** Replace the bare snapshotted `role:'owner'|'human'|'agent'` with an owner-signed **capability token** `{actor, role, scope, anchor-pattern, expiry}` referenced by hash from each interaction and *verified* by the gate before admission. Authority becomes unforgeable (closes the forgeable-role hole), **scoped** (an actor can be `owner` for one file's region and `agent` elsewhere), and auditable (a capability is itself a content-addressed interaction). It subsumes the existing `resolveProfileForActor` per-actor tiers under one primitive.
**Axis:** C
**Basis:** `external:` Matrix state-resolution v2 (authority-weighted merge) — but Matrix's power-levels are *mutable merge-state*, the exact source of its membership-churn divergence; the fix is making authority a signed object-capability (ocap model) rather than ambient mutable power; ERA 2025 (epoch authority) assumes honest participants, which signing removes; `direct:` loophole 2 (roles snapshotted but unsigned).
**Rationale:** The system's defining property — owner > human > agent — is only as trustworthy as the `role` field, which is forgeable the moment two machines you don't both control share the DAG. Making authority a signed, scoped capability turns the social hierarchy from an honesty assumption into a cryptographic guarantee and generalizes flat roles to delegation.
**Downsides:** Needs a PKI/identity layer the system doesn't have (roles map to Discord ids today); capability issuance/revocation flow; bootstrap trust (who signs the first owner cap); offline verification cost. Likely the *last* piece to build, after the frontier signing infra (#5) exists.
**Confidence:** 60%
**Complexity:** High
**Status:** Unexplored

---

## Rejection Summary

| # | Idea | Reason rejected |
|---|------|-----------------|
| 1 | Idempotency-key / fencing-token external effects (claim-TTL double-apply) | Real robustness gap (loophole 4) but a *standard* Stripe-style pattern, not a novel algorithm/data-structure per the brief; surfaced in Critical Analysis instead of the ranked list. |
| 2 | Reachability sketch / light-cone causal-set concurrency (replace maxDepth-64 walk) | Optimization of a *safe-direction* gap (extra conflicts, not corruption); lower value than survivors; can ride the frontier index from #5. |
| 3 | Effect-typed two-phase apply (route external effects through the merge gate) | Fights the deliberate external-bypass design (two posts can both have realized); overlaps the claim work; adds gate complexity for little correctness gain. |
| 4 | Typed patch algebra as a standalone idea | Absorbed into idea 1 as its "interface" leg — presenting it twice would inflate the list without adding a distinct decision. |
| 5 | Continuous/learned power-level authority (decay, per-region) | Speculative without a trust layer first; the useful core (weighting) is absorbed into the capability model (#7); learned authority is a brainstorm variant, not a near-term contribution. |
| 6 | Cross-verb staleness / taint propagation across artifacts | Real but lower-severity; absorbed into #4's dominance fold and #6's dependency edges rather than standing alone. |
| 7 | Lazy arbitration (admit-all-as-applied, arbitrate later) | A framing of #4 (lifecycle-as-fold); merged into it to avoid presenting the same structural move twice. |

**Axis coverage:** all five axes carry at least one survivor — B (#2), C (#3, #7), A (#4), D (#5), E (#6), plus the synthesis (#1) spanning all. No deliberate gaps.

---

*Generated by `/ce-ideate`. Next step: `/ce-brainstorm` on a chosen idea to define it precisely enough to plan. The natural seed is idea 1 (the cohesive redesign) or, if sequencing for least risk, idea 2 (anchor lattice) + idea 4 (lifecycle-as-fold) as the simplifying first steps.*
