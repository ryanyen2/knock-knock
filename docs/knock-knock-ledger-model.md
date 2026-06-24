# The knock-knock ledger — a field guide

A user-facing tour of how knock-knock remembers things, shows you what's
happening, and lets you take back control when an agent goes the wrong way.
Most of this document is about what you *see* in Discord — the icons, the
edited messages, the approval prompts. The deep architecture is a one-page
appendix at the bottom for the curious; if you only ever need to read one
section, read **§2 Who goes first** and **§3 What you see today**.

> Anything labelled **Shipping today** is in `main` and you can use it now.
> Anything labelled **Designed, not yet shipped** describes a further pass over
> what the ledger already captures. (The whole §4 Discord surface — the
> Workbench, conflict cards, attribution, override DMs, rewind reactions, the
> stale-note flag — has since shipped; see
> [`reactions-and-versioning.md`](reactions-and-versioning.md).)

> **Room vs scope.** A task runs in its own Discord **thread**, opened from a
> top-level `@mention`. An interaction's `channel` field is that task **scope**
> (the thread, or a plain channel when there's no thread); everything task-bound
> keys on it — turn lineage, approvals, watches, the knowledge fold, the
> Workbench, the agent's session. The **room** is the parent channel, and it owns
> what is *not* per-task: the permission profile, the roster, the allowlist, and
> routing. `roomForScope` resolves a scope to its room, and permission
> classification always does so — a threaded task is governed by the same deny
> floor as a top-level one, never an empty profile.

---

## 1. What this gets you

Three things you didn't have before:

1. **Nothing is lost.** Every message, every tool the agent ran, every
   approval you clicked, every note an agent wrote — it's all kept, in order,
   with the cause of each step linked to the one before it. If you restart
   the relay mid-conversation, it picks up where it left off. If your
   collaborator joins from another machine, they see the whole history.
2. **You can ask "why did that happen?"** and get an honest answer. Not
   "the agent decided to do X" — but the actual chain: *Alice asked at
   14:03; bot-A read three files; bot-A ran `npm test`; Alice approved;
   the test failed; bot-A reported the failure.*
3. **You stay in charge.** If two agents try to change the same thing at
   once, you (the owner) win. The agent's draft isn't deleted — it's
   marked superseded and the agent is told. If you want to roll back to a
   point earlier in the conversation, you can.

---

## 2. Who goes first

knock-knock has three roles. They're **per-channel** — the same person can
be the owner in one room and just a human peer in another.

| Role | Who | What they can do |
|---|---|---|
| **owner** | The person who runs the bot | Always wins a tie. Approves tool runs. Can override anything. |
| **human** | Other registered humans in the room | Can talk to the bot, reset loops, but can't approve tool runs. |
| **agent** | Bots — yours and registered peers' | Can talk, propose work, request tool permissions. |

The rule is plain: **owner beats human beats agent**. If owner Alice and
agent bot-B are about to write the same paragraph of `report.md` at the same
moment, Alice's edit wins automatically. Bot-B's draft isn't thrown
away — it stays in the history, marked *superseded by Alice*, and bot-B is
told. Bot-B can pick it up on the next turn ("I see my draft was
overridden; the new text is X — should I rewrite based on that?").

When two agents tie (no owner around), they're flagged as a conflict and
shown to the owner for resolution. **§5 When two agents disagree** walks
through what that looks like.

---

## 3. What you see today

These are the visual cues already in the relay. They form a small,
deliberate vocabulary — once you learn the four glyphs and the two
locations (channel vs DM), you can read what's happening at a glance.

### 3.1 In the channel — quiet status cues

When you `@mention` a bot, you'll see one of these reactions appear on
*your* message:

| Glyph | Meaning |
|---|---|
| 👀 | The bot is working on it. Stays until the reply is posted. |
| (cleared) | The bot has finished and posted its reply below your message. |

When the bot needs your permission to run a tool, a fresh message appears
in the channel (or your DM, depending on whether the bot can reach you
directly):

```
ALICE-BOT  Today at 14:03
@alice  Permission request: Bash
        ```
        npm test
        ```
        [ Allow ✅ ]   [ Deny ❌ ]
```

Click **Allow** or **Deny**, or react ✅ / ❌. Only the owner's click counts;
anyone else who clicks gets a quiet "Not authorized" reply they can see.

After you decide, the message updates in place:

```
ALICE-BOT  Today at 14:03  (edited)
@alice  Permission request: Bash
        ```
        npm test
        ```
        ✅ Allowed
```

### 3.2 In your DM — the live transcript

While the bot is working, it edits a single message in your Discord DM in
real time. This is your private "control room" — a complete moment-to-
moment view that nobody else in the channel sees.

```
ALICE-BOT
─────────
▸ alice in #project-x
> can you check why the parser test is failing?

• Read `src/parser.ts`
• Grep `parseExpression`
• Read `tests/parser.test.ts`
• Bash `npm test`
  ↳ … pending
```

Then, after you approve:

```
ALICE-BOT (edited)
─────────
▸ alice in #project-x
> can you check why the parser test is failing?

• Read `src/parser.ts`
• Grep `parseExpression`
• Read `tests/parser.test.ts`
• Bash `npm test`

───
The test fails because `parseExpression` returns `null` on empty input
instead of throwing. I can fix it by adding an early throw, or update
the test to expect `null` — which do you want?
```

The message is edited (not re-posted), so it never spams your DM. If you
scroll back through your DM history, every past turn is preserved as a
final-state record. **This is the closest thing to a personal flight
recorder for your agent.**

If you've closed DMs to the bot, the live transcript disables itself
silently and you'll see a one-line note in the terminal where the relay
runs. The bot still works; you just don't get the live view.

### 3.3 In the terminal — operator notes

The relay prints one short line per noteworthy event to its terminal,
colour-coded per agent. Useful when you have several bots running.

```
alice-bot  ▸ alice in #project-x: "check why the parser test is failing"
alice-bot  → Read src/parser.ts
alice-bot  → Grep parseExpression
alice-bot  ✋ asks: Bash(npm test)  → prompt sent to dm
alice-bot  → Bash npm test
alice-bot  ◆ The test fails because parseExpression returns null…
alice-bot  ── turn done · 4 tools · 2.3s
```

If DMs are unreachable, the line reads `→ prompt sent to channel —
DM unavailable: ...` so you know why the prompt landed publicly.

---

## 4. The Discord surface (shipping today)

These visual cues surface ledger state that was always captured but used to have
no UI — **they have all shipped.** Each is paired with the exact ledger fact it
draws from. The operator-facing reference is
[`reactions-and-versioning.md`](reactions-and-versioning.md); the design rationale
below explains *why each cue draws from the fact it does*. (One thing changed
since this was written: each task now runs in its own **thread**, so "per
channel" below means **per task scope** — the thread.)

### 4.1 The "now working" pill (in-channel)

**Problem:** When two bots are active at once in the same channel, it's
hard to tell who's doing what.

**Shipped:** A single short pinned message per channel that each bot
edits as it works. Each line shows *who* and *what stage*:

```
WORKBENCH  pinned
──────────
• alice-bot  → tracing parser bug · 3 files read · waiting on Bash(npm test)
• bob-bot    → idle · last seen at 13:42
```

It's edited in place (not reposted) the same way the DM transcript is. A
bot only updates its own line. When a bot finishes, its line becomes
`idle · last seen at …`. The pin keeps it scrollable-back-to from any
position in the channel.

*Draws from:* the Turn fold and the LoopGuard fold (both shipping today).
*Surfacing:* a new `external` message per bot per channel, edited from the
synchronization that already runs on `turn.prompted` / `turn.replied`.

### 4.2 The conflict card (in-channel)

**Problem:** When two agents both edit the same paragraph or note at the
same moment, today the ledger records a conflict but nobody is told.

**Shipped:** When the merge step detects a same-anchor tie between two
agents, the relay posts a single channel message:

```
ALICE-BOT  Today at 14:17
🔀  Two drafts of `report.md` §X arrived together
    @alice — pick one or write the merge.

    A  @bob-bot wrote:
       > The parser supports nested expressions up to 8 levels deep.

    B  @charlie-bot wrote:
       > Nesting limit is 8 levels; deeper input raises a SyntaxError.

    [ Take A 🅰 ]   [ Take B 🅱 ]   [ Write my own ✏️ ]
```

Clicking **🅰** or **🅱** admits an owner-role write that supersedes both
drafts. Clicking **✏️** opens a thread reply prompt — the owner writes
their merge in the thread, and the relay turns the reply into a
`workspace.edit` keyed to the same anchor. Both losing drafts stay in the
ledger, marked superseded, and each agent gets the note in its inbox
(see §4.4).

*Draws from:* `mergeProposal` returns a `conflict` outcome with both
branches' hashes. The synchronization for "render a conflict card" is the
one new piece.

### 4.3 Attribution line (under every reply)

**Problem:** Long sessions become hard to trace. "Wait, why did the bot
take *this* path?"

**Shipped:** A small italic line under each agent reply, naming the
upstream cause and the tools involved:

```
ALICE-BOT  Today at 14:08
The test fails because `parseExpression` returns `null` on empty
input instead of throwing. I can fix it by adding an early throw, or
update the test to expect `null` — which do you want?

— traced from @alice's message at 14:03 · 4 tools · approved by @alice
```

It's the same `caused_by` chain the userflow test asserts is readable.
Click the timestamp link to jump back to the original message that
started this turn.

*Draws from:* `turn.replied.caused_by` already contains the prompt hash
and every executed tool hash. Rendering is one line.

### 4.4 The "your draft was overridden" inbox note (in DM)

**Problem:** If the owner overrides an agent's work, the agent's owner
isn't told what changed.

**Shipped:** When a `workspace.edit` or `knowledge.append` from agent
bot-B is superseded by a higher-role write, bot-B's owner gets a short
DM:

```
ALICE-BOT
─────────
🔁 Your draft was overridden in #project-x.

You wrote:
> The parser supports nested expressions up to 8 levels deep.

@alice wrote (and won):
> Nesting limit is 8 levels; deeper input raises a SyntaxError.

The original is preserved in the ledger. The agent has been told and
will pick up the new text on its next turn.
```

*Draws from:* the merge gate already writes a knowledge note to
`know:actor/<agentKey>/inbox` on every supersession. The DM is one
synchronization that subscribes to that artifact.

### 4.5 Rewind reactions (in-channel)

**Problem:** Sometimes you realise *after* approving that you wanted to
ask the bot something different first.

**Shipped:** A reaction vocabulary on any of the bot's messages:

| React with | Effect |
|---|---|
| ⏪ | "Rewind to before this message" — the next prompt is processed as if this and everything after never happened. The ledger keeps the rewound interactions; they just stop being part of the active frontier. |
| 🔁 | "Try this turn again, with the same prompt." Useful when a non-deterministic tool failed. |
| 🧷 | "Pin this as a checkpoint" — gives this point in the conversation a name you can come back to. |

A reaction on a message is just another interaction in the ledger, so this
is purely a new synchronization and a small frontier-management routine.

### 4.6 Stale-note flag (in the bot's replies)

**Problem:** When an owner invalidates an earlier fact ("actually, that
source was made up"), everything downstream that used it is silently
stale until the bot stumbles into it.

**Shipped:** The bot's next reply that touches stale knowledge carries
a visible flag:

```
ALICE-BOT  Today at 15:21
The §X section currently reads: "nesting limit is 8 levels…"

⚠️ Note: this section rests on `evidence:source-3`, which @alice
   invalidated at 14:55. The section is still in the file; the
   underlying source is marked stale. Should I re-derive from
   fresh sources?
```

*Draws from:* `annotateWithStaleness` on the Knowledge fold (shipping
today). The bot's prompt is fed the annotated knowledge view, so it's
already aware; the channel render just makes that visible to humans too.

---

## 5. When two agents disagree

The single most-asked question: *what actually happens when two bots edit
the same thing at the same time?*

**Today (the ledger handles it; the UX hint is missing):**

1. Both agents propose their edit. Both are stored with the same anchor.
2. The merge gate notices they're concurrent (neither caused the other)
   and at the same anchor.
3. Roles are compared. *Owner beats human beats agent.* The higher-role
   write becomes the live state; the lower-role write is marked
   superseded.
4. If the two writes have the **same** role (both agents), they go into
   a `conflict` state, awaiting an owner write that covers the same
   anchor.
5. The owner's later write at the same anchor resolves the conflict
   automatically — it's no longer concurrent (it's after them), and it
   outranks both.

**What the owner sees today:** a conflict held in the ledger, no visible
hint in Discord. *(This is the gap §4.2 fills.)*

**Symmetry by design:** Two collaborators on different machines see the
exact same outcome. The role-ordered merge is deterministic — given the
same set of interactions, every machine independently arrives at the same
winners and losers, with no extra coordination. (When two same-role writes
tie, the lower-hash winner is chosen as a stable tie-break.)

---

## 6. The ledger, in plain words

You don't need to know any of this to *use* knock-knock. It's here so you
can reason about edge cases ("if I restart the relay, what happens?",
"what does the bot actually remember between turns?").

**One thing is stored: a list of events, in order, each one linked to the
events that caused it.** Examples of events:

- "Alice sent a message in #project-x at 14:03"
- "bot-A decided to start a turn because of Alice's message"
- "bot-A asked permission to run `Bash(npm test)`"
- "Alice approved (causing the request above)"
- "bot-A ran `Bash(npm test)`, exit 1"
- "bot-A replied with text X (caused by the prompt + the test run)"

Every event has a unique fingerprint computed from its contents. Identical
events get the same fingerprint, so duplicates are silently merged — if the
same approval gets clicked twice, the second one is a no-op.

**Everything else you see is computed from this list.** The DM transcript,
the channel pinned status, the "what does the bot know" memory, who has
approval power right now — none of these are stored separately. They're
*projections* — like SQL views — that are recomputed by reading the event
list.

This is why **restart works seamlessly**: the relay just re-reads the
event list and rebuilds every view. It's also why **two machines can
collaborate**: they share the same event list (Postgres), and each one
independently rebuilds the same views from it.

---

## 7. The four things you can ask the ledger

Each of these is a fold — a function that reads events and returns a view.
They're available as APIs today; surfacing them as user-facing commands is
a small follow-up.

| What you want to know | Fold | Status |
|---|---|---|
| "What was said in this channel, by whom, when?" | `channel:transcript` | Shipping; powers DM render |
| "What did the agent do in turn X — every tool, every result?" | `turn:lifecycle` | Shipping; powers DM render |
| "Is there a pending approval right now?" | `approval` | Shipping; powers buttons |
| "What does the agent currently know? Which of those notes are stale?" | `knowledge` + `annotateWithStaleness` | Shipping; not yet exposed in UI |

A planned `/timeline` slash command would let you ask any of these from
Discord without leaving the chat.

---

## 8. Cross-machine — when your collaborator joins

You don't need to do anything. If both machines point their relay at the
same Postgres URL (via `KNOCK_KNOCK_LEDGER_URL`), the second one catches
up automatically — within an event-loop tick of the first write, the
second machine's views reflect it.

What you'll see:

- Your collaborator's bot replies appear in the channel as normal, with
  their bot's identity.
- The DM transcripts are private — you only see *your* agents' DMs, your
  collaborator only sees theirs.
- If your owner override beats your collaborator's agent's draft, their
  agent gets the inbox note (§4.4); their owner gets the DM.

The merge is **deterministic across machines** — both machines independently
arrive at identical winners and losers without any back-and-forth chatter.
If a tie is genuinely unbreakable (same role, same anchor, same moment),
both machines pick the lower-hash interaction as the winner, so they still
agree.

---

## 9. Glyph reference

A cheat sheet for the visual vocabulary. Most of these are shipping today
(channel-side); the conflict and rewind set are part of §4.

| Glyph | Where | Meaning |
|---|---|---|
| 👀 | Channel reaction on your message | Bot is working on this. |
| ✅ | Button / reaction | Approve a tool request. Owner only. |
| ❌ | Button / reaction | Deny a tool request. Owner only. |
| ▸ | DM message header | Header of a live turn transcript. |
| • | DM message body | One step the agent took (read, grep, bash, etc.). |
| ⚠️ | DM / channel | Something failed or is stale. |
| 🔐 | Channel approval prompt | "Permission request — I need your okay to run this." |
| 🔀 | Channel conflict card *(§4.2)* | Two same-role writes touched the same place. Owner picks. |
| 🔁 | DM inbox note *(§4.4)* | "Your work was overridden — here's what won." |
| ⏪ | Reaction *(§4.5)* | Rewind the conversation to before this point. |
| 🧷 | Reaction *(§4.5)* | Pin this point as a checkpoint. |

---

## 10. Frequently-asked questions

**Q. If the relay crashes mid-turn, do I lose the conversation?**
No. The ledger is on disk (or in Postgres). When the relay restarts, it
reads the event list and rebuilds every view. Any approval prompts you
already clicked are still resolved; any pending approval still shows the
buttons (clicking a pre-restart button does the right thing).

**Q. Can I see the full event list for a channel?**
Today, by reading the SQLite file at
`~/.knock-knock/ledger.sqlite` (or the Postgres table) and
running the listed queries. A `/timeline` slash command that prints a
human story is on the roadmap.

**Q. What happens if I delete a message in Discord?**
The Discord message goes away; the corresponding ledger event stays.
The ledger is intentionally append-only — it's an audit trail, not a draft
folder. If you want to take an action *back*, use rewind (§4.5) rather
than deletion. A rewound action is still in the ledger but no longer
contributes to the live view.

**Q. Can two of my own bots collaborate in one channel?**
Yes. The relay hosts as many bot identities as you configure; they treat
each other as peers (role: agent) with the loop guard preventing
runaway back-and-forth (default cap: 4 consecutive agent turns; an owner
or human message resets it).

**Q. Does the agent remember things between turns?**
Yes — by re-reading the ledger projections. The agent's context window
on turn N+1 is computed from the same channel transcript and knowledge
folds that you see in the DM. The agent doesn't have a separate hidden
memory; what it knows is exactly the projection of the events in the
channel up to that point.

**Q. If my agent makes a mistake, who's accountable?**
You. The role-ordered merge specifically encodes that **your machine
runs your agent's writes under your name, with your approval gate**. A
collaborator's agent never gets to run a tool on your machine. The
deny list is a hard floor: tools matching `deny` patterns never run
regardless of approval.

---

## Appendix — under the hood

For implementers and the very curious. `CLAUDE.md` at the repo root is the
working architecture map; this is the short version.

**The unit.** Each event is an *Interaction*: a record with `actor`,
`role`, `channel`, `target` (artifact + anchor), `verb`, `patch`,
`effect`, and `caused_by` (a list of parent interaction hashes). `channel`
is the task **scope** (a thread, or a plain channel); the parent **room** that
owns permissions is resolved from it at the host boundary (`roomForScope`), not
stored on the record. The hash is computed from the content — identical events
have identical hashes, which gives deduplication for free.

**Three kinds of artifact.** What you can patch:
- **Versionable** — files, structured documents. Patches are CRDT
  updates (Yjs). Concurrent edits at *non-overlapping* anchors both
  apply automatically.
- **Knowledge** — append-only notes. New observations always commute;
  invalidation cascades staleness down the causal chain.
- **External-proxy** — Discord messages, shell side effects, anything the
  ledger only models. A short-lived `Claim` serializes concurrent
  external writes.

**The merge.** When two writes hit the same anchor concurrently:
- External effect on either side → no merge; the claim serialized them.
- Different roles → higher role wins; lower role marked `superseded`.
- Same role → `conflict`; held until a higher-role write covers the same
  anchor.

**Concept folds (shipping today).** Channel transcript, turn lifecycle,
approval state, loop guard, knowledge with staleness annotation, and the watch
set (the deferred-continuation primitive).

**Synchronizations (shipping today).** Pure functions wired between the ledger
and Discord, one file each: `prompt-on-message`, `classify-on-tool-request`,
`drive-turn`, `post-on-reply`, `dm-on-supersede`, `conflict-card`,
`retry-on-reaction`, `resume-on-watch`, `apply-supersession`. Adding a new behaviour (critique, verify,
summarise) is one new file in `ledger/synchronizations/` and zero edits to
existing concepts.

**Storage.** `SqliteStore` (default, on disk) and `PgStore` (set
`KNOCK_KNOCK_LEDGER_URL`) implement the same interface. Postgres uses
`LISTEN/NOTIFY` to deliver new events to other machines within an event-
loop tick.

`NOTIFY` fires on **INSERT**, not UPDATE — so a *new* event crosses, but a
local lifecycle UPDATE (the merge gate marking a loser `superseded`) does
not. Cross-machine supersession therefore does **not** ride that UPDATE.
The winning interaction already carries `supersedes: [loserHash, …]` in its
row, and *that INSERT does cross*; the `apply-supersession` synchronization
re-derives the lifecycle change on each peer from that immutable field. This
is the same "converge from immutable INSERTs" pattern AOCM uses for file
edits, generalized to turn/approval/knowledge supersession — no hosted-DB
feature (no NOTIFY-on-UPDATE, no logical replication) is required. The local
UPDATE stays for fast local reads; convergence no longer depends on it. The
one residual limit is shared by *all* synced state: a `NOTIFY` missed while a
peer's listener is disconnected is healed by that peer's next restart-replay,
not in the moment — a transport property, not a merge one.

**The promise it keeps.** Every projection in the relay is reconstructible
from the ledger alone. A test (`userflow.test.ts` #9) asserts this end-to-
end: take a populated session, throw away every in-memory cache, build
fresh fold engines, and the result is byte-for-byte identical. If
anything ever drifts, that test fails first.
