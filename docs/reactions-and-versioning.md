# Reactions, conflict resolution & the relay's version control

knock-knock is **ledger-native**: the only thing it persists is an append-only,
content-addressed DAG of *Interactions*, and everything you see in Discord —
every reaction, card, and DM — is a thin surface over that log. This doc covers
the three layers of that surface:

1. **Reactions** — the glyph vocabulary you use to drive and read a turn.
2. **Conflict resolution** — what happens when two equal-role drafts collide.
3. **Version control** — how the relay records, supersedes, and rewinds actions,
   and why nothing is ever lost.

The deep design of the log itself lives in
[`knock-knock-ledger-model.md`](knock-knock-ledger-model.md); this doc is the
operator's view.

> A task runs in its own Discord **thread** (opened from a top-level `@mention`);
> the reactions and cards below all appear there. An interaction's `channel` is
> that task **scope** — the thread — while permissions and the roster stay keyed
> to the parent **room**. See the room/scope note in the ledger model.

---

## 1. Reactions — the glyph vocabulary

`GLYPHS` in `ledger/render/surface.ts` is the single visual vocabulary; every
cue draws the same symbol for the same concept. Pure renderers build the text,
a synchronization or an `AgentHost` subscriber decides when, and Discord I/O is
thin glue.

### Presence & outcome (on your message)

| Glyph | Meaning |
|---|---|
| 👀 | received — the bot started a turn (transient) |
| 🏁 | turn completed (replaces 👀, persists) |
| ⚠️ | turn errored or produced nothing (persists) |
| ⏹ | turn was stopped by the owner (persists) |

The bot reacts 👀 the instant it starts, then swaps it for a persistent outcome
marker when the turn ends — so scrolling back shows at a glance which requests
succeeded.

### Owner controls (react on a message)

| React | Action |
|---|---|
| 🛑 | **Stop** the scope's in-flight turn — aborts it promptly via the turn's `AbortController`, posts a short "Stopped" note. Owner only. |
| 🔁 | **Retry** — re-run the turn (`turn.retry`). |
| ⏪ | **Rewind** the frontier — the next prompt starts from this point (`frontier.rewind`). |
| 🧷 | **Checkpoint** — pin a named point in the conversation (`frontier.checkpoint`). |

These are recorded as interactions (see §3) and acknowledged with a terse line.
Only the agent's owner can trigger them (verified by user id).

### Approvals (reserved)

| React / button | Action |
|---|---|
| **Allow / Deny** buttons, or ✅ / ❌ | Approve or reject a gated (`ask`) tool call. Owner only. |

✅ / ❌ are **approval-reserved** — the button/reaction handlers route them to the
`Approvals` service, so they are never reused for status. See the deny-floor
discussion in [`getting-started-agents.md`](getting-started-agents.md).

### Session sharing & watches

| Glyph | Meaning |
|---|---|
| 📥 | a **session-sharing** card / imported-context cue — see [`session-sharing.md`](session-sharing.md) |
| ⏳ | an **armed watch** — see [`knock-knock-watches.md`](knock-knock-watches.md) |

> **Reserved glyphs:** ✅ / ❌ (approvals), 🛑 (stop), and 📥 (session sharing) are
> reserved — never reuse them for status.

---

## 2. Conflict resolution

When two agents (or an agent and a human) edit the *same thing*, the relay
surfaces the collision instead of resolving it silently.

### Role-ordered merge

Every write is admitted through a **role-ordered merge gate**
(`ledger/merge.ts`, `ledger/admit.ts`). Roles rank **owner > human > agent**
(`ROLE_RANK`). When a write lands at an anchor another write already holds:

- **Higher role wins** — the lower-role write is *superseded* (kept in the log,
  flagged on the loser's `know:actor/<actor>/inbox`), and its owner gets an
  **override DM** 🔁 explaining what changed.
- **Equal role ties** — neither can silently win, so the relay posts a
  **conflict card**.

### The conflict card 🔀

On a held equal-role conflict the relay posts a **Take A / Take B / … / Write my
own** card (`ledger/synchronizations/conflict-card.ts`). Only the owner can
resolve it; the click admits an owner-role `merge.resolve` that supersedes the
unchosen branches. The losing draft is **kept in the ledger, never deleted**,
and surfaced back to its author's inbox.

> **Branch letters are hash-sorted, not arrival order.** 🅰 / 🅱 come from sorting
> the branch set by hash — the lower-hash tiebreak is exactly what lets two
> machines render byte-identical cards. The second writer to land can take 🅰 if
> its hash sorts lower; the card says so.

### Override DM 🔁

When a higher-role write supersedes your agent's draft, the gate writes a note to
the loser's inbox and `dm-on-supersede` DMs that agent's owner a short summary —
so you learn what changed even though the draft was dropped, not deleted.

---

## 3. The relay's version control

The ledger **is** the version control system. It is an append-only,
content-addressed DAG of Interactions — `{actor, role, channel, target, verb,
patch, effect, caused_by, …}` (where `channel` is the task scope), hashed over
its immutable fields. Three properties make it a version control system rather
than a log:

- **Nothing is deleted — only superseded.** A losing draft, a retracted note, a
  resolved conflict: all stay in the log with a `superseded` lifecycle. The audit
  trail is complete; you can always see what was proposed and what later happened
  to it.
- **State is a fold, not a mutation.** A channel's transcript, what an agent
  knows, a concept's runtime state — each is a *projection* over a slice of the
  log (`ledger/fold.ts`). Re-folding the log reproduces the exact same state:
  replay is deterministic, so a relay restart loses nothing.
- **The frontier is the head.** The current set of live interactions is the
  frontier. The rewind/checkpoint/retry reactions (§1) are **frontier control**:

  | React | Verb | Effect |
  |---|---|---|
  | 🔁 | `turn.retry` | re-run the most recent turn |
  | ⏪ | `frontier.rewind` | move the head back; the next prompt starts there |
  | 🧷 | `frontier.checkpoint` | pin a point you can refer back to |

  All three are just interactions recorded against the frontier — version-control
  operations expressed as reactions.

### Staleness cascade ⚠️

Knowledge notes carry their causal parents. Invalidating a note (`knowledge.invalidate`)
tombstones it **and** every note transitively derived from it — so a conclusion
built on retracted evidence is automatically flagged stale. A reply resting on
invalidated knowledge gets a ⚠️ stale-note flag, surfacing to the human the same
staleness the agent's prompt context already filters out.

### Cross-machine

With the Postgres backend (`KNOCK_KNOCK_LEDGER_URL`) the DAG is shared across
machines via `LISTEN/NOTIFY`, and the role-ordered merge + hash tiebreak make two
relays compute byte-identical conflict cards and supersessions. Each machine's
folds converge on the same projected state.

---

## See also

- [`session-sharing.md`](session-sharing.md) — importing/resuming a local coding
  session's context (📥).
- [`knock-knock-watches.md`](knock-knock-watches.md) — the watch primitive: a turn
  that defers and is resumed by the world (⏳).
- [`knock-knock-ledger-model.md`](knock-knock-ledger-model.md) — the full design of
  the Interaction record, content addressing, role-ordered merge, fold engine, and
  cross-machine sync.
