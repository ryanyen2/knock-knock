---
date: 2026-06-28
topic: cold-start-cross-platform-setup
focus: automate cross-platform onboarding — kill manual ID hunting, the "roster ≠ channel invite" trap, and the late "cross-machine needs a relay channel" surprise
mode: repo-grounded
---

# Ideation: Reducing Cold-Start / Cross-Platform Setup Friction

## Grounding Context (Codebase)

knock-knock is a local-first peer messaging/mesh CLI (TypeScript/Bun) bridging Discord, Slack, Telegram (GitHub/Notion in progress). Setup is an interactive wizard (`src/setup.ts`, ~1362 lines) that authors `~/.knock-knock/access.json` (bots, channels, roster{people,peers}), `.env` (tokens), `settings.json` (ledger backend).

**Current manual ID-gathering pain per platform:**
- Discord: token from dev portal (shown once); channel/owner/peer IDs via right-click "Copy ID" (Developer Mode required).
- Slack: `xoxb-` bot token + `xapp-` app token from two pages; `C…` channel ID; `U…` member ID from profile ⋯.
- Telegram: token from @BotFather; chat/user IDs via @userinfobot/@RawDataBot or `getUpdates` polling.
- Peer IDs exchanged out-of-band by hand.

**Mesh:** cross-machine coordination transport carrying ledger deltas (never chat). Needs a delegated transport channel; `⟦kk-mesh⟧` noise leaks into human channels if unconfigured; cross-machine intent only surfaces when adding a peer.

**Load-bearing fact (named by every ideation frame):** the runtime *already* has the machinery to make most of setup automatic, but the wizard doesn't wire into it:
- Adapters self-identify at connect — `slack.ts:128` calls `auth.test()` and discards all but `user_id`; Discord `/users/@me`, Telegram `getMe` are the analogues.
- `src/ledger/concepts/agent-directory.ts` auto-converges peer identities cross-machine into `peerDirectoryParticipants` "without manual roster entries."
- `lib.ts` `declaresPeerCollaborators` already detects cross-machine-peer-without-transport; commit `2ea0959` is the active seam for auto-enabling mesh + guiding to a transport channel.
- CONCEPTS.md defines the **Directory** as "discovered automatically rather than manually rostered" and **Peer bots** as auto-discovered — the design intent already leans zero-config; the wizard hasn't caught up.

**Constraint:** setup is terminal-only by design (config never settable from chat — prompt-injection defense). All survivors keep secrets terminal-side.

**Provenance caveat** (`docs/.../memory: mesh-provenance-binds-poster-to-actor`): directory beacons are currently unsigned; auto-importing peers from them must be gated behind explicit confirmation until Phase 3 signing lands.

## Topic Axes
1. Bot credential & install (tokens, OAuth, BotFather)
2. Self & channel identification (owner ID + channel IDs per platform)
3. Peer onboarding & roster bootstrap (peers into local roster + channel)
4. Cross-machine / mesh delegation (transport channel discovery + consistent config)
5. Verification & guidance (doctor, validation, progressive disclosure)

## Cross-Cutting Concerns for Planning

These two dimensions cut across every survivor and must be designed for explicitly (raised by the user when selecting ideas to develop):

**A. Collaboration topologies — each implies different trust/auto-import semantics:**
- *Co-resident peer bots* (multiple bots on one machine, shared `~/.knock-knock/` + localhost): cheapest discovery; arguably zero-config.
- *Same-owner cross-machine* (one person, laptop + server): high trust; aggressive auto-import / config propagation is safe.
- *Different-owner cross-machine* (two people's machines): trust boundary; auto-import must be confirm-gated, and provenance/signing matters most here.
- (Plus mixed: a team channel with several owners and several machines.)

**B. Cross-platform capability tiers** — the survivors lean on APIs that differ per platform; each needs a graceful fallback:
- Self-ID endpoint: Slack `auth.test` ✓, Discord `/users/@me` ✓, Telegram `getMe` ✓.
- Member enumeration: Slack `conversations.members` ✓ (full), Discord guild members ✓ (privileged intent), Telegram `getChatAdministrators` ✗ (admins only; privacy mode blocks full lists) → fallback to first-message capture.
- Channel creation (for auto-transport): Discord/Slack ✓ via API; Telegram ✗ → guided manual pick.
- The existing `MessagingAdapter` capability-degradation seam is the right place to model these tiers.

## Ranked Ideas

### 1. Token-first introspection — derive identity & channels from the token
**Description:** Ask for the bot token first, then call the self-identity endpoint the adapter already uses to confirm the bot, and call the "channels I can see" endpoint (`conversations.list` / guild channels / `getUpdates`) to present a channel **pick-list** instead of a paste-the-ID field. The token is the only thing that can't be derived; most things downstream of it can.
**Axis:** 2 (Self & channel identification)
**Basis:** `direct:` `slack.ts:128` already calls `auth.test()` and throws away all but `user_id`; `setup.ts:233` separately makes the human paste the channel ID. Capability exists, unused by the wizard.
**Rationale:** Removes the most-cited pain (hunting channel IDs) for the common case — channel becomes a menu choice.
**Downsides:** Bot must already be in the channel to list it; Telegram channel discovery weaker. Bot self-ID ≠ human owner ID (see #2).
**Confidence:** 90% · **Complexity:** Low · **Status:** Explored

### 2. Channel-membership → roster prefill (and "which of these is you?")
**Description:** Enumerate channel members (`conversations.members` / guild members / `getChatAdministrators`) and present them as a multi-select that writes `roster.people`/`roster.peers` directly, labels pre-filled, bots vs humans auto-classified. Owner picks themselves from the same list to set `me[platform]` — owner ID never typed. Manual entry stays as fallback.
**Axis:** 3 (Peer onboarding & roster bootstrap)
**Basis:** `external:` Slack `conversations.members` is the canonical auto-roster pattern. `direct:` CONCEPTS.md says peers are "discovered automatically rather than manually rostered," yet `setup.ts addPerson/addPeer` force manual `userId`; no member-list API is called in `src/adapters-msg/*` today.
**Rationale:** Dissolves the "channel invite ≠ roster" trap — being in the channel becomes being on the roster; kills the @userinfobot/Copy-ID detour for owner ID.
**Downsides:** Telegram exposes admins only (privacy mode); large channels need pagination; new adapter capability required.
**Confidence:** 82% · **Complexity:** Medium · **Status:** Explored

### 3. Directory-as-roster — adopt peers the mesh already converged
**Description:** Add a setup action "Adopt discovered peers" that reads the `agent-directory` projection and offers each peer not yet in the roster as a one-keypress add (blurb/platform/userId pre-filled from the self-published identity). For a second machine joining an existing mesh, peer entry drops to near-zero.
**Axis:** 3 (Peer onboarding & roster bootstrap)
**Basis:** `direct:` `src/ledger/concepts/agent-directory.ts` — this "lets co-resident AND cross-machine bots discover and address each other without manual roster entries." The runtime solved discovery; setup doesn't read its own directory.
**Rationale:** Lowest-effort/highest-leverage removal — data already converges; the wizard catches up to design intent. Complements #2 (humans via platform APIs; this covers peer bots via the mesh).
**Downsides:** Provenance caveat — unsigned beacons → confirm-gate auto-import until Phase 3 signing; only works after a first shared channel exists. Trust semantics differ sharply by topology (see Cross-Cutting Concern A).
**Confidence:** 85% · **Complexity:** Low–Medium · **Status:** Explored

### 4. `kk pair` — one short code for the whole cross-machine bootstrap
**Description:** Machine A runs `kk pair` → short speakable code encoding {transport channel id, A's agentKey, ledger pointer} (no secrets). Machine B runs `kk pair <code>` → derives transport channel, rosters A, matches mesh config. Optional Syncthing-style introducer propagates A's trusted roster.
**Axis:** 4 (Cross-machine / mesh delegation)
**Basis:** `external:` Magic Wormhole codes, Tailscale auth keys, Syncthing introducer. `direct:` `setup.ts:692-699` warns "add the SAME channel id on every machine."
**Rationale:** Collapses the silent two-machine failure ("did you both pick the same transport channel?") into one paste; code carries no token.
**Downsides:** Needs a bootstrap medium; introducer re-raises unsigned-provenance trust; careful scoping of encoded payload.
**Confidence:** 72% · **Complexity:** Medium–High · **Status:** Unexplored

### 5. Just-in-time mesh transport — detect intent, don't pre-ask
**Description:** Remove "delegated transport channel" from the upfront wizard. When the relay detects a cross-machine peer with no transport (via `declaresPeerCollaborators`), surface a single guided fix and write `meshTransport` itself — before `⟦kk-mesh⟧` leaks into a human channel.
**Axis:** 4 (Cross-machine / mesh delegation)
**Basis:** `direct:` `lib.ts` `declaresPeerCollaborators` exists "to decide whether a missing cross-machine transport is worth warning about"; `setup.ts:597-617` already does the one-off; commit `2ea0959` is the active seam.
**Rationale:** Removes the transport-channel concept from cold-start for single-machine users; presents it only to users who've earned the need.
**Downsides:** Auto-create needs channel-create permissions (Discord/Slack ✓, Telegram ✗ → guided prompt). Overlaps #4 (this is the reactive net; #4 the proactive path).
**Confidence:** 80% · **Complexity:** Low–Medium · **Status:** Explored

### 6. `kk doctor` — a round-trip preflight that proves the chain
**Description:** Per channel, verify the full path in one pass: token valid (self-ID resolves), bot actually in the channel, owner ID resolves, workspace path exists, and (if a peer exists) a mesh round-trip lands on the transport channel. Every red line carries the exact fix command.
**Axis:** 5 (Verification & guidance)
**Basis:** `direct:` `setup.ts:1257-1273` `finishWithNextSteps` infers from config shape only — never a live probe; `setup.ts:728` warns a workspace doesn't exist but never re-checks. `external:` `tailscale status`, Wi-Fi captive-portal checks.
**Rationale:** Cold-start failure is usually a *combination*; a live preflight is the difference between "looks configured" and "is configured" — and the natural acceptance gate for ideas 1–5.
**Downsides:** Network calls (needs offline-friendly subset); scope-creep on check count.
**Confidence:** 88% · **Complexity:** Low–Medium · **Status:** Explored

### 7. OAuth browser round-trip install — never see a token
**Description:** Replace copy-paste tokens with an install URL opened in the browser; platform redirects to a localhost loopback that captures the credential to `.env`. Slack returns `xoxb-` + `authed_user.id` (owner ID) in one callback.
**Axis:** 1 (Bot credential & install)
**Basis:** `external:` Slack OAuth v2, `gh auth login`, "Add to Slack". `direct:` `setup.ts:228-239` lists the three separate Slack sources this collapses.
**Rationale:** Removes the most error-prone manual step while keeping secrets off-chat.
**Downsides:** Per-platform OAuth app config + redirect URLs; Discord bot tokens aren't OAuth-issued the same way (uneven); loopback-server dependency.
**Confidence:** 65% · **Complexity:** High · **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| K | Owner-ID via first-message/react handshake | Folded into #2 (pick yourself from member list) + kept as Telegram-only fallback |
| H | Live token validation at entry | Folded into #6 `kk doctor` |
| I | Lazy/zero-setup bootstrap, bot-proposed next steps | Kernel folded into #5/#6; full version is a large architectural change + brushes terminal-only invariant |
| M | Human-handle resolution `@alice` / WebFinger | Pick-from-list (#2/#3) beats typing handles; selecting can't typo |
| N | Linked identity across platforms / configure-one-lights-all | Speculative — needs a new verified cross-platform identity primitive; better as a later brainstorm |
| O | Portable one-file config / eSIM-QR knock-card | Full version restructures config storage (scope overrun); useful non-secret skeleton already rides #4 |
| L | Referral/viral invite deep-link | Overlaps #4; landing-page variant adds web-hosting dependency beyond cold-start scope |
| — | Assume-mesh-always (reuse human channel as transport) | Revives `⟦kk-mesh⟧`-noise problem the project deliberately fought; conflicts with dedicated-transport design |
| P | Co-resident sibling auto-detect via local socket | Marginal vs. existing in-channel auto-discovery; narrow case |
| — | `kk capture` getUpdates scanner / Slack-only OAuth | Subsumed by #1 and #7 respectively |
