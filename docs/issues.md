# Open issues

Tracked findings from the live conflict-resolution exercise (admit → conflict →
card → owner resolve, verified end-to-end against the real gate). Logic is
correct; these are UX/observability papercuts, not correctness bugs.

---

## 1. Conflict card: document that branch letters are hash-sorted, not arrival order

**Labels:** ux, docs · _not a correctness bug_

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

---

## 2. Resolve-time supersede leaves the losing agent with no inbox note

**Labels:** enhancement · _the actionable one_

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
