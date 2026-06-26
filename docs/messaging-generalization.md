# Messaging generalization — staying platform-neutral past Discord

Status: **implemented** (2026-06-26). Companion to
[`messaging-platforms-roadmap.md`](./messaging-platforms-roadmap.md) (which brings
platforms *online*); this doc records where knock-knock was **over-tailored to
Discord** and the tradeoffs taken to generalize it. The ledger/folds/syncs/AOCM
core is untouched — every change lives at the `MessagingAdapter` seam or the host's
inbound path.

## The two leaks

The seam (`messaging-adapter.ts`) + the capability-degradation layer
(`messaging-fallback.ts`) were built to absorb platform differences by branching on
`Capabilities`, never on a platform name. Two categories still leaked through to
every non-Discord adapter:

1. **Outbound text spoke one dialect.** `ledger/render/*` emits Discord-flavored
   markdown (`**bold**`, `*italic*`, `-#` subtext, `# headings`, `[t](url)`,
   `<@id>`). Discord renders it; the others did not. Telegram sent plain text with
   no `parse_mode`, Notion posted a single plain rich-text node, GitHub sent raw
   text — so `**`/`-#` showed literally. (Slack was the first symptom fixed.)

2. **The control plane assumed Discord-class affordances.** Approvals, conflict
   resolution, and session pick were reachable only via inline buttons or arbitrary
   emoji reactions; stop/retry/rewind/checkpoint were reaction-only. The text
   fallback (`parseChoiceReply`) existed but was **never wired into the host**, so on
   GitHub (no buttons; whitelist reactions that exclude the control glyphs) and
   Notion (no buttons, no reactions) those features were effectively dead.

## The contract (what future adapters inherit)

- **Discord is the canonical render dialect.** Renderers keep emitting it (richest,
  battle-tested, zero churn). **Each adapter translates at its `send`/`edit`
  boundary** — the seam's "adapter absorbs its platform's quirks" rule. New text
  dialects go in `adapters-msg/dialect.ts` (pure, unit-tested), not in the renderers.
- **Every interactive control degrades to text.** If a control is offered via a
  button or reaction, it MUST also be resolvable by a text reply (`parseChoiceReply`
  via the host's pending-prompt registry) or an owner text command. A platform with
  `buttons:false` + `reactions:'none'` must still be fully operable.
- **Capabilities, never platform names.** Degradation decisions read
  `Capabilities`; the core stays free of `if (platform === …)`.

## Per-feature × per-platform tradeoffs

| Feature | Discord | Slack | Telegram | GitHub | Notion | Generalization |
|---|---|---|---|---|---|---|
| Outbound markdown | native | mrkdwn | plaintext | GFM | rich_text nodes | `dialect.ts` translator per adapter |
| `-#` subtext | small text | strip | strip | strip | strip | only Discord has small text → strip elsewhere |
| `**bold**` / `*italic*` | ✓ | `*` / `_` | unwrapped | kept (GFM) | annotation node | **best fit**: rich where safe, plaintext where fragile |
| `[t](url)` | ✓ | `<u\|t>` | `t (u)` | kept | link node | per-dialect link form |
| `<@id>` mention | ✓ | `<@id>` | `@id` | `@login` | `@id` text | each dialect maps to its mention form |
| Approve ✅/❌ | button+reaction | button+reaction | reaction+text | text | text | `parseChoiceReply` wired into host |
| Conflict Take A/B | button | button | reaction+text | text | text | same text-choice route |
| Session pick | button | button | text | text | text | same text-choice route |
| Stop / Retry / Rewind / Checkpoint | reaction | reaction | reaction | `!stop` / `!retry` / `!rewind` / `!checkpoint` | same | owner text commands mirror the reactions |
| Status presence 👀🏁⚠️⏹ | reaction | reaction | reaction(wl) | reaction(wl) | none → silent | no-ops safely; **not** forced into text (noise) |
| Duplicate delivery | — | message+app_mention | offset overlap | poll/webhook retry | poll overlap | host `(scope,msgId)` dedup net |

**Why Telegram = plaintext, not MarkdownV2.** MarkdownV2 requires escaping ~18
characters in exactly the right places; a single miss makes the API reject the whole
message. The render layer emits a lot of punctuation (glyphs, `·`, `—`, `→`), so the
escaping surface is large and the failure mode is "message silently dropped." Clean
plaintext (markers unwrapped) is predictable and never breaks. GitHub, by contrast,
gets near-standard markdown for free, and Notion *must* be structured nodes anyway —
so "best fit" is rich for those two, plaintext for Telegram.

**Why status presence isn't forced to text.** On `reactions:'none'`, the presence
glyphs (👀 working, 🏁 done, ⚠️ failed, ⏹ stopped) already no-op safely
(`mapGlyphToReaction` → null). Turning each into a text line would add a message per
state transition — pure noise on a comment-threaded surface like GitHub/Notion. The
turn's outcome is already legible from the reply itself, so this gap is left as a
documented no-op rather than "fixed" into spam.

**Why a host dedup net on top of adapter dedup.** Slack's `message`+`app_mention`
double-event is genuinely Slack-specific and dropped cheapest in the adapter. But
*duplicate delivery* is a general hazard (poll/webhook retries, long-poll offset
overlap), so the host also dedups by `(scope, messageId)` before admitting. This is
**orthogonal to `reply-claim`**, which dedups *which agent* answers a message, not
*how many times one message was delivered*.

## Where it lives

- `src/adapters-msg/dialect.ts` — `toSlackMrkdwn`, `toTelegramText`,
  `toGitHubMarkdown`, `toNotionRichText` (+ shared code-stash / `-#` / emphasis
  primitives). Applied in each adapter's outbound boundary; Discord is untouched.
- `src/messaging-fallback.ts` — `parseChoiceReply` / `choiceMenuText` (unchanged;
  now actually consumed by the host).
- `src/agent-host.ts` — `dispatchAction` (shared by button + text paths),
  `tryResolveTextChoice` + the `PendingChoicePrompts` registry, owner
  `!stop`/`!retry`/`!rewind`/`!checkpoint`, and the `(scope,msgId)` dedup net.
- `src/host/context.ts` + `approvals.ts` + `host/conflict-ui.ts` +
  `host/session-sharing.ts` — register a choice prompt on post, clear it on resolve.
- Tests: `tests/adapters-msg/dialect.test.ts`, `tests/messaging-fallback.test.ts`.
