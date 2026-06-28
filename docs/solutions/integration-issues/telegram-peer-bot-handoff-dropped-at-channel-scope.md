---
title: "Telegram peer-bot handoff silently dropped at channel scope"
date: 2026-06-27
category: integration-issues
module: coordination
problem_type: integration_issue
component: tooling
symptoms:
  - "an addressed cross-machine handoff (`@next-bot — refine?`) is silently dropped on a plain (non-forum) Telegram group"
  - "the second machine's bot defers (\"I'll refine once it's in\") and then never engages with the draft"
  - "status-surface cards echo live `@handle`s that re-ping the named bots — the cross-machine mention cascade"
root_cause: scope_issue
resolution_type: code_fix
severity: high
related_components:
  - "messaging-adapters"
  - "agent-host"
tags:
  - telegram
  - peer-bot
  - cross-machine-handoff
  - channel-scope
  - suppress-mentions
  - coordination-gate
  - messaging-adapter
---

# Telegram peer-bot handoff silently dropped at channel scope

## Problem

A cross-machine bot handoff was silently dropped on Telegram. Bot A (machine 1) drafted a one-line summary and explicitly pinged its peer with `@next-bot — refine?`; Bot B (machine 2) deferred and never started a turn on the handoff. The same handoff worked on Discord and inside Telegram forum topics — it only vanished on threadless Telegram surfaces.

## Symptoms

- On a plain (non-forum) Telegram group, Bot A posted a draft and addressed its peer: `@tele_35_bot — refine?`.
- Bot B replied "I'll refine once it's in" and then went quiet — it never started a turn on the handoff.
- The defect was platform- and scope-specific: it worked on Discord and in Telegram forum topics, and only disappeared on threadless Telegram groups.

## What Didn't Work

The naive read — "the addressing check is broken, Bot B was mentioned but didn't fire" — is wrong, and the inbound gate in `src/agent-host.ts` (~lines 1042–1048) rules it out. The gate runs `peerBotStandsDownAtChannel(...)` **before** the addressing checks (`standDownForDirected`, then the `mentioned` check), so a `return` there kills the message before addressing is ever consulted. Tracing why control reached that early `return` led to scope: on a plain Telegram group, `startThread` calls `createForumTopic`, which throws (the group isn't a forum), so thread creation returns `undefined` and the task falls back to **channel scope** — `isThread = false`. There is no thread; the channel *is* the task scope. The old guard `peerBotStandsDownAtChannel(senderIsPeerBot, isThread)` dropped *every* peer-bot message at channel scope, so it killed the legitimate handoff along with the noise.

The tempting one-line fix — "just delete the guard" — is also a dead end, and the second defect is why. The guard was the *only* thing stopping a separate failure: the cross-machine status cascade. Telegram's `bodyText` (`src/adapters-msg/telegram.ts`) ignored `SendOpts.suppressMentions`. Telegram has no `allowedMentions`; it parses `@handle` straight from literal text (inbound detection in `toIncoming`: `text.includes(uname)`). Status surfaces (Workbench/billboard) echo the prompt verbatim and are sent with `{ suppressMentions: true }`, but on Telegram that flag was a no-op — the echoed `@handle`s stayed live and re-pinged the named bots. Discord never had this problem because it honors the flag via `allowedMentions: { parse: [] }` (`src/adapters-msg/discord.ts`). So the bug was two intertwined defects: a scope-blind guard, propped up by an adapter that silently dropped a `SendOpts` field.

## Solution

Fix both halves — make the guard branch on addressing, and make Telegram actually honor `suppressMentions`.

`src/lib.ts` — add `addressedMe` so a directed handoff engages even at channel scope:

```ts
// before
export function peerBotStandsDownAtChannel(senderIsPeerBot: boolean, isThread: boolean): boolean {
  return senderIsPeerBot && !isThread
}
// after
export function peerBotStandsDownAtChannel(
  senderIsPeerBot: boolean, isThread: boolean, addressedMe: boolean,
): boolean {
  return senderIsPeerBot && !isThread && !addressedMe
}
```

Call site in `src/agent-host.ts` passes `addressedMe`:

```ts
if (peerBotStandsDownAtChannel(senderIsPeerBot, m.isThread, addressedMe)) return
```

`src/adapters-msg/telegram.ts` — a new exported pure helper plus a one-line application in `bodyText`:

```ts
export function defangMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_])/g, '@⁠') // U+2060 WORD JOINER after @
}
// in bodyText, after toTelegramText(...):
const full = opts?.suppressMentions ? defangMentions(unwrapped) : unwrapped
```

## Why This Works

The two fixes are complementary because addressing and suppression are now the same axis. Defanging inserts a zero-width WORD JOINER (U+2060) immediately after each `@`. That single character does two jobs at once: Telegram no longer recognizes the token as a mention (so no ping), and a peer's inbound `text.includes('@handle')` no longer matches (so a status echo no longer reads as `addressedMe`). The text is still visually `@handle`.

So status surfaces — always sent suppressed — can never arrive at a peer as an addressed message, which means the guard is free to let *addressed* channel-scope messages through: the only things that reach the gate addressed are genuine replies (sent with the flag *off*, pings intact). The guard now drops exactly the unaddressed channel noise it was meant to drop, and the handoff — addressed, on a threadless surface where the channel is the only available scope — engages. This mirrors Discord's `parse: []`: suppression neutralizes the markup, real replies leave it live.

## Prevention

- **Every `MessagingAdapter` must honor the full `SendOpts` contract, or the platform-agnostic host policy silently breaks.** The host expresses one cross-platform intent ("don't let this status echo re-trigger anyone") via `suppressMentions`. When Telegram dropped that field, the host's policy was correct and the platform quietly defeated it — a failure invisible to the host. When adding a `SendOpts` field, audit *every* adapter for an explicit handling path; a field a platform "can't" support natively (no `allowedMentions`) needs an equivalent mechanism (defanging), not a silent skip. Note `mentionUser`/`mentionOnly` are still unimplemented on Telegram — the same class of gap, waiting to bite. A contract test asserting no adapter leaves a live mention under `suppressMentions` would catch the whole class.

- **Gate guards must not assume a task thread exists — branch on addressing, not `isThread` alone.** Threadless surfaces (plain Telegram groups, where `createForumTopic` throws) collapse task scope to the channel, so `isThread = false` does *not* mean "not a task." Any guard keyed only on `isThread` will eat legitimate channel-scope traffic on those platforms.

The shipped tests pin both regression paths:

```ts
// tests/lib.test.ts
expect(peerBotStandsDownAtChannel(true, false, false)).toBe(true)  // unaddressed peer at channel → stand down
expect(peerBotStandsDownAtChannel(true, false, true)).toBe(false)  // addressed handoff at channel → engage
expect(peerBotStandsDownAtChannel(true, true,  false)).toBe(false) // in-thread handoff → engage
expect(peerBotStandsDownAtChannel(false, false, false)).toBe(false) // human at channel → engage

// tests/adapters-msg/telegram-mentions.test.ts
// a defanged handle fails `text.includes('@handle')`; stripping U+2060 leaves visible text identical
```

The second and third `lib.test.ts` rows are the regression guards — exactly the handoff paths the original two-argument guard silently dropped.

## Related Issues

- `docs/how-coordination-works.md` (lines 97–100) — the "a bot replies to another bot only when directly tagged" rule this fix restores; mesh handoff narrative (lines 218–256).
- `docs/knock-knock-coordination.md` §3 — platform-neutral addressing (`mentionsBot`/`Capabilities.mentions`, never `<@id>` text), the contract the Telegram `suppressMentions` gap leaked. §8 line 185 ("Discord is the only live surface today") is now **stale** — Telegram ships and this bug is Telegram-specific.
- `docs/messaging-platforms-roadmap.md` (lines 149–162) — Telegram threading: `threads: true` only via forum topics; plain groups are threadless. This is the structural condition that exposed the bug.
- `docs/messaging-generalization.md` (line 51) — Telegram mentions render as `@id` text, which is why `suppressMentions` needs a literal-text defang there.
- GitHub issue #5 (open) — "only the first bot is answering" — plausibly the same or a sibling symptom; check whether this fix closes it.
