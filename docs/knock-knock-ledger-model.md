# The knock-knock Interaction-Ledger Model

A formal specification of the collaboration core, with algorithm sketches and a
worked example. This document is written to be handed to an implementing agent
(Claude Code) as the architectural brief. It states **what is ours to build**,
defines the objects precisely, sketches the algorithms, and walks one small
scenario through every mechanism.

---

## 0. What we contribute, and what we only borrow

We are not assembling frameworks. We take exactly four ideas from prior work as
*stances* and implement everything ourselves. Be explicit about the line:

| | Source idea | What we keep | What we drop |
|---|---|---|---|
| Borrowed | Pijul / event sourcing | *the change is primary; state is derived; conflict is a recordable state, not a merge failure* | the tool, its patch format, its conflict algebra |
| Borrowed | sequence CRDT (RGA/Fugue) | the *merge algorithm* used **inside** a versionable artifact, as an implementation detail | the CRDT as the system's top-level model |
| Borrowed | Manyana | conflict is flagged when changes *touch*, never a hard failure | — |
| Borrowed | Meng & Jackson concepts/synchronizations | concepts are independent; synchronizations glue by event without coupling | concept-local stored state (we make state a fold) |

Our four genuine contributions, in priority order:

- **C1 — One ledger, everything is a fold.** The only stored thing is an
  append-only causal ledger of interaction-patches. Artifact versions, an
  agent's working context, a channel's view, and a concept's state are all
  *projections* (folds) over a slice of that ledger. The sharp form: **an
  agent's context window and the human's audit trail are the same fold** —
  interpretability for both audiences is one mechanism, not two.
- **C2 — Reversal typed by target kind.** Every artifact is `VERSIONABLE`,
  `KNOWLEDGE`, or `PROXY`, and the kind — not the system — determines the
  inverse: exact `undo`, `invalidate` (staleness propagation), or `compensate`.
  A composite verb decomposes and reverses as a saga.
- **C3 — Role-ordered merge (the centerpiece).** A plain CRDT merges
  symmetrically. Ours merges under a **per-channel role partial order**
  (`owner ≻ human ≻ agent`). The *same two concurrent patches* resolve
  differently depending on the channel. Losing patches are *superseded, not
  destroyed*, and supersession is *recomputed by the fold*, never stored.
- **C4 — Concept state as a fold, glued by synchronizations.** Behavior is
  independent concepts whose state is a named fold and synchronizations that
  fire on effects, so a new behavior is one synchronization and zero edits to
  existing concepts.

---

## 1. Object model

### 1.1 Actors and roles

Let `A` be the set of actors (humans and agents). Role is **not** a global
property of an actor; it is a function of actor *and* channel:

```
role : A × C → {owner, human, agent, ⊥}
```

with the total order `owner ≻ human ≻ agent` and `⊥` meaning "not permitted in
this channel." The same actor can be `owner` in one channel and `agent` in
another. This is the social core: the hierarchy is per-channel, so authority is
scoped, not ambient.

### 1.2 Channels

`C` is the set of channels. A channel `c` carries (a) the role assignment
`role(·, c)`, (b) a permission profile `profile(c) = ⟨allow, ask, deny⟩` of
`Tool(arg)`-style glob patterns, and (c) an approver role. A channel **scopes
interoperation**: two interactions are merge/conflict candidates only if they
share a channel. (Maps directly onto today's `rooms/<agent>/<id>.settings.json`.)

### 1.3 Artifacts and kinds

`Artifacts` is the set of things worked on. Each artifact `a` has a kind:

```
κ : Artifacts → {VERSIONABLE, KNOWLEDGE, PROXY}
```

- `VERSIONABLE` — a file, document, tree. Has a region/anchor space; patches are
  deltas; merged by an internal sequence CRDT.
- `KNOWLEDGE` — an actor's accumulated evidence/notes/context. Append-only by
  nature; patches only ever add observations.
- `PROXY` — a shadow of something we can model but not control (a deployment, a
  sent message). Patches record *intent/result* against the shadow.

### 1.4 The interaction (our unit = a patch)

An interaction is the promotion of today's `wrapEnvelope` from a transient
prompt wrapper into the persisted, content-addressed record:

```
i = ⟨ id, actor, channel, target, anchor, verb, patch, effect, deps, lifecycle ⟩

  id        = H(i \ {id})                      content hash → identity, dedup, integrity
  actor     ∈ A
  channel   ∈ C
  target    ∈ Artifacts
  anchor    ⊆ region-space(target)             the region this patch touches
  verb      a concept-action name              e.g. Writing.applied, Searching.completed
  patch     the change to target
  effect    ∈ {MUTATE, OBSERVE, EXTERNAL}      INVARIANT: determined by κ(target)
  deps      ⊆ ids                              causal parents the actor had observed
  lifecycle ∈ {PROPOSED, ADMITTED, DENIED}     supersession & conflict are NOT stored here
```

Invariant **E** (`effect` is derived): `κ(target)=VERSIONABLE ⇒ effect=MUTATE`;
`KNOWLEDGE ⇒ OBSERVE`; `PROXY ⇒ EXTERNAL`. Atomic interactions touch exactly one
target; mixed actions are *composite verbs* that desugar to atomic ones (§3.3).

### 1.5 The ledger, frontier, projection

The **ledger** `L` is an append-only set of interactions forming a DAG under
`deps`. Define happens-before `≺` as reachability via `deps` (`i ≺ j` iff `i` is
a transitive dependency of `j`), and **concurrency** `i ∥ j` iff neither `i ≺ j`
nor `j ≺ i`.

A **frontier** `F ⊆ L` is a set of head interactions. The *version* it names is
its causal down-closure `⇓F = { i ∈ L : i ⪯ h for some h ∈ F }` — a
causally-closed subset. Moving `F` = choosing a version (this is undo/redo,
checkpoint, resume).

A **projection** is a pure fold over a filtered slice of `⇓F`. The four that
matter:

```
state(a, F)               materialized artifact a at frontier F
context(actor, c, F)      what actor knows in c  = the slice rendered into its prompt
view(c, F)                channel c's visible interactions
cstate(concept, F)        a concept's lifecycle state
```

**C1 restated formally:** there is no store besides `L`. Every one of the above
is `FOLD` over a slice. `context(actor,c,F)` and the human-facing
"why did this happen" audit are the *same slice* — that is the dual-audience
property, not a coincidence to be engineered later.

---

## 2. Invariants (the success rubric, as checkable properties)

- **I1 Replayability.** For all `a, F`: `state(a,F)` is fully determined by
  `⇓F`. No projection reads state outside `L`. *Test: delete every cache; all
  projections must recompute identically.*
- **I2 Independence.** Adding a concept adds synchronizations only; it never
  edits an existing concept. Concepts share only `L`. *Test: a new concept's
  diff touches zero existing concept files.*
- **I3 Interpretability (dual-audience).** One causal slice answers "why" for a
  human and is the exact context for the LLM. *Test:
  `context(agent,c,F)` rendered for the prompt equals the slice a human reads to
  explain the agent's last action.*
- **I4 Role-correctness.** The deny floor is unreachable even by an approved
  request; an owner can always override on their own machine; overrides are
  non-destructive and surfaced.
- **I5 Graceful degradation.** All-equal roles ⇒ behavior is a pure
  collaborative CRDT; owner-plus-agents ⇒ owner is decisive (today's
  knock-knock).

---

## 3. Core algorithms (sketches)

Notation: `⊕` is append; `deps*(i)` is the transitive dependency set;
`currentFrontier` is the live heads of `L`.

### 3.1 Materialize an artifact — `FOLD`

```
FOLD(a, F):                                  # state(a, F)
  S ← empty(κ(a))
  P ← { i ∈ ⇓F : i.target = a ∧ i.lifecycle = ADMITTED }
  for each causal layer of P in some linear extension of ≺:
      groups ← partition layer by overlapping anchor          # regions touched together
      for g in groups:
          if |g| > 1 and members of g are mutually ∥:
              S ← ROLE_MERGE(S, g, channel(g))                 # C3
          else:
              for i in g (in causal order): S ← APPLY(S, i)    # commutes; order-free for VERSIONABLE
  return S
```

```
APPLY(S, i):                                 # dispatch on target kind
  case κ(i.target):
    VERSIONABLE: return seqCRDT_apply(S, i.patch)    # RGA/Fugue, disjoint edits commute
    KNOWLEDGE:   return S ⊕ observation(i)            # append-only, always commutes
    PROXY:       return S ⊕ proxyrecord(i)            # append intent/result
```

### 3.2 Role-ordered merge — `ROLE_MERGE` (the contribution)

Given a set `g` of mutually-concurrent interactions on one artifact whose
anchors overlap, and their channel `c`:

```
ROLE_MERGE(S, g, c):
  rank ← { i ↦ role(i.actor, c) for i in g }
  m    ← max(rank.values)                    # owner ≻ human ≻ agent
  W    ← { i ∈ g : rank[i] = m }             # top-role candidates

  if |W| = 1:                                # decisive higher role
      w ← the element of W
      S ← APPLY(S, w)
      for i in g \ {w}: surface SUPERSEDED(i, by=w)   # DERIVED each fold, not stored; notify author
      return S

  else:                                      # equal top role → genuine conflict (Manyana flag)
      return CONFLICT_REGION(S, W)           # retain all branches side-by-side
                                             # transient: resolved by any causally-LATER
                                             # write j with role(j.actor,c) ≥ m whose anchor
                                             # covers the region (j is no longer concurrent,
                                             # so it simply wins by role+recency)
```

Three consequences worth stating because they fall out for free:

1. **Supersession is recomputed, never persisted** — it is a pure function of
   the slice's roles, so it is consistent with C1 (no side state) and honors I4
   (non-destructive: losers stay in `L`, recoverable).
2. **Conflict is transient and derived** — it exists only while two concurrent
   equal-role patches are uncovered by any causally-later qualifying write.
3. **The same two patches, two outcomes** — because `role(·,c)` is per-channel,
   `{w, w'}` auto-resolve where one author outranks the other and flag-as-
   conflict where they are peers. Resolution is a function of the channel view.

`PROXY` never merges. Concurrent `EXTERNAL` patches to one proxy are serialized
by a `Claim` interaction granting an actor exclusive anchor for a causal window;
a competing unclaimed `EXTERNAL` is `DENIED` at admission.

### 3.3 Reversal typed by kind — `INVERSE` (C2)

```
INVERSE(i):                                  # returns a forward interaction (or fold-level mark)
  case κ(i.target):
    VERSIONABLE: return new interaction with
                   patch = inverse_delta(i.patch),
                   deps  = currentFrontier ∪ {i}        # TRUE UNDO (exact)
    KNOWLEDGE:   return TOMBSTONE(i)                     # INVALIDATE, not delete:
                   # FOLD marks i stale and propagates 'stale' to every j with i ∈ deps*(j).
                   # Downstream conclusions become eligible for re-derivation; nothing removed.
    PROXY:       return COMPENSATION(i.compensation)     # forward counter-effect (saga step)
```

```
INVERSE(V = ⟨i₁ … iₙ⟩):                       # composite / macro verb
  return [ INVERSE(iₙ), …, INVERSE(i₁) ]      # SAGA in reverse order
  # V is reversible only as far as each PROXY part's compensation is faithful.
  # The VERSIONABLE parts undo exactly; the KNOWLEDGE parts only invalidate.
```

The key honesty: `undo`, `invalidate`, and `compensate` are not competing — they
are the inverse rules for three different artifact kinds, and a composite stitches
them by causal order. "Is this reversible?" is the wrong question; "which kind did
it touch?" is the right one.

### 3.4 Admission and the deny floor — `ADMIT` (ties to `classifyTool`)

```
ADMIT(i, c):
  d ← classify(profile(c), i.verb, i.anchor)       # existing classifyTool patterns
  if d = deny:   i.lifecycle ← DENIED;  return      # THE FLOOR — checked first, unconditional
  if d = allow:  i.lifecycle ← ADMITTED; return
  if d = ask:    i.lifecycle ← PROPOSED
                 # awaits an Approving interaction by an actor with role ≥ approver(c).
                 # Approving.allowed → ADMITTED ;  Approving.denied → DENIED.
                 # A verb matching deny stays DENIED even if later 'allowed' (I4: floor wins).
```

The `Approving` decision is itself an interaction in `L` — approvals are uniform
with everything else, so the owner's click is just another patch.

### 3.5 Behavior gluing — synchronizations (C4)

A synchronization `σ = ⟨when, where, then⟩`: `when` is a pattern over a newly
applied interaction, `where` a guard over current projections, `then` a function
producing requested interactions.

```
ON_APPLIED(i):
  for σ in syncs:
     if MATCH(σ.when, i) ∧ σ.where(currentFrontier):
        for req in σ.then(i, currentFrontier):
           j ← new interaction(req, caused_by = {i.id, σ.id})
           if not exists_by_hash(j):                 # content-hash dedup ⇒ idempotent firing
              ADMIT(j, j.channel)
  # agent-role-triggered syncs are additionally capped by the existing
  # consecutive-agent-turn loop guard, so two bots can't ping-pong forever.
```

Concept state is a fold: `cstate(Searching, F)` is computed from
`Searching.*` interactions in `⇓F` — never a stored variable. That is what makes
I2 hold structurally.

---

## 4. Worked example

A research channel `#proj`. Actors and their roles **in this channel**:
`Olivia = owner`, `Ann = agent` (Olivia's), `Ben = agent` (a collaborator's bot,
on his own machine). Artifacts: `report.md` (`VERSIONABLE`), `evidence`
(`KNOWLEDGE`), `plan` (`VERSIONABLE`). Profile: `Write(report.md)` is `allow`,
`Write(**)` is `ask`, `Deploy(*)` is `deny`.

A synchronization library is loaded:

```
σ1: when Communicating.received(role=owner, is_task)   then Searching.search
σ2: when Searching.completed                           then Reading.read(sources)
σ3: when Reading.read                                   then Planning.form
σ4: when Planning.committed                             then Writing.apply
```

### 4.1 The trace

```
id  actor    verb                    target      kind         deps        outcome
i1  Olivia   Communicating.received  conversation KNOWLEDGE   {}          ADMITTED  "draft §X on topic"
i2  Ann      Searching.completed     evidence     KNOWLEDGE   {i1}        ADMITTED  (σ1 fired) 3 sources
i3  Ann      Reading.read            evidence     KNOWLEDGE   {i2}        ADMITTED  (σ2) extracted facts
i4  Ann      Planning.committed      plan         VERSIONABLE {i3}        ADMITTED  (σ3) outline of §X
i5  Ann      Writing.applied         report.md    VERSIONABLE {i4}        ADMITTED  (σ4) §X draft  [allow ⇒ no prompt]
i6  Ben      Writing.applied         report.md    VERSIONABLE {i1}        ADMITTED  Ben also drafts §X
i7  Olivia   Writing.applied         report.md    VERSIONABLE {i5,i6}     ADMITTED  resolves §X
i8  Olivia   (INVERSE of i2)         evidence     KNOWLEDGE   {i7}        ADMITTED  one source was fabricated
```

### 4.2 Walking it through each mechanism

**Synchronization chain (C4).** `i1` is an owner instruction (a `KNOWLEDGE`
append to the conversation). `σ1`'s `when` matches, so the system requests a
search; Ann's `Searching.completed` is `i2`, carrying `caused_by={i1}`. `σ2`
then fires off `i2` → `i3` (reading), `σ3` off `i3` → `i4` (planning), `σ4` off
`i4` → `i5` (writing). Nothing in `Searching` knows about `Reading`; the arrows
are entirely in the four `σ` rules. Adding a `Critiquing` pass later is one new
`σ5: when Writing.applied then Critiquing.review` and zero edits above — I2.

**Admission / deny floor (I4).** When `i5` is proposed, `ADMIT` classifies
`Write(report.md)` → `allow` → straight to `ADMITTED`, no prompt (this is the T1
"auto" case). Had Ann instead proposed `Deploy(prod)`, `classify` returns `deny`
*first*, so it is `DENIED` and never runs — and would stay denied even if Olivia
clicked allow.

**Projection = context = audit (C1, I3).** At this point
`context(Ann, #proj, F)` is `FOLD` over `{i1,i2,i3,i4,i5}` — Olivia's
instruction, the sources, the facts, the plan, the draft. That same slice *is*
what gets rendered back into Ann's prompt on her next turn, **and** it is exactly
the slice a human reads to answer "why does §X say what it says." One fold, two
audiences.

**Role-ordered merge — equal-role conflict (C3).** `i5` (Ann) and `i6` (Ben)
both write `report.md` §X. `i6.deps = {i1}` — Ben never observed `i5`, so
`i5 ∥ i6`, and their anchors overlap. `FOLD(report.md, F)` reaches a group
`{i5, i6}`; `ROLE_MERGE` ranks both as `agent`; `m = agent`, `|W| = 2`. Equal top
role ⇒ `CONFLICT_REGION`: both drafts of §X are retained and surfaced
side-by-side. Nothing fails; nothing is lost.

**Role-ordered merge — higher-role resolution (C3, I4).** Olivia reads the
conflict and writes `i7` with `deps = {i5, i6}`. Because `i7` is causally *after*
both, it is no longer concurrent with them — it simply applies on top, and
`role(Olivia,#proj)=owner ≻ agent`, so `i7` wins and `i5, i6` are marked
`SUPERSEDED(by=i7)`, surfaced back to Ann and Ben as "overridden by owner." That
supersession is recomputed by the fold from roles; it is not written into `i5`
or `i6`. `state(report.md, F)` §X is now Olivia's text.

*The C3 punchline:* run the identical `{i5, i6}` in a channel where Olivia were
merely a peer — `m = agent` with three peers — and they would flag as conflict,
not auto-resolve. Same patches, different outcome, decided by the channel's role
map.

**Reversal typed by kind (C2).** One of Ann's sources in `i2` turns out
fabricated. Olivia issues `INVERSE(i2)` = `i8`, a `TOMBSTONE`, because
`κ(evidence)=KNOWLEDGE`. `FOLD` marks `i2` stale and propagates `stale` along
`deps*`: `i3` (read those sources) → stale, `i4` (planned from `i3`) → stale,
and `i7`'s §X, which rests on the plan, is *flagged as resting on stale
knowledge*. Note what does **not** happen: the report text is **not** reverted.
Knowledge reverses by invalidation, not undo — the prose stays, but its
provenance now shows stale, prompting a re-derivation the humans can choose to
run. Had the fabricated thing instead been a line in `report.md`
(`VERSIONABLE`), `INVERSE` would have produced an exact inverse delta and the
line would have been removed. Had it been a `Deploy` (`PROXY`), `INVERSE` would
have emitted the registered compensation (a rollback), forward-only.

**Composite saga (C2).** Suppose later a single `Deploying` verb bundled
`⟨bump version in report.md (VERSIONABLE), push to prod (PROXY), capture logs
(KNOWLEDGE)⟩`. Its `INVERSE` runs right-to-left: keep the logs (you don't
un-observe), compensate the push (rollback), exact-undo the version bump. The
composite is reversible exactly as far as the push's compensation is faithful —
which is the honest boundary, made explicit by the decomposition.

---

## 5. The decision process (why these choices)

- **Why a ledger of patches rather than versioned artifacts?** Because we need
  one substrate to carry a codebase *and* an open-ended research process *and*
  an agent's evolving context, and to support undo/resume/branch uniformly.
  Storing versions (git's model) loses *why*; storing patches keeps the causal
  chain, and every view is a fold. This is Pijul's thesis and nothing more of
  Pijul.
- **Why type artifacts into three kinds?** Because the reversibility question
  has no single answer — files undo, knowledge can't be un-known, the external
  world can't be un-done. Typing the *target* lets one ledger hold all three
  without special-casing the *system*. It is also what dissolves the
  "code vs research" fork: a kind is per-target, so one channel runs both.
- **Why role-ordered merge instead of a plain CRDT?** Because the whole premise
  is a social application with a hierarchy. A symmetric CRDT has no notion that
  an owner outranks an agent. Making the merge partial-ordered by per-channel
  role is the smallest change that encodes the hierarchy, degrades to pure CRDT
  when roles are equal (I5), and keeps overrides non-destructive (I4). This is
  the piece no off-the-shelf tool gives us, so it is the piece we build most
  carefully.
- **Why concepts + synchronizations with state-as-fold?** Because we want to add
  agent behaviors (critique, verify, summarize) without a growing tangle. The
  Meng/Jackson split gives independence; folding the state (rather than storing
  it per concept) keeps I1 and I2 true at the same time.
- **Why supersession recomputed, not stored?** Because storing it would create
  state outside the fold and break I1, and because roles can change per channel,
  so the *same* ledger must resolve differently in different views — only a pure
  recomputation can do that.

---

## 6. Deliberately unspecified — for the implementing agent to design

The model above is concept and algorithm *sketch*. The build still must specify:

- **Sequence-CRDT choice and the exact `inverse_delta`** for `VERSIONABLE`
  artifacts (RGA vs Fugue vs Loro-internal), and how `seqCRDT_apply` reconciles
  with `ROLE_MERGE` at overlap boundaries.
- **Staleness propagation** traversal and its termination/idempotency over
  `deps*`, and how stale flags are surfaced without mutating downstream
  interactions.
- **Anchor model** per artifact kind (line ranges, AST spans, byte offsets,
  knowledge-fact ids) and the overlap predicate that triggers `ROLE_MERGE`.
- **`CONFLICT_REGION` representation** and how it renders to (a) the agent prompt
  and (b) the human channel message.
- **Compensation registration** for `PROXY` verbs — where the rollback is
  declared and how faithful it is allowed to be.
- **Fold engine** — incremental vs full recompute, projection caching (a cache
  is legal as long as it is provably re-derivable; I1 is about *truth*, not
  *performance*).
- **Sync transport / cross-machine reconciliation** — the still-open choice
  between a single shared replicated ledger and federated per-machine ledgers
  that reconcile on contact. This is the genuine "synchronous collaboration
  without git" decision and is intentionally left for a dedicated design pass.

## 7. Mapping to the existing codebase

This is an evolution of knock-knock, not a rewrite:

- `wrapEnvelope` (`lib.ts`) → the interaction header (§1.4).
- `senderKind` / `guildSenderAllowed` (`lib.ts`) → `role(·, c)` (§1.1).
- `classifyTool` (`lib.ts`) → `classify` inside `ADMIT` (§3.4).
- `Approvals` clicks (`approvals.ts`) → `Approving` interactions (§3.4).
- `Driver` per-channel turn queue (`driver.ts`) → causal-ordering authority for
  `deps`.
- `state.ts` (single I/O chokepoint) → grows into ledger persistence + the fold
  engine.

The two genuinely new things to build: **explicit artifacts as targets** (today
agent file-writes are implicit side effects in the workspace), and the **ledger
persistence plus fold engine** (§3.1).
