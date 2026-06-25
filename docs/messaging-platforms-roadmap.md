# knock-knock — multi-platform roadmap (Slack · Telegram · GitHub · Notion)

Status: **plan** (research-backed, 2026-06-24). Scope is the **`MessagingAdapter`
seam and its surrounding host/setup glue** — bringing new "social platforms" online
as transports. The ledger core (Interaction DAG, folds, synchronizations, AOCM,
`classifyTool`/`DENY_FLOOR` algebra) is **preserved unchanged**: every platform is a
new file in `adapters-msg/` plus capability-driven degradation, exactly as the seam
was designed for (see `src/messaging-adapter.ts` header and `docs/redesign.md`).

---

## 0. The thesis (why this works at all)

knock-knock is serverless-yet-connected because it **borrows the platform's
infrastructure as its event bus**: Discord's outbound gateway WebSocket lets a
laptop receive events with no public inbound URL. So the gating question for any new
platform is not "does it have a bot API" but:

> **Can a local process receive events without exposing a public HTTPS server, and
> does its event/identity model project onto `IncomingMessage` / `IncomingAction` /
> `IncomingReaction`?**

That sorts the targets into the order of this roadmap:

| Platform | Local intake (no public server) | Fit | Phase |
|---|---|---|---|
| **Slack** | Socket Mode — outbound WS, a Discord-gateway twin | near 1:1 | 1 |
| **Telegram** | `getUpdates` long-poll | 1:1, minor degrades | 2 |
| **GitHub** | Notifications API polling (free 304s, `reason:"mention"`) | async transport | 3 |
| **Notion** | poll comments/DB (GA) + Workers bridge (cloud↔local) | bridge, see §Notion | 4 |

The two integration *shapes* the architecture already separates:

- **Transport** (`MessagingAdapter`) — the platform *is* the conversation surface
  and the free server. Slack, Telegram, GitHub.
- **Tool** (the agent's MCP/tools) — the platform is a *place the agent acts*.
  Notion MCP, GitHub `gh`/MCP. GitHub is **dual-use** (transport *and* tool — the
  agent-to-agent-over-issues idea).

---

## Phase 0 — Seam hardening (shared groundwork; do once, before any platform)

These are the only changes that touch shared code. Everything after is additive.

1. **Widen the `Platform` union** (`lib.ts:67`) from `'discord'` to
   `'discord' | 'slack' | 'telegram' | 'github' | 'notion'`, and the factory
   `makeMessagingAdapter` (`adapters-msg/index.ts`) to switch on each.

2. **Generalize credentials.** Today `AgentHost.start(token)` → `connect(token)`
   passes one token resolved from `Bot.tokenEnv` (`agent-host.ts:276`). Slack needs
   two (`xapp-`+`xoxb-`); GitHub needs a PAT or App key; Notion needs a worker/integration
   secret. Change:
   - Add `MessagingAdapter.requiredSecrets: string[]` (env-var *names* the adapter
     needs), keeping `connect` but passing a resolved `Record<string,string>`.
   - `Bot` config gains optional `secretEnv?: Record<string,string>` alongside
     `tokenEnv` (back-compat: Discord keeps the single `tokenEnv`).
   - The host resolves the named env vars and hands the adapter its bundle.
   *Pure, mechanical; no ledger touch.*

3. **Complete the capability-degradation audit.** The seam already branches on
   `Capabilities`, and `messaging-fallback.ts` already has `choiceMenuText`
   (buttons→numbered text) and `normalizeUnicodeReaction`. Verify and fill the
   gaps so a platform with `{buttons:false}` / `{reactions:'none'|'whitelist'}` /
   `{threads:false}` / `{mentions:'text'|'reply'}` degrades cleanly:
   - `buttons:false` → render `Choice[]` as a numbered menu; parse the user's
     text reply (`1`, or `/approve <id>`) back into an `IncomingAction`. (Action
     ids must survive round-trips — see Telegram 64-byte note.)
   - `reactions:'none'` → status presence (👀/🏁/⚠️/⏹) degrades to a short text
     line or an edited status footer instead of an emoji.
   - `reactions:'whitelist'` → map each `GLYPHS.*` to the nearest permitted emoji,
     else fall back to text.
   - `threads:false` → `startThread` returns undefined; host runs at room scope
     (already supported — `roomForScope` collapses).
   Add unit tests in `messaging-fallback.test.ts` for each degradation.

4. **setup.ts**: platform picker when adding a bot; collect the platform's secrets
   (masked); per-platform onboarding hints. The authoring shape already carries
   `me: Partial<Record<Platform, userId>>`, so the owner id per platform is free.

5. **Docs**: per-platform sections in `docs/getting-started-agents.md` (app
   creation, scopes/permissions, secrets) and a capabilities matrix.

**Exit criteria:** Discord still green on the full test suite; the fallback layer
has tests for every capability gap; `makeMessagingAdapter` rejects unknown
platforms with a helpful message.

---

## Phase 1 — Slack (`adapters-msg/slack.ts`) — the proof point

Socket Mode is the closest thing to Discord's gateway: `apps.connections.open`
(with the `xapp-` app token) returns a WebSocket URL; all events, button clicks
(`block_actions`), and slash commands flow over it. No public server.

**Library choice:** drive `@slack/socket-mode` directly + the Web API over `fetch`.
**Avoid `@slack/bolt`** — it has a known-broken path under Bun (slackapi/bolt-js
#2118, closed wontfix). The low-level socket package + `fetch` is well within Bun.

**Connect:** two tokens — `xapp-` (`connections:write`, opens the socket) and
`xoxb-` (all Web API calls). Call `auth.test` at startup for `botUserId`.

**Event translation:**

| Slack | → seam |
|---|---|
| `message.channels`/`groups`/`im`/`mpim` | `IncomingMessage` (`thread_ts` set ⇒ `isThread`) |
| `app_mention` | `IncomingMessage` with `mentionsBot:true` |
| `reaction_added` | `IncomingReaction` |
| `block_actions` (interaction payload over WS) | `IncomingAction` (`respond` via `response_url`; `update` via `chat.update`) |

**Capabilities:** `reactions:'any'`, `threads:true` (`thread_ts`), `buttons:true`
(Block Kit), `edit:true` (`chat.update`, bot-owned only), `pin:true` (`pins.add`),
`dm:true` (`conversations.open`+`chat.postMessage`), `mentions:'native'`,
`maxMessageLength:~3800` (4000 soft), `files:{inbound,outbound, maxBytes}`.

**Structure:** `startThread` → reply with `thread_ts`; `parentOf` → the thread's
channel id. **WS lifecycle:** handle the `disconnect`/`refresh_requested` message —
reconnect on the fresh URL (URLs rotate every few hours).

**Friction (all bounded):** two-token dance vs Discord's one; the 3-step file
upload v2 flow (`files.getUploadURLExternal`→upload→`completeUploadExternal`);
Socket Mode apps can't be Marketplace-listed (irrelevant for owner self-install).
Ship a `manifest.json` in setup to scaffold scopes:
`app_mentions:read, channels:history, groups:history, im:history, chat:write,
reactions:read/write, pins:write, files:read/write, connections:write`.

**Why first:** proves the seam generalizes with essentially zero core risk; it is
the platform the seam was explicitly modeled on.

---

## Phase 2 — Telegram (`adapters-msg/telegram.ts`)

`getUpdates` long-poll = perfect poll-as-push: the adapter loops, calls `onMessage`.
**Library: grammY** (official Bun support; tracks the latest Bot API; full types).

**Event translation:** `message` (mentions via `entities` type `mention`; replies
via `reply_to_message`), `callback_query` → `IncomingAction` (+ `answerCallbackQuery`
to clear the spinner; ephemeral-ish toast), `message_reaction` → `IncomingReaction`.

**Capabilities:** `maxMessageLength:4096`, `reactions:'whitelist'` (Telegram permits
a fixed emoji set — populate `reactionWhitelist`; map `GLYPHS.*` to nearest),
`threads:true` via **forum topics** (`createForumTopic` ⇒ `message_thread_id`;
group=room, topic=scope — maps 1:1 onto room/scope), `buttons:true` (inline
keyboards + `editMessageText`), `edit:true`, `pin:true` (`pinChatMessage`),
`dm:` *conditional*, `files:` 20 MB download / 50 MB upload (raise via a local Bot
API server if needed).

**Degrades to encode:**
- **`callback_data` ≤ 64 bytes** — knock-knock's `appr:`/`cflt:`/`sess:` ids may
  exceed it. Keep a per-process side table mapping a short token → the full action
  id (the adapter owns it; mirrors how Discord attachment handles stay host-side).
- **DM only to users who `/start`ed the bot** — `dm-on-supersede` and approval DMs
  degrade to an in-scope `@mention` reply for cold users.
- **Privacy mode** (default on) hides non-mention group messages — disable via
  BotFather for full visibility; document it.
- `message_reaction` needs the bot to be a **group admin** — note in setup.

---

## Phase 3 — GitHub (`adapters-msg/github.ts`) — local-relay polling

**Decision: local-relay polling, not GitHub Actions runners.** sepo-agent
(reference) runs the agent *inside ephemeral Actions runners*, threading state
through artifacts + `agent/memory` branches — cloud-native, no laptop, but a
*parallel runtime* that bypasses our ledger, warm ACP sessions, and OS sandbox.
knock-knock already is the long-running brain; making GitHub a transport reuses
**everything** (ledger, syncs, `AcpAdapter`, `sandbox.ts`). Notably sepo-agent
drives agents over **ACP via `acpx`** — the same protocol our `AcpAdapter` speaks —
so the agent-driving layer is already aligned; we differ only on *where the loop
lives*. (A future "dispatch heavy work to an Action via `workflow_dispatch`" mode
is a clean fast-follow, but not v1.)

**Intake (no public server):** poll `GET /notifications?participating=true` with
`If-Modified-Since`/`Last-Modified` (a 304 costs **no** rate quota) and obey
`X-Poll-Interval`. `reason:"mention"` flags direct @mentions first-class — no body
parsing. For each mentioning thread, fetch new comments since the last cursor.
Library: **Octokit**. Identity: a **GitHub App with webhooks disabled** (comments
as `name[bot]`, higher rate ceiling) or a **PAT machine-user** (simplest).

**Mapping:**

| GitHub | → knock-knock |
|---|---|
| repo | **room** (permission boundary; profile per repo) |
| issue / PR | **scope** (the task thread) |
| new comment | `channel.message` |
| bot reply | `POST .../issues/{n}/comments` |
| PR review thread | nested sub-scope (later) |

`startThread` → opening the conversation *is* the issue, so it returns undefined and
the host runs at issue scope (or, optionally, opens a tracking sub-issue).
`parentOf` → issue/PR ⇒ repo.

**Capabilities:** `buttons:false` (→ numbered-text choices via the Phase-0 fallback;
the user replies a number or `/approve <id>`), `reactions:'whitelist'` (GitHub's
fixed set: `+1 -1 laugh hooray confused heart rocket eyes` — map presence glyphs,
else text), `edit:true` (PATCH comment), `pin:false`, `dm:false` (no DM —
`dm-on-supersede` degrades to an `@mention` comment), `threads:` partial,
`mentions:'text'` (resolved via `reason:"mention"`), `maxMessageLength:65536`.
**Latency floor ≈ 60 s** (`X-Poll-Interval`) — right for async coding work, wrong
for live chat; document it.

**The elegant part:** GitHub is *only* the transport. The agent's actual work still
runs **locally** in the workspace under the existing sandbox, and the result is a
PR/commit + a reply comment. Code execution never leaves the laptop.

**Allowlist:** map `guildSenderAllowed` → GitHub's `CommentAuthorAssociation`
(OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR) + a collaborators-API check for weak
associations (the sepo-agent access-policy pattern). **Public repos are an open
prompt-injection surface — gating on author association is mandatory** (see
Security below).

**Dual-use (tool, orthogonal to transport):** give agents `gh`/GitHub MCP so they
can open issues/PRs and **@mention another bot** — two relays watching a repo's
notifications hand work to each other through comments. This is the
"agent-to-agent-over-issues" vision and needs no transport change, only tool config.

---

## Phase 4 — Notion — full Workers / Agent-SDK bridge

Notion shipped a real developer platform (3.5, May 2026): **Workers**
(Syncs/Tools/Webhooks, hosted TS runtime), an **Agent SDK** (alpha — names Discord,
Claude Code, Codex as targets), an **External Agents API** (alpha — Notion as
orchestration layer for third-party agents), and a hosted **MCP**. Custom agents are
autonomous and trigger-driven (DB row change, comment, schedule) but **cannot be
triggered by id from outside** — the outward seam is a Worker **Tool** the agent
*calls*. Notion is **Business/Enterprise**-tier.

**The connectivity reality (the crux for a local relay).** A Notion **Worker is
cloud-hosted**; our relay is **local with no public URL**. So the clean bidirectional
bridge has a reachability gap. Two ways to close it — ship both, default to (B):

- **(A) Reachable-relay bridge (full power, optional):** expose the relay behind a
  tunnel (cloudflared/ngrok) or a tiny opt-in HTTPS endpoint. Then:
  *Notion custom agent → Worker **Tool** → HTTP → relay intake* (Notion summons our
  agent), and *relay → Worker **Webhook** → Notion write-back*. Register the relay
  via the **External Agents API** once off the waitlist. Breaks "no server" purity,
  so it is **opt-in**.
- **(B) DB/comment-mediated polling (local-pure, GA today, default):** the relay
  **polls** Notion (REST `GET /v1/comments`, or a watched "relay-inbox" database;
  3 req/s) and **writes back** via REST. A Notion custom agent enqueues work by
  writing a DB row / comment; the relay picks it up on its poll and replies in
  place. Fully async, no inbound endpoint, no waitlist. This is the **GA substrate**
  the bridge sits on.

**Mapping:** database (or page) = **room**; a page / DB row = **scope** (the task);
its **comment thread** = the turn lineage; relay reply = `POST /v1/comments`.
**Mention detection:** Notion has no native "integration was mentioned" signal —
poll new comments and match the integration's name/id in the rich-text `mention`
nodes (encode in `mentions:'text'`).

**Capabilities:** `buttons:false`, `reactions:'none'` (→ text status), `threads:`
partial (comment threads; reply-only, can't open new threads via API), `edit:true`
(PATCH page/block), `dm:false`, `mentions:'text'`, files via the file-upload API.

**MCP-as-tool (ship first, GA):** wire the hosted Notion MCP as an agent tool so
agents read/write pages regardless of the transport — independently valuable and a
prerequisite for the bridge's write side.

**Landscape note (other programmable collaborative docs):** **Coda** (REST +
`POST /trigger` automation endpoint + Pack SDK + MCP) is the most mature *open*
API but has no autonomous-agent product; **Google Apps Script** (`doGet`/`doPost`
web-app endpoints + triggers + `UrlFetchApp`) is the most flexible HTTP seam in
Workspace (Gemini itself is closed); Slack canvas, Jupyter (`/api/kernels` execute),
Affine, Capacities are weaker or closed. **Notion Workers is the strongest
custom-agent target** — and the Agent SDK explicitly lists Discord as an embed
target, confirming this is on Notion's roadmap.

---

## Cross-cutting concerns

**Capabilities matrix (target):**

| | reactions | threads | buttons | edit | pin | dm | mentions | intake |
|---|---|---|---|---|---|---|---|---|
| Discord | any | ✓ | ✓ | ✓ | ✓ | ✓ | native | WS gateway |
| Slack | any | ✓ | ✓ | ✓ | ✓ | ✓ | native | Socket Mode WS |
| Telegram | whitelist | ✓ (topics) | ✓ | ✓ | ✓ | cold-fail | native | long-poll |
| GitHub | whitelist | partial | ✗ | ✓ | ✗ | ✗ | text (`reason`) | poll (≈60s) |
| Notion | none | partial | ✗ | ✓ | ✗ | ✗ | text | poll / Worker |

**Security (carries to every platform):**
- **Config is never settable from the surface** — `access.json`/`settings.json`
  written only by setup. New platforms inherit this prompt-injection invariant.
- **Untrusted input widens** — Slack workspaces, Telegram groups, and especially
  **public GitHub/Notion** are open injection surfaces. The sender allowlist
  (`guildSenderAllowed` → per-platform author identity / association) and the
  `DENY_FLOOR` + ask-first model are the defense; they apply unchanged because
  enforcement is scope→room and platform-agnostic.
- **Deny floor / secret globs** (`SECRET_PATH_GLOBS`) apply identically; file
  exchange honors `Capabilities.files` per platform.

**What is explicitly preserved unchanged:** the ledger, folds, synchronizations,
AOCM merge, `classifyTool`/`resolveProfileForActor`/`expandPreset`/`DENY_FLOOR`,
the Driver/Session/`AgentAdapter` layer, and the host's scope/room algebra. Every
phase is additive: new `adapters-msg/*.ts` + capability flags + setup glue.

---

## Suggested execution order & sizing

1. **Phase 0** (seam hardening) — small, shared, unblocks all.
2. **Phase 1 Slack** — small/medium; validates the whole thesis.
3. **Phase 2 Telegram** — small/medium; first poll-based + whitelist/degrade exercise.
4. **Phase 3 GitHub** — medium; new cadence (async) + the agent-to-agent payoff.
5. **Phase 4 Notion** — medium/large; ship MCP-tool + DB-polling (B) first, add the
   Worker/External-Agents bridge (A) when the alphas open.

Each phase ends green on `bun test` + `bun run typecheck` with Discord untouched.

---

## Implementation status (2026-06-24)

Phase 0 + all four adapter scaffolds landed in one coordinator-led pass.
**`bun run typecheck` clean; `bun test` 213/213; Discord + ledger untouched.**

| Piece | State | Files |
|---|---|---|
| Phase 0 seam | **done** | `messaging-adapter.ts` (+`requiredSecrets`, `connect(token, secrets)`), `lib.ts` (`Platform` union + `secretEnv`), `agent-host.ts` (secret resolution), `discord.ts`, `adapters-msg/index.ts` (factory: 5 platforms) |
| Slack | **adapter written** | `adapters-msg/slack.ts` (~494) |
| Telegram | **adapter written** | `adapters-msg/telegram.ts` (~504) |
| GitHub | **adapter written** | `adapters-msg/github.ts` (~546) |
| Notion | **adapter written** | `adapters-msg/notion.ts` (~454) |

"Adapter written" = implements the full seam, typecheck-clean against the real
SDK, intake needs no public server. Not yet exercised against live credentials —
each carries documented TODOs (below). The fallback layer (`messaging-fallback.ts`)
was already complete and is reused verbatim by every adapter.

---

## Cross-platform tradeoff evaluation (coordinator synthesis)

### A. The one convergent gap: buttons-as-text must be closed **once, in the host**

GitHub, Notion (and any `buttons:false`/whitelist platform) cannot deliver a native
`IncomingAction`. Each adapter therefore renders `Choice[]` as a `choiceMenuText`
numbered menu and the user's **reply arrives as an ordinary `IncomingMessage`**.
Today nothing turns that reply back into an action — so **approvals, conflict
cards, and session-pick are unreachable on the non-button platforms.** This is
platform-agnostic plumbing and must live in the host, not in four adapters:

> When the host sends a prompt with `choices` to a scope whose `Capabilities.buttons`
> is false, record `{scope → pending Choice[]}`. On the next inbound message in that
> scope, run `parseChoiceReply(text, choices)`; on a hit, synthesize an
> `IncomingAction` (`actionId`, `userId`, `ref`) and route it through the **same**
> `onAction` path the button handlers use. Clear the pending entry.

This is the **#1 next task** — it unblocks GitHub + Notion + degraded Telegram, and
benefits any future bare platform. It is the highest-leverage architectural item.

### B. Scope encoding diverged — keep scope→room adapter-mediated (never parse scope strings in the core)

The adapters had to encode "thread within room" differently because the platforms
differ: Slack `"${channel}:${thread_ts}"`, Telegram `"${chatId}:${topicId}"`, GitHub
`"${owner}/${repo}#${n}"`, Notion a bare page id. The core must therefore **resolve
scope→room only via `parentOf`/`parentOfSync`** (as it already does) and never
substring-parse a `ScopeId`. Audit item: confirm no host code splits scope strings
under an assumption baked from Discord (where thread = its own channel id). The
`parent:key` convention Slack/Telegram share is a convenience, not a contract.

### C. Identity & the public-surface injection floor

Discord/Slack/Telegram are invite-gated; **GitHub and Notion are open** — anyone can
@mention the bot or drop a comment on a shared page. The adapters deliberately do
**no** author gating. The host's existing `guildSenderAllowed` allowlist + `DENY_FLOOR`
+ ask-first model is the defense, but it must be wired per platform: GitHub →
`CommentAuthorAssociation` (OWNER/MEMBER/COLLABORATOR) + collaborators-API check;
Notion → the workspace/page share list. **Do not enable GitHub/Notion on a public
target until this is wired** (#2 next task).

### D. Per-adapter TODOs the coordinator tracked

- **Slack:** outbound files now advertise `files.outbound:false` (honest) — the
  3-step `files.getUploadURLExternal` upload flow is the TODO that flips it back to
  true; until then a share posts the `outboundFileNotice` text instead of silently
  dropping the file. `typing()` is a no-op (no Web API endpoint; presence rides 👀).
  `connect` now fails fast with a clear error if the `appToken` secret is missing.
- **Telegram:** `authoredByBot` returns false (getUpdates can't refetch arbitrary
  history) — host must rely on reply/@mention for directedness. `mentionUser` ping
  not rendered. `unreact` clears all bot reactions (Telegram semantics). **Reaction
  events carry no `message_thread_id`** → control reactions (✅/❌/🛑/🔁) on a task in
  a forum *topic* surface at room scope, not topic scope; fine top-level, may miss a
  per-topic turn/approval lineage (recovering it needs a message_id→scope table).
- **GitHub:** REST budget — Notifications 304s are free, but per-mention
  `listComments`/reactions burn the 5000/hr REST quota; watch with a real App token.
  GitHub App identity (`name[bot]`, higher ceiling) deferred; v1 is a PAT machine-user.
- **Notion:** `discoverPages()` scans every accessible page (3 req/s, injection-broad).
  Host should pass the explicit tracked `notion:<id>` channel ids so the loop polls
  only project boundaries (#3 next task). `edit()` returns false and `capabilities().edit`
  is now `false` to match (comments aren't updatable in-place) → caller re-posts.

### E. Platforms × coding agents (the matrix that actually matters)

A knock-knock deployment is **N bots × a runtime each** (`claude-sdk` / `claude-acp` /
`codex` / `opencode` / `gemini`), and platform is **orthogonal** to runtime — the same
bot can be `claude-sdk` on Discord and `codex` on a GitHub repo (per-channel
`Membership.runtime`). The seam separation holds; but three interactions are real:

1. **Sandbox is runtime-bound, not platform-bound.** OS confinement
   (`sandbox.ts`) only works with **ACP** runtimes. A GitHub/Notion bot acting on a
   public surface is exactly where you want confinement — so those bots should run
   `claude-acp` + `sandbox`, never the un-jailable in-process `claude-sdk`. *Platform
   risk and runtime choice are coupled through the threat model, not the API.*
2. **Approval UX degrades uniformly but routes per-runtime.** The buttons-as-text
   fallback (§A) must feed **both** approval paths — `claude-sdk`'s `canUseTool` and
   ACP's `classifyTool`-on-`requestPermission`. On GitHub/Notion an approval becomes
   "reply 1 to allow" in a comment; the host's synthesized `IncomingAction` must reach
   whichever path the bot's runtime uses. One fallback, two consumers.
3. **Cadence compounds with runtime.** GitHub's ~60s poll floor × a slow agent turn
   is fine for async PR work (codex/claude opening PRs) and wrong for live pairing.
   And AOCM file-edit convergence is still **Claude-Code-shaped Edit/Write only**
   (per CLAUDE.md) — so two agents converging on a file over a GitHub transport
   depends on the *runtime's* edit format, not the platform. Platform widens *where*
   collaboration happens; runtime still bounds *what* converges.

### F. Capability / cadence summary (decision shortcut)

- **Live, full-fidelity (buttons, reactions, threads, DM, files):** Discord, Slack.
  Use for interactive collaboration and approvals-heavy work.
- **Live, minor degrade (whitelist reactions, cold-DM, 64-byte callbacks):** Telegram.
- **Async, text-degraded (no buttons/DM/pin, ~60s):** GitHub — best for the
  agent-to-agent-over-issues pattern and PR-cadence coding, *after* §A + §C.
- **Async, heavily degraded (no reactions/buttons/DM/edit/files, 3 req/s):** Notion —
  honest verdict from the build: **better as an MCP tool than a transport**; use as a
  transport only when the conversation genuinely lives in Notion, and prefer the
  Worker/External-Agents bridge (needs a reachable relay) over comment-polling once
  the alphas open.

### Prioritized next tasks (post-scaffold)

1. **Host buttons-as-text → `IncomingAction`** (unblocks GitHub/Notion approvals; §A).
2. **Per-platform author gating** into `guildSenderAllowed` (GitHub/Notion safety; §C).
3. **Pass tracked channel ids to poll-based adapters** (Notion/GitHub scoping; §D).
4. **setup.ts**: platform picker + per-platform secret capture (`secretEnv`).
5. Live smoke test each adapter against real credentials (the SDK-payload field
   names are matched to docs, not types — one live run each).
6. Slack outbound file upload; GitHub App identity; Telegram local Bot API server.
