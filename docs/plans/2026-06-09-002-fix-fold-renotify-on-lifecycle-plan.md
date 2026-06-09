---
title: "fix: re-fold on lifecycle change (close the live-stale gap)"
type: fix
status: active
date: 2026-06-09
origin: docs/brainstorms/2026-06-09-anchored-patch-category-conflict-layer-requirements.md
---

# fix: re-fold on lifecycle change (close the live-stale gap)

## Summary

Close the fold re-notify gap: when `updateLifecycle` supersedes or denies an interaction, the live folds don't learn of it, so a superseded edit stays in the running projection until restart (replay-correct, live-stale). The fix makes the `FoldEngine` re-fold from the store on a lifecycle change — silently, firing each changed fold's subscribers once. This closes live-staleness for **both** role-based supersession (the merge gate) and owner conflict-resolution, with a single source of truth (the lifecycle column the gate already sets) and no new derivation logic.

This is the re-scoped lifecycle leg of `docs/plans/2026-06-09-001-...-plan.md`. It replaces that plan's dominance-deriving projection (U4), which a document review showed could not be a pure fold and depended on a `caused_by` topological sort the engine does not perform. The interval-overlap leg of the 001 plan is deferred to a fresh design pass (see Scope Boundaries).

## Problem Frame

`updateLifecycle` (`ledger/store-sqlite.ts:219`, `ledger/store-pg.ts:346`) is a bare `UPDATE` with no subscriber fanout — only `append` fans out (`store-sqlite.ts:164-170`). The `FoldEngine` runs `applyTo` only on an insert (`ledger/fold.ts:52`), and `versionableFold.step` is add-only (`ledger/artifacts/versionable.ts:170-178`). So when the merge gate supersedes a loser (`ledger/admit.ts:100`) or the owner resolves a conflict (`ledger/resolve-conflict.ts:61-65`), the loser's row flips to `superseded` but the live fold still holds it: the running projection shows it as active, while a fresh replay excludes it via the `admitted|applied` key (`versionable.ts:166`). Replay-correct, live-stale (`admit.ts:96-98` names this as deferred).

Seven folds key on `admitted|applied` (versionable, knowledge, watch, channel, approval, loop-guard, turn); only the anchored-verb folds (versionable, knowledge) can receive a supersession today, but the fix is a general engine capability so any future anchored fold is correct.

## Key Technical Decisions

- **Re-fold from the store, not per-fold eviction.** On a lifecycle change, rebuild the affected fold state by replaying from the store — the same path `register` already uses and the determinism tests already trust. Chosen over teaching each fold to evict a superseded input, because re-fold is obviously correct, needs no per-fold removal logic, and adds zero new determinism surface. Supersessions are rare (conflicts/overrides), so the replay cost is bounded by rarity; per-fold incremental eviction is a deferred optimization.
- **Silent rebuild, fire subscribers once.** A naive replay would re-run `step` for every interaction and re-fire subscribers per step, spamming subscribers (e.g., re-posting the Workbench on every `turn.*`). The re-fold rebuilds state without per-step subscriber callbacks, then fires each fold whose state changed exactly once (delta `undefined`, like the initial `subscribe` delivery).
- **The lifecycle signal is awaited.** `updateLifecycle` fires an in-process lifecycle-change signal and awaits the re-fold, so live fold state is consistent with the gate's decision by the time the call returns — deterministic and testable, no fire-and-forget race.
- **Re-fold emits no interactions.** It only recomputes fold state, so it cannot recurse into `admit` or the synchronizer wave — no re-entrancy hazard, even when triggered synchronously from inside `admit`.
- **In-process scope.** This closes the in-process live-stale gap. Cross-machine propagation of a lifecycle change (the PG NOTIFY trigger fires only on INSERT, not UPDATE) is a pre-existing, separate gap — deferred, not introduced here.

## Requirements

- R1. When an interaction's lifecycle changes to `superseded` or `denied`, every live fold reflects it immediately — its projected state equals a fresh replay of the store, with no restart.
- R2. Both supersession paths are covered: role-based supersession via the merge gate (`admit.ts`) and owner conflict-resolution (`resolve-conflict.ts`).
- R3. Re-folding does not re-fire fold subscribers per replayed interaction; a fold whose state changed fires its subscribers once.
- R4. The cross-machine determinism contract holds: reconstructability (rebuild folds → byte-identical state) and the existing merge/conflict/cross-machine tests stay green.

## Implementation Units

### U1. Store lifecycle-change signal

**Goal:** Have `updateLifecycle` emit an in-process signal so the fold engine can react.
**Requirements:** R1, R2
**Dependencies:** none
**Files:** `ledger/store.ts`, `ledger/store-sqlite.ts`, `ledger/store-pg.ts`, `ledger/store-sqlite.test.ts` (or the nearest store test)
**Approach:** Add `subscribeLifecycle(cb: (hash, lifecycle) => void | Promise<void>)` to the `Store` interface alongside the existing `subscribe`. In both backends, after the `UPDATE` in `updateLifecycle`, invoke the lifecycle subscribers and await any returned promise so the call completes only once reactions finish. Keep this separate from the insert `subscribe` fanout (that channel carries fresh `Interaction`s; this one carries a hash + new lifecycle).
**Patterns to follow:** the existing `subscribers` set and fanout in `store-sqlite.ts:164-170`; mirror the shape in `store-pg.ts`.
**Test scenarios:**
- `updateLifecycle(hash, 'superseded')` invokes a registered lifecycle subscriber with `(hash, 'superseded')`.
- An async lifecycle subscriber is awaited before `updateLifecycle` resolves.
- `append` does not fire lifecycle subscribers; `updateLifecycle` does not fire insert subscribers.
**Verification:** a lifecycle subscriber observes every `updateLifecycle` call, and the call awaits it.

### U2. FoldEngine re-fold on lifecycle change

**Goal:** Rebuild affected fold state from the store on a lifecycle change, silently, firing changed folds once.
**Requirements:** R1, R3, R4
**Dependencies:** U1
**Files:** `ledger/fold.ts`, `ledger/fold.test.ts`
**Approach:** In the `FoldEngine` constructor, also `store.subscribeLifecycle(...)` and on each signal run a `refold()`. `refold()` rebuilds each fold by resetting `state = init()` and `seen = new Set()`, then replaying `listAllSince(0, MAX)` through a silent variant of `applyTo` that runs `key`+`step` but suppresses subscriber callbacks. After the silent rebuild, for each fold whose state reference changed, fire its subscribers once with `(state, undefined)`. Re-fold emits no interactions, so it cannot recurse into the synchronizer.
**Patterns to follow:** the replay loop in `register` (`fold.ts:61-71`) and the `applyTo` body (`fold.ts:106-127`); reuse them rather than duplicating.
**Technical design (directional):** factor `applyTo` so the subscriber-firing tail is optional; `register` and `refold` both replay with firing suppressed, and `refold` fires once per changed fold afterward.
**Test scenarios:**
- After a versionable edit is superseded via `updateLifecycle`, `engine.get(VERSIONABLE_FOLD)` immediately excludes it — equal to a fresh-engine replay of the same store.
- A knowledge note superseded → excluded from the live knowledge fold immediately.
- Re-fold fires a fold's subscriber once (not once-per-interaction); a subscriber counter asserts a single call per changed fold.
- A fold whose state did not change does not fire its subscribers on an unrelated lifecycle change.
- Re-fold triggered synchronously from within an `admit` call completes without recursing into admission (no new interactions appended by the re-fold).
**Verification:** live fold state matches a fresh replay after any supersession; subscribers fire once per changed fold.

### U3. Integration and determinism coverage

**Goal:** Prove the gap is closed on both supersession paths and the determinism contract holds.
**Requirements:** R1, R2, R4
**Dependencies:** U1, U2
**Files:** `ledger/admit.test.ts`, `ledger/resolve-conflict.test.ts`, `ledger/cross-machine.test.ts`
**Approach:** Drive the real paths end-to-end: a higher-role edit superseding a lower-role concurrent edit (via `admit`) drops the loser from the live projection without restart; an owner `merge.resolve` (via `resolveConflict`) drops the unchosen branch from the live projection without restart. Confirm the pre-existing determinism tests stay green.
**Test scenarios:**
- Role-supersede via `admit`: lower-role edit applied, higher-role overlapping edit admitted → live versionable projection excludes the lower-role edit immediately (previously required restart).
- Owner resolution via `resolveConflict`: two held equal-role branches, owner picks one → live projection shows only the chosen branch immediately; the loser stays in the log (audit) but not in the live view.
- Reconstructability: rebuild folds from the log → byte-identical to the live post-supersession state.
- Pre-existing cross-machine tests (`cross-machine.test.ts:157,204,238`) stay green.
**Verification:** both supersession paths reflect immediately in live folds; determinism suite green.

## Scope Boundaries

### Deferred to follow-up work
- Per-fold incremental eviction (an optimization over full re-fold) if supersession volume makes re-fold cost matter.
- Cross-machine propagation of a lifecycle change — the PG NOTIFY trigger fires only on INSERT, so a supersession on one relay does not live-update another relay's folds. Pre-existing gap; not introduced here.

### Deferred to a fresh design pass (back to brainstorm)
- Interval-overlap anchors (origin R5). A document review showed correct cross-machine overlap detection needs a real determinism design — the fold engine does not topologically sort by `caused_by` (it replays in `seq` order), the "causal-meet base" is not a single deterministic state, and capture-time coordinates must be replica-identical. This is a design problem of its own, not a low-risk increment; it returns to `ce-brainstorm` before re-planning.

### Outside this product's identity (origin)
- Signed frontiers, capabilities, Byzantine-fault tolerance — single-operator trust.

## Risks & Dependencies

- **Re-fold cost scales with log size.** A full re-fold per lifecycle change is O(all-time interactions). Acceptable because supersessions are rare and there is no snapshotting yet; flagged as the first thing to optimize (per-fold eviction) if supersession volume grows.
- **Subscriber side effects.** Re-fold must not re-fire subscribers per replayed interaction (would re-post the Workbench, re-DM, etc.). The silent-rebuild-then-fire-once design (KTD) is the mitigation; U2 tests assert single-fire.
- **Awaited signal changes `updateLifecycle` timing.** `updateLifecycle` now awaits the re-fold, so it is slower and async-heavier. Callers already `await` it (`admit.ts:100`, `resolve-conflict.ts:61-65`), so no signature change ripples.

## Sources / Research

- Origin: `docs/brainstorms/2026-06-09-anchored-patch-category-conflict-layer-requirements.md` (R6, re-scoped to the re-notify approach after review).
- Superseded sibling: `docs/plans/2026-06-09-001-refactor-anchor-overlap-lifecycle-fold-plan.md` (its lifecycle leg is replaced here; its overlap leg is deferred).
- The gap: `ledger/store-sqlite.ts:219` / `ledger/store-pg.ts:346` (bare UPDATE, no fanout); `ledger/fold.ts:52,106-127` (insert-only `applyTo`); `ledger/artifacts/versionable.ts:166-178` (lifecycle key + add-only step); `ledger/admit.ts:96-100` (supersede write + the deferred-gap comment); `ledger/resolve-conflict.ts:61-65` (owner-resolution flips).
- Lifecycle-keyed folds: `versionable.ts:166`, `knowledge.ts:59`, `concepts/{watch,channel,approval,loop-guard,turn}.ts`.
- Determinism guardrail: `ledger/cross-machine.test.ts:157,204,238`.
