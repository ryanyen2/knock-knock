# Messaging platforms — making knock-knock multi-platform

knock-knock started as a Discord relay. This document defines the seam that lets
it speak **Discord, Slack, Telegram, WhatsApp, iMessage** — or anything a
contributor wants to add — without touching the ledger, the concepts, the
synchronizations, or the agent runtimes.

> **Just want to set one up?** Step-by-step per-platform onboarding — create the
> bot/app, the Slack manifest, which tokens go where, and what works vs doesn't —
> is in **[messaging-platform-setup.md](messaging-platform-setup.md)**. This doc
> is the architecture behind it.

The thesis: **the ledger core is already platform-agnostic.** The only thing
persisted is the append-only DAG of Interactions, and everything downstream is a
fold over it. Discord coupling is concentrated in exactly one layer —
`AgentHost` and its `host/` collaborators — and that layer already talks to the
rest of the system through narrow interfaces. We add a `MessagingAdapter` seam
*beside* the existing `AgentAdapter` seam and the relay becomes platform-neutral.

> **Do I need separate skills/plugins for each platform?** No. The Claude Code
> "channels" ecosystem (and OpenACP) run each platform as an out-of-process MCP
> server — a plugin model — because their core lives elsewhere and they only get
> a notification stream. knock-knock owns its own ledger-native relay, so the
> natural extension point is an **in-process adapter**, exactly like adding an
> agent runtime is "write one `AgentAdapter`." Adding a platform is **one new
> file** implementing `MessagingAdapter` + one factory line + a setup entry.
> (A future *out-of-process* `McpChannelAdapter` could be a single
> `MessagingAdapter` implementation that spawns any MCP channel server — that's
> the door to "any language", deferred. See [Extensibility](#extensibility).)

---

## 1. The seam: `MessagingAdapter` (mirror of `AgentAdapter`)

`agent-adapter.ts` is the contract the relay uses to talk to any **agent
runtime** (Claude SDK, ACP-driven Codex/Gemini/OpenCode). We add a parallel
contract for any **messaging platform**. Neither the ledger, the
synchronizations, nor `lib.ts` import a platform SDK — only the adapter and the
factory do.

```
agent-adapter.ts      AgentAdapter      → adapters/{claude-sdk,acp}.ts
messaging-adapter.ts  MessagingAdapter  → adapters-msg/{discord,slack,telegram,whatsapp,imessage}.ts
```

### Interface (shape, not final signatures)

```ts
interface MessagingAdapter {
  // lifecycle
  connect(token: string): Promise<void>
  disconnect(): Promise<void>
  readonly botUserId: string | undefined
  capabilities(): Capabilities

  // inbound (the host registers handlers; the adapter normalizes platform events)
  onMessage(h: (m: IncomingMessage) => void): void
  onAction(h: (a: IncomingAction) => void): void     // button / choice taps
  onReaction(h: (r: IncomingReaction) => void): void  // emoji on a message

  // outbound
  send(scope: ScopeId, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  edit(ref: MessageRef, text: string, opts?: SendOpts): Promise<void>
  react(ref: MessageRef, glyph: Glyph): Promise<void>
  unreact(ref: MessageRef, glyph: Glyph): Promise<void>
  pin(ref: MessageRef): Promise<void>
  dm(userId: string, text: string, opts?: SendOpts): Promise<MessageRef | undefined>
  typing(scope: ScopeId): void

  // structure (capability-gated — see §3)
  startThread(ref: MessageRef, name: string): Promise<ScopeId | undefined>
  parentOf(scope: ScopeId): Promise<ScopeId | undefined>  // thread → room
}
```

`SendOpts` carries the **platform-neutral interaction model** — the one piece of
real design work, because it's what conflict cards / approval prompts / session
pickers currently express as discord.js `ButtonBuilder`/`ActionRow`:

```ts
type Choice = { id: string; label: string; glyph?: Glyph; style?: 'primary'|'danger'|'neutral' }
type SendOpts = { choices?: Choice[]; mentionUser?: string; ephemeral?: boolean }
```

The adapter decides how to *render* `choices` for its platform (§3): native
buttons where they exist, tap-a-reaction where they don't, or a numbered text
menu where neither does — and routes the user's response back as an
`IncomingAction { actionId: choice.id, … }` regardless of how it arrived.

### Normalized inbound shapes

```ts
type IncomingMessage = {
  ref: MessageRef            // platform message id + scope
  scope: ScopeId             // thread/channel/chat the message lives in
  authorId: string
  authorName: string
  text: string
  directed: boolean          // "is this addressed to me?" — normalizes @mention / @bot / reply-to / 1:1
  replyToBotRef?: MessageRef // platform's reply-to, if it points at one of our messages
  isThread: boolean
}
```

`directed` is the key normalization: Discord uses `@mention`, Telegram uses
`@botusername` or reply-to, Slack uses `app_mention`, iMessage has no mentions
(every allowlisted message is implicitly directed). The host stops asking
`msg.mentions.has(botUser)` and asks `m.directed`.

---

## 2. The mapping table — concept ↔ surface ↔ ledger ↔ platform

This is the heart of the request: knock-knock's concepts, the Discord primitive
that currently expresses each, the underlying **ledger verb** (the real,
platform-agnostic truth), and how each lands on every platform. `✅`=native,
`~`=degraded fallback, `✗`=unsupported (text-command fallback).

| knock-knock concept | Discord primitive (today) | Ledger verb / fold | Discord | Slack | Telegram | WhatsApp | iMessage |
|---|---|---|---|---|---|---|---|
| **Channel / room** | text channel | `channel.message`, room = parent | ✅ | ✅ channel | ✅ chat/group | ✅ chat/group | ✅ chat |
| **Actor / member** | guild member | `actor` on Interaction | ✅ | ✅ | ✅ user id | ✅ phone id | ✅ handle/email |
| **Assign work to actor** | `@mention` | inbound `channel.message` (`directed`) | ✅ @ | ✅ app_mention | ~ @bot / reply | ~ text prefix | ~ implicit (1:1) |
| **Continue / branch action** | thread reply | `channel.message` in a sub-scope | ✅ threads | ✅ threads | ~ topics/reply | ✗ flat chat | ✗ flat chat |
| **Approve / reject permission** | ✅/❌ button or reaction | `tool.approved` / `tool.denied` | ✅ buttons | ✅ blocks | ✅ inline kbd | ~ reply buttons | ✗ `y/n <code>` text |
| **Action status** | 👀→🏁/⚠️/⏹ reactions | `turn.*` → Workbench fold | ✅ | ~ reactions | ~ whitelist | ✗ status in text | ✗ status in text |
| **Abort action** | 🛑 reaction | `turn.retry` (stop) + AbortController | ✅ | ~ reaction | ~ whitelist | ✗ `stop` text | ✗ `stop` text |
| **Take over / retry** | 🔁 reaction | `turn.retry` | ✅ | ~ reaction | ~ whitelist | ✗ `retry` text | ✗ `retry` text |
| **Rewind / checkpoint** | ⏪ / 🧷 reaction | `frontier.rewind` / `.checkpoint` | ✅ | ~ reaction | ~ whitelist | ✗ text cmd | ✗ text cmd |
| **Resolve conflict** | Take A/B/Write buttons | `merge.resolve` | ✅ | ✅ blocks | ✅ inline kbd | ~ reply buttons | ✗ `take A` text |
| **Import session context** | 📥 card + numbered buttons | `knowledge.append` (owner) | ✅ | ✅ blocks | ✅ inline kbd | ~ reply buttons | ✗ `pick N` text |
| **Notify on override** | DM to owner | `knowledge.append` → inbox | ✅ DM | ✅ DM | ✅ PM | ✅ PM | ✅ 1:1 chat |
| **Add / remove actors** | channel invite/leave + roster | (scope boundary; no verb) | ✅ | ✅ | ✅ admin | ~ group admin | ~ allowlist |
| **Attribution / stale flag** | subtext (`-#`) + ⚠️ | render from `caused_by` + knowledge fold | ✅ subtext | ~ italics | ~ italics | ~ plain | ~ plain |
| **Live activity (Workbench)** | pinned message, edited in place | `turn.*`/`tool.*` fold | ✅ pin+edit | ✅ pin+edit | ~ edit (no pin) | ✗ repost | ✗ repost/skip |

**Read this table as the spec for the fallback layer.** Every `~` and `✗` is a
capability the adapter declares missing, and a corresponding text/render
fallback the pure layer (`lib.ts` + `ledger/render/`) supplies. The **ledger
verb column never changes** — that's the whole point. A `take A` typed in
iMessage and a "Take A" button tapped in Discord both admit the identical
`merge.resolve` interaction.

---

## 3. Capabilities + graceful degradation

Each adapter declares what its platform can do; the host and the pure render
layer branch on capabilities, never on platform name.

```ts
type Capabilities = {
  reactions: 'none' | 'whitelist' | 'any'
  reactionWhitelist?: Glyph[]   // when 'whitelist' (Telegram's fixed set)
  threads: boolean              // native sub-conversations (Discord, Slack)
  buttons: boolean              // inline interactive components
  edit: boolean                 // edit an already-posted message
  pin: boolean                  // pin a message (Workbench)
  dm: boolean                   // private message to a user
  mentions: 'native' | 'reply' | 'text'
  maxMessageLength: number      // chunking (Discord 2000, Telegram 4096, …)
  experimental?: boolean        // true = walking skeleton, not live-certified
}
```

`maxMessageLength` is **load-bearing, not documentation**: `post-on-reply` chunks
outbound text at the *sending* platform's cap (less a small safety margin for the
appended annotations), so a Telegram reply splits at 4096 and a Slack reply at
3000 — never at a hardcoded Discord number. `experimental: true` marks the four
non-Discord adapters; the relay surfaces a loud startup warning for any agent on
one (see §7).

### Per-platform capability matrix

| capability | Discord | Slack | Telegram | WhatsApp | iMessage |
|---|---|---|---|---|---|
| reactions | any | any | whitelist | limited | **none** |
| threads | yes | yes | topics/reply | **no** | **no** |
| buttons | yes | yes | inline kbd | reply buttons | **no** |
| edit message | yes | yes | yes | **no** | **no** |
| pin | yes | yes | yes | **no** | **no** |
| DM | yes | yes | yes | yes | yes (1:1) |
| mentions | native | native | reply | text | text |
| max length | 2000 | ~3000 | 4096 | 4096 | ~unlimited |
| files (in/out) | **yes** | seam-ready* | seam-ready* | seam-ready* | **no** |
| experimental | no | **yes** | **yes** | **yes** | **yes** |

\* File exchange (`Capabilities.files`, `IncomingMessage.attachments`,
`SendOpts.files`) is **live on Discord only**. The seam is platform-neutral, but
the other adapters declare no file support yet: Slack needs the authed
`url_private` download + the new `getUploadURLExternal`/`completeUploadExternal`
upload flow (the old `files.upload` was sunset 2025-11-12); Telegram/WhatsApp
have media endpoints but aren't wired; iMessage has no file API. See
[`file-exchange.md`](file-exchange.md).

### The three degradation ladders

**1. Choices (approval / conflict / session cards).** One pure decision —
`renderChoices(choices, caps)`:
- `buttons` → native interactive components (Discord ActionRow, Slack blocks,
  Telegram inline keyboard, WhatsApp reply buttons).
- else `reactions !== 'none'` → post the prompt, attach one reaction per choice
  (numbered/letter glyphs), map the tap back to `choice.id`.
- else → append a numbered text menu and parse the reply. The pure
  `parseChoiceReply(text, pending)` turns `"2"`, `"deny"`, `"take A"`, or the
  Claude-channels-style `"n <code>"` into the matching `choice.id`. This is the
  iMessage path and the universal safety net.

**2. Status (reactions on the inbound message).** `👀→🏁/⚠️/⏹` is pure polish:
- `reactions === 'any'` → react as today.
- `reactions === 'whitelist'` → `mapGlyphToReaction(glyph, whitelist)` picks the
  nearest allowed emoji (👀 is in Telegram's set; 🏁 maps to ✅ or is dropped).
- `reactions === 'none'` → no status reaction; the Workbench line and the reply
  itself carry the outcome. **Nothing in the ledger depends on the reaction.**

**3. Threads (task scope).** Scope-per-task relies on `startThread`:
- `threads` → spawn a thread; scope = thread id (today's behavior).
- else → scope = channel (the chat itself). `resolveChannelForScope` already maps a
  channel to itself, so per-task isolation **collapses to per-chat** cleanly. The
  honest cost: parallel tasks in one bare chat share a transcript. Replies get a
  short task tag prefix so a human can still follow along. (Telegram forum
  topics / Slack threads recover real isolation where available.)

### The glyph problem (different emoji across platforms)

`GLYPHS` in `ledger/render/surface.ts` is the single visual vocabulary, defined
in unicode. As **message text**, every glyph renders everywhere. As
**reactions**, platforms diverge — Telegram only permits a fixed whitelist,
iMessage has no custom reactions at all. So glyphs split into two uses:

- **In text** (cards, attribution, the override DM, status suffixes): unchanged,
  universal.
- **As reactions** (status, owner controls): routed through
  `mapGlyphToReaction(glyph, caps)` — a pure function returning the
  platform-supported emoji or `null` (→ the control degrades to a text command,
  and the status degrades to text). The reserved-glyph contract (✅/❌ approval,
  🛑 stop, 📥 session) holds *only where reactions exist*; on bare platforms
  those interactions move to the text-command fallback, which is fine because
  the same ledger verbs back them.

**Inbound reactions need the inverse mapping too.** An owner reacting ✅/🛑/🔁 is
a *control* signal, and the host compares it against the project glyph vocabulary.
Outbound `mapGlyphToReaction` is lossy (several glyphs share one platform emoji),
so it isn't invertible — inbound gets its own explicit map in `messaging-fallback.ts`:
`normalizeUnicodeReaction(raw)` for platforms that surface unicode (Discord,
Telegram, WhatsApp, iMessage), and `normalizeSlackReaction(shortcode)` for Slack,
which delivers named shortcodes (`white_check_mark`, `octagonal_sign`) instead of
emoji. Each adapter normalizes at its inbound edge, so the host only ever sees a
project glyph; a non-control reaction (a casual 👍) normalizes to `undefined` and
is ignored. This closed a real gap: the host compared unicode glyphs while Slack
delivered shortcodes, so **every** reaction control (approve/deny, stop,
retry/rewind/checkpoint) was silently dead off-Discord until each adapter
normalized its own reactions.

---

## 4. What binds tightly to Discord — and how it's separated

Concentrated, by design, in the host layer. Each item below moves *behind* the
adapter; nothing in the ledger/sync/concept layers changes.

| Coupling point | File(s) | Separation |
|---|---|---|
| discord.js `Client` + intents | `agent-host.ts` | owned by `DiscordMessagingAdapter`; host holds a `MessagingAdapter` |
| `HostContext.client: Client` | `host/context.ts` | becomes `messaging: MessagingAdapter` |
| inbound `Message` parsing, mention check, thread spawn | `agent-host.ts handleInbound` | adapter emits normalized `IncomingMessage{directed,…}` |
| outbound `channel.send` | `agent-host.ts discordSend` | `messaging.send(scope, text, opts)` |
| ✅/❌ buttons + reactions | `approvals.ts` | post via `choices`; resolve via `onAction`/`onReaction` |
| Take A/B/Write buttons | `host/conflict-ui.ts` | `choices` + `onAction` |
| 📥 + numbered buttons | `host/session-sharing.ts` | `choices` + `onAction` |
| owner DM (override, approval) | `dm-courier.ts`, `agent-host.ts dmUser` | `messaging.dm(userId, text)` |
| pin + throttled edit | `host/workbench.ts` | `messaging.pin` / `messaging.edit` (capability-gated) |
| 🛑/🔁/⏪/🧷 reactions | `agent-host.ts` reaction handler | `onReaction` + glyph mapping; text-command fallback |
| `threadNameFromPrompt` (`<@!\d+>` regex) | `lib.ts` | mention-stripping becomes a per-adapter detail |
| hardcoded `intent.channel: 'discord'` | `agent-host.ts` | set from `adapter.platform` |

Everything else — `ledger/`, `ledger/concepts/`, `ledger/synchronizations/`,
`ledger/render/` (pure text), `lib.ts` decision logic, the permission model, the
Store, the `AgentAdapter` side — is **already platform-agnostic and unchanged.**

---

## 5. Phased implementation plan

Walking-skeleton order — prove the seam before scaling platforms.

1. **Seam** — `messaging-adapter.ts`: interface + neutral types. No behavior.
2. **Discord port** — `adapters-msg/discord.ts` wraps today's code; `HostContext`
   swaps `client` → `messaging`. **Zero behavior change; `bun test` +
   `bun run typecheck` stay green.** This is the proof.
3. **Fallback layer** — pure `lib.ts` helpers (`renderChoices`,
   `mapGlyphToReaction`, `parseChoiceReply`, `directed` detection), unit-tested.
4. **Slack** — richest after Discord (threads, blocks, reactions): exercises the
   full interface natively.
5. **Telegram** — whitelist reactions + inline keyboards + reply-threading:
   exercises the *whitelist* and *reply-mention* ladders.
6. **WhatsApp** — no threads, limited reactions: exercises *flat-chat* scope.
7. **iMessage** — no reactions/threads/buttons/edit: exercises the **full
   text-command fallback** — the real stress test of the abstraction.
8. **Setup + state** — `setup.ts` gains per-platform config; state dir grows
   `channels/<platform>/` siblings; `access.json` gets a `platform` field per
   agent.

Per platform the new surface is small: a `connect`/event-normalize path, a
`send`/`react`/`edit`/`dm` path, and a `capabilities()`. The cards, the merge
gate, the permission model, the Workbench logic — all reused verbatim.

### Status (2026-06-16)

| Step | State |
|---|---|
| 1 Seam (`messaging-adapter.ts`) | ✅ done |
| 2 Discord port (`adapters-msg/discord.ts`) | ✅ done — zero behavior change, all tests green, `discord.js` isolated to this one file |
| 3 Fallback layer (`messaging-fallback.ts` + tests) | ✅ done — includes inbound reaction normalization (`normalizeUnicodeReaction` / `normalizeSlackReaction`) |
| 4 Slack / Telegram / WhatsApp / iMessage adapters | ⚠️ **walking skeletons** — implemented, wired into `makeMessagingAdapter`, typecheck-verified, and now **explicitly gated as experimental** (`capabilities().experimental = true`), but still **not live-tested** (each needs real credentials; treat as unverified until you run it) |
| 5 Setup wizard | ✅ `bun setup.ts` asks the platform per agent (`AgentConfig.platform`), warns on non-Discord, and **requires an explicit confirm** to pick one |

Select a platform when adding an agent in `bun setup.ts`; `discord` stays the
default and omits the field. Picking a non-Discord platform takes an explicit
opt-in confirm, and the relay logs a loud experimental-platform warning at boot
for any agent on one — they never look production-ready by accident. Each
non-Discord adapter's file header documents its exact API mechanism and what is
real vs stubbed.

### Per-platform credentials

The bot token always lives in `.env` under the agent's `tokenEnv` name. Some
platforms read additional env vars (the setup wizard prints these as a hint):

| Platform | `tokenEnv` value | Extra `.env` vars | Notes |
|---|---|---|---|
| Discord | bot token | — | production |
| Slack | bot token `xoxb-…` | app-level token `xapp-…` (Socket Mode), in a **per-agent** env var named via `appTokenEnv`; falls back to global `SLACK_APP_TOKEN` | two-token model |
| Telegram | BotFather token | — | long-poll; reactions need a supergroup |
| WhatsApp | system-user access token | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_PORT` | inbound needs a **public webhook** |
| iMessage | (unused) | — | macOS-only; needs **Full Disk Access** to read `chat.db` |

---

## 6. Extensibility — add your own platform

1. Write `adapters-msg/<platform>.ts` implementing `MessagingAdapter`.
2. Declare honest `capabilities()` — the fallback layer covers every gap.
3. Add one line to the `makeMessagingAdapter(platform, …)` factory.
4. Add a setup branch for its token/credential.

No ledger, concept, synchronization, render, or permission change is required —
the same guarantee the `AgentAdapter` seam gives for runtimes. If you'd rather
write platform code outside the relay (or in another language), implement the
single deferred `McpChannelAdapter` once and point it at any MCP "channel"
server — the OpenACP / Claude-channels model, available as *one* in-process
adapter rather than a parallel architecture.

---

## 7. Honest limits

- **Bare platforms lose per-task threading.** Without native threads, concurrent
  tasks in one chat share a scope/transcript. Documented, not hidden.
- **iMessage is macOS-only and needs Full Disk Access** (reads `chat.db`); it
  cannot edit/unsend, so the Workbench reposts rather than edits.
- **Reaction-driven controls degrade to text commands** on whitelist/none
  platforms — the same ledger verbs, a less tactile surface.
- **Non-Discord adapters are experimental/opt-in.** They carry
  `experimental: true`, `bun setup.ts` requires an explicit confirm to pick one,
  and the relay logs an experimental-platform warning per agent at boot. Discord
  is the one production-tested surface.
- **Per-agent webhook-port isolation is deferred** for WhatsApp/iMessage. Two
  same-platform agents sharing a webhook/DB port collide; the relay detects the
  resulting `EADDRINUSE` at startup and names the port conflict (rather than
  mislabeling it a credential error), but giving each agent its own port is still
  a manual step.
- **The in-process `claude-sdk` agent runtime is orthogonal** to all of this;
  messaging platform and agent runtime vary independently.
