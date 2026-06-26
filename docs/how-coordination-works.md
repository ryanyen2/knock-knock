# How the bots work together (plain-language guide)

This is the friendly version. It explains, in everyday terms, how several bots in
the same chat manage to *not* trip over each other — answering once instead of all
at once, knowing what the others are up to, and splitting up a pile of work.

For the technical design, see `knock-knock-coordination.md`. This page is the one
to read first.

Throughout, imagine a chat with two bots, **Alice** and **Bo**, and a person,
**Sam**.

---

## The one idea everything is built on: a shared notebook

There is no central "boss" program telling the bots what to do. Instead, the bots
share **one notebook that they can all read and write**. Every message, every "I'm
on it," every answer — all of it gets written into the notebook, in order.

Because everyone reads the same notebook, nobody has to ask anybody else what's
going on. They just look. That single shared notebook is what replaces the server
we used to have.

> If the bots run on different computers, this only works when they're all writing
> into the *same* shared notebook (one shared database). Two bots with their own
> separate private notebooks can't see each other — there's no hidden link between
> them. Same notebook → they coordinate. Different notebooks → they can't.

---

## Problem 1: everybody answering at once

**Before:** Sam types "what's the status?" and *both* Alice and Bo answer. It's
like asking a question to a room and three people blurt out at the same time. Worse,
if Sam said "Alice, you take this one," Bo would often still chime in.

**Now:** when a message comes in, the bots don't just start talking. Each one that
*could* answer quietly tries to **grab a ticket** for that message — like taking the
single paper ticket at a deli counter. Only one bot can hold it. Whoever grabs it
answers; everyone else sees the ticket is taken and stays quiet.

So Sam gets exactly **one** answer, not a chorus.

A few natural variations, which you can pick with a setting:

- **First come, first served** (the default): whichever bot grabs the ticket
  answers. Simple and fair.
- **A designated front-desk bot**: you name one bot (say Alice) as the one who
  normally answers. The others only step in if Alice is away.
- **Seniority**: your own main bot answers before a guest bot does.

And if Sam *names* a bot ("Bo, can you..."), only that bot answers — no ticket
needed.

---

## Problem 2: knowing what the others are doing

Even if only one bot answers, the bots still benefit from knowing what the others
are busy with — so they don't redo the same thing or talk over each other.

So there's a **shared whiteboard**. When a bot starts something, it jots a quick
note: *"Bo — looking into the login bug."* When it finishes, it updates the note.

Before a bot replies, it glances at the whiteboard. If it sees Bo is already on the
login bug, Alice won't duplicate that effort. The whiteboard is just shared
awareness — a quick glance, nothing more.

---

## Problem 3: splitting up a pile of work

Say Sam writes: *"Set up five things: A, B, C, D, and E — and B can't start until A
is done."*

The five things go up on a board as **sticky notes**, one per task. Then:

- Any bot can **take a sticky note** it's able to do (the same "grab a ticket" idea
  — only one bot can hold a given note).
- A note that says *"wait for A"* stays parked until A is finished. The moment A is
  done, that note becomes available and a bot can grab it.

So the work flows in the right order — first things first, dependent things later —
**without anyone standing over it directing traffic**. The order is just a
consequence of which notes are available to grab.

When a bot finishes a task, it marks the sticky note done, which automatically frees
up whatever was waiting on it.

### Different ways to hand out the work

You choose the style that fits your team:

| Style | How it feels |
|---|---|
| **Free-for-all** | Whoever grabs a task does it. Good for equal peers. |
| **A lead assigns** | One bot hands specific tasks to specific bots. Good when you want a clear boss. |
| **Assembly line** | Tasks unlock one after another; each is picked up when its turn comes. |
| **Bidding** | Each bot says how well-suited it is; the best-suited one takes the task. |

It's the same board and the same sticky notes underneath — you're just changing the
rule for *who gets which note*.

---

## What if a bot crashes or goes silent?

When a bot grabs a ticket or a sticky note, the hold is **temporary** — like a hold
on a library book. The bot keeps the hold alive while it's actively working. If the
bot crashes, gets stuck, or just disappears, it stops renewing the hold, and after a
short while the hold **lapses**. Then another bot can pick the work up.

So work never gets permanently stuck because one bot wandered off.

(One honest limit: a bot that is *technically still running but frozen* can keep
holding on longer than ideal. Detecting "alive but stuck" precisely is a known
rough edge we plan to sharpen.)

---

## If you turn everything off and on again

The notebook is written to disk, so **turning the relay off loses nothing**. While
it's off, nobody can reach the bots — knock all you like, no one's home. But the
moment it starts back up, it reads the whole notebook back in, and every thread,
every task, every "who's doing what" note is exactly where it was.

There's a second kind of memory, though: the bot's own *train of thought* — the live
back-and-forth it was having inside a thread. That lives in the bot's head, not the
notebook. So when the relay restarts, knock-knock does two things so a bot doesn't
go blank:

1. **A returning bot picks up its real conversation.** Each time a bot finishes a
   reply, knock-knock quietly bookmarks where that bot was in its thinking. After a
   restart, the bot reopens that exact spot and carries on — same train of thought,
   nothing lost. (This works when it's the same bot using the same coding agent in
   the same folder; otherwise the bookmark is dropped on purpose, so it can't reopen
   the wrong thing.)

2. **A bot with no bookmark gets caught up from the notebook.** If there's no
   bookmark to reopen — the bot is brand new to this thread, or its coding agent
   can't reopen old sessions — knock-knock hands it a short **recap**: the recent
   messages in that thread, pulled straight from the notebook, so it can read the
   room before it answers instead of replying to a single message with no context.

## When a new bot joins a thread mid-conversation

This is just case 2 above. A freshly added bot has never seen the thread, so on its
first turn it's handed the recap — the prior back-and-forth from the notebook — and
the whiteboard of who's been doing what. So it can jump into an in-flight
conversation already knowing what's been said and decided, rather than starting cold
and asking everyone to repeat themselves.

---

## Remembering the relevant earlier conversation

When a bot starts working on something, it can **flip back through the notebook** to
the earlier messages that actually relate to this task — even from other threads —
and bring that context along. It ranks older messages by three simple signals:

- **How recent** it was,
- **Whether it's directly connected** to what's happening now (a reply, a follow-up),
- **Whether it's about the same thing or the same people** (overlapping words/names).

The point: a bot picks up a task already knowing the relevant backstory, instead of
starting from a blank slate and pestering everyone with questions it could have
answered by reading.

---

## Why do it this way (no central boss)?

Two reasons, both plain:

1. **Nothing single can break and take everyone down.** There's no central traffic
   director to crash. The shared notebook plus simple "grab a ticket" rules are
   enough for the bots to sort themselves out.
2. **Everyone agrees on what happened**, because everyone read the same notebook in
   the same order. Two bots looking at the same notes reach the same conclusion
   about who's answering and who owns which task — no negotiation needed.

---

## The whole thing in one breath

The bots share one notebook. To avoid talking over each other, they grab a ticket
before answering, so only one replies. They keep a shared whiteboard of who's doing
what. Big jobs become sticky notes on a board that bots claim and work in the right
order, and if a bot drops out its work frees up for someone else. And when a bot
starts a task, it reads back the relevant earlier conversation so it isn't starting
blind. No central boss, no server — just a shared notebook and a few simple,
fair rules.
