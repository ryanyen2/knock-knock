# Open issues

Tracked findings from the live conflict-resolution exercise (admit → conflict →
card → owner resolve, verified end-to-end against the real gate). Logic is
correct; these are UX/observability papercuts, not correctness bugs.

> **Status: both resolved** on the `transaction` branch (see the per-issue
> _Resolution_ notes). Kept here as a record of the findings and the rationale.

---

## 1. Conflict card: document that branch letters are hash-sorted, not arrival order

**Labels:** ux, docs · _not a correctness bug_ · **✅ resolved**

The A / B / … letters on a conflict card come from sorting the branch set by
hash (`ledger/synchronizations/conflict-card.ts:48`); the matching button labels
follow in `agent-host.ts:422-427`. This is deliberate — the lower-hash tiebreak
is what makes two machines compute byte-identical cards — but an owner skimming
the card may read 🅰 as "the first draft." In practice the second writer to land
can take 🅰 if its hash sorts lower.

**Fix**
- Add a code comment at the sort in `conflict-card.ts` marking the order as
  intentional and explicitly *not* arrival order.
- Add a one-line hint to the card text, e.g. `-# letters are stable across
  machines, not arrival order`.

**Resolution**
- `conflict-card.ts` — the comment at the hash sort now states the order is
  intentional and *not* arrival order, and warns against re-sorting by timestamp.
- `ledger/render/surface.ts` — `renderConflictCard` appends
  `-# letters are stable across machines, not arrival order` whenever the card
  has lettered branches. Covered by the `surface.test.ts` conflict-card tests.

---

## 2. Resolve-time supersede leaves the losing agent with no inbox note

**Labels:** enhancement · _the actionable one_ · **✅ resolved**

`AgentHost.resolveConflict` (`agent-host.ts:487-489`) supersedes the unchosen
branch with a direct `store.updateLifecycle(loser, 'superseded')`, bypassing the
`surfaceToInbox` path in `ledger/admit.ts`. As a result, a draft dropped by a
conflict *resolution* is silent: the losing agent only ever learns of a drop
when a higher-role *admission* supersedes it (which does write to the inbox),
never when an owner resolves a card against it.

**Fix**
- In `resolveConflict`, after flipping each loser to `superseded`, write a brief
  `knowledge.append` to `know:actor/<loser>/inbox` mirroring `surfaceToInbox`
  (`caused_by: [loser, resolveHash]`, tags `['merge', 'superseded']`), so the
  losing agent's next "what do I know" fold surfaces that its draft lost and why.
- Consider factoring `surfaceToInbox` out of `admit.ts` so both the gate and the
  resolve path share one surfacing implementation.

**Resolution**
- `ledger/admit.ts` — `surfaceToInbox` is now exported, so the gate and the
  resolve path share one implementation (no duplicated surfacing logic).
- `agent-host.ts` — `resolveConflict` now fetches each superseded loser and
  calls `surfaceToInbox(...)` with `winner: resolve.hash` (→
  `caused_by: [loser, resolveHash]`, tags `['merge', 'superseded']`). Because the
  note is authored by `system:merge-gate`, the existing `dm-on-supersede`
  synchronization also fires — so the losing agent's owner now gets the "a draft
  was overridden" DM on owner resolution too, not just on higher-role admission.
