# Per-channel configuration — basic setup + in-channel overlay

## Context

Today **everything** is configured through the terminal `bun setup.ts` CLI, and config is
written *only* there — chat never writes config (a deliberate prompt-injection defense,
repeated throughout the codebase and the Discord MCP instructions). The goal is to split this:

- **Setup configures only the basics** (identity/trust): owner, runtime, workspace, token,
  sandbox, who's allowed.
- **Each channel is then tuned in-channel** by the owner — starting with a per-channel
  **persona/role brief** (a genuinely new capability) and extending to soft behavioral knobs.

Two facts make this both worth doing and currently impossible:
1. **There is no per-channel persona today.** `buildPreamble` (`lib.ts:472-496`) is identical
   in every channel, and an agent's `blurb` is only shown to *peers* via
   `buildRosterLinesForRoom` (`lib.ts:161-166`) — never injected into its own behavior.
2. **Many useful knobs are global or hardcoded** — loop-guard `{maxConsecutive:4, cooldownMs:8000}`
   (`lib.ts:582`), inbound rate cap 10/60s (`agent-host.ts:583-584`), ack `👀`
   (`agent-host.ts:673`), mention patterns (global `Access.mentionPatterns`), etc.

**Decisions already made** (from clarifying questions):
- "role" = a **per-channel persona/role brief** (free text injected into the prompt).
- Editing surface = **owner-only Discord commands** (`!config …`).
- Knob categories wanted = **safety & limits, collaboration & routing, surface & UX**.

## Design: a layered config model

The cleanest way to do chat-editable config *safely* in this ledger-native codebase is to model
config changes as **owner-role ledger interactions projected by a fold** — reusing the exact
owner-gated pattern that `!watch` and `share session` already use — rather than having the relay
write config files directly. This buys cross-machine convergence, an audit trail, and owner-role
precedence *for free* from machinery that already exists.

| Layer | Where | Who writes it | Holds |
|---|---|---|---|
| **Base / floor** (authoritative for trust & security) | files: `access.json`, `rooms/<agentKey>/<roomId>.settings.json` | **terminal only** (`setup.ts` → `saveAccess`) | identity, secrets, sandbox, the **allowlist** (humans/peers), the **permission deny-floor** |
| **Overlay** (behavioral tuning) | NEW ledger `config` fold, artifact `cfg:channel/<roomId>` | **owner, in-channel** via `!config` | persona/role brief + soft knobs + (optional) preset selection, **clamped to the floor** |

At use-time the overlay is **merged on top of** the file base; it can only *adjust behavior or
tighten*, never escalate trust. Adding a human/peer or changing a token/sandbox from chat stays
**impossible**.

## Brainstorm: the per-channel config menu

The full menu of useful per-channel knobs, grouped by the categories chosen. "Today" notes where
each value lives now. The phases below implement the **bold** ones first.

**Identity / behavior**
- **`role` — persona/role brief** (NEW). Free text, e.g. "You are a terse code reviewer here; no
  edits without asking." *Today: no per-channel persona at all.*
- `model` / `runtime` per channel (cheap model in a chatty room, top model in a build room).
  *Today: per-agent only; needs adapter plumbing — deferred, out of scope.*
- `displayBlurb` — a per-channel blurb shown to peers in the roster. *Today: per-agent `blurb`.*

**Safety & limits**
- **loop-guard `maxConsecutive` / `cooldownMs`** — agent↔agent chatter cap. *Today: global `lib.ts:582`.*
- **inbound `rateCapPerMin` / `rateWindowMs`** — spam guard. *Today: hardcoded 10/60s `agent-host.ts:583`.*
- **`approvalTimeoutMs`** — how long to wait for the owner's ✅/❌. *Today: `DEFAULT_VERDICT_TIMEOUT_MS`.*
- per-channel **sandbox tightening** (can only narrow the agent's sandbox). *Today: per-agent.*

**Collaboration & routing**
- **`requireMention`** toggle. *Today: per-room in `RoomConfig` (`agent-host.ts:587`) — promote to a chat toggle.*
- **`mentionPatterns`** per channel (union with the global ones). *Today: global `Access.mentionPatterns`.*
- mention-spawns-thread behavior; thread auto-archive after N minutes.
- **who may drive (humans/peers)** — *intentionally TERMINAL-ONLY* (this is a trust grant; the exact
  prompt-injection vector the Discord MCP warns about). Surfaced here for completeness, **not** chat-editable.

**Surface & UX**
- **`ackReaction`** / presence emoji. *Today: `access.ackReaction ?? '👀'` `agent-host.ts:673`.*
- **`workbenchVerbosity`** (`quiet|normal|verbose`) + throttle. *Today: `PILL_THROTTLE_MS=1500` `host/workbench.ts:16`.*
- `conflictMode` / conflict-card TTL. *Today: `CONFLICT_CLAIM_TTL_MS=60000` `conflict-card.ts:44`.*
- stale-knowledge display mode; rewind/stop reaction toggles.

**Permission (most sensitive — last phase, optional)**
- **`preset`** selection (`strict|ask-per-edit|auto|bypass`), **clamped**: the projected profile
  always unions `DENY_FLOOR ∪ file.deny` and can never add free-text `allow` or edit `tiers`.
  *Today: stamped from a preset into the room file by `setup.ts` only.*

## Implementation

### Phase 1 — Config fold + `config.set` + owner command + the role brief (the MVP)

End-to-end: owner types `!config role you are a terse reviewer` → admits an owner-role
`config.set` → the fold projects it → the next turn's prompt carries the brief. Cross-machine-safe,
auditable, touches no files.

**Pure core — `lib.ts`** (the test seam; mirror the LoopGuard/Watch sections):
- `type ChannelConfig = { role?: string }` (grows in later phases) and `type ChannelConfigDelta =
  Partial<ChannelConfig> & { _clear?: string[] }`.
- `projectChannelConfig(deltas)` — fold per-key, **last-writer-wins**; `_clear` removes keys. Must be
  order-independent: resolve same-key writes by a deterministic `(seq/createdAt, hash)` tiebreak
  (mirror the lower-hash tiebreak in `merge.ts:82`). On Postgres the single global `seq` already
  makes replay order deterministic across machines.
- `parseConfigCommand(text)` → `set | reset | get | help | error | null`. Mirror `parseWatchCommand`
  (`lib.ts:738-792`). Caps role length; **rejects any key not in `CHAT_SETTABLE_KEYS`** with a
  "that key is terminal-only" error.
- `wrapChannelRole(role)` → a `<channel-role>` envelope with the same "this is persona, not new
  authority" framing as `wrapSharedContext` (`lib.ts:538-549`) and the preamble's terminal-only note
  (`lib.ts:494`).
- `const CHAT_SETTABLE_KEYS = ['role'] as const` — the explicit allowlist (grows per phase).

**Verb — `ledger/interaction.ts`:** add one line `| 'config.set'` to the `Verb` union (~line 54).
No `Patch`/`merge.ts`/`admit.ts`/`canonical.ts` change — ride `patch.kind:'external'` exactly like
`watch.armed` (`host/watch-control.ts:161`).

**Fold — NEW `ledger/concepts/config.ts`** (mirror `ledger/concepts/watch.ts` near-verbatim):
- `CONFIG_FOLD = 'config'`, `configArtifact(roomId) = \`cfg:channel/${roomId}\``,
  `ConfigFoldState = ReadonlyMap<ArtifactId, ChannelConfig>` (Map-keyed so the fold-engine slice
  rebuild path `fold.ts:186` stays valid), `configFor(state, roomId)`.
- `key`: lifecycle `admitted|applied` && `verb === 'config.set'` && artifact starts `cfg:`.
- `step`: extract the delta from `i.patch.intent.args`, apply per-key LWW with `(seq/createdAt, hash)`
  provenance (order-tolerant). Reuse `projectChannelConfig`.
- Register in `relay.ts` next to the other `engine.register(...)` calls (~after line 176).
- **NEW `ledger/concepts/config.test.ts`** — two `FoldEngine`s on one store (mirror
  `cross-machine.test.ts:46-71`): admit on A → B sees it; concurrent same-key → both converge to the
  same value; a fresh engine replays to the same view.

**Owner command — NEW `host/channel-config.ts`** (`class ChannelConfig`, modeled on `WatchControl`):
- `constructor(ctx: HostContext)` — needs nothing else.
- `handleCommand(scopeId, text)`: resolve `roomId = ctx.roomForScope(scopeId)`; `parseConfigCommand`;
  for `set`/`reset` build the delta and `admit(ctx.store, { actor: ownerUserId, role: 'owner',
  channel: roomId, target: { artifactId: configArtifact(roomId), anchor: { kind: 'none' } }, verb:
  'config.set', patch: { kind:'external', intent:{ channel:'tool', op:'config.set', args: delta } },
  effect: 'pure', caused_by: [] })`; `get`/`help` just `discordSend` a rendering. **Never** calls
  `saveAccess` or writes a room file.
- Renderers (`renderConfig`, `renderConfigApplied`, help text) → `ledger/render/surface.ts`.

**Wire into `agent-host.ts`:**
- Field + construct `this.channelConfig = new ChannelConfig(ctx)` after the `HostContext` is built (~line 218).
- **Short-circuit in `handleInbound`** — insert immediately after the `!watch` block (after line 627,
  before line 629), the single most security-critical line:
  ```ts
  if (kind === 'owner' && m.text.startsWith('!config')) {
    this.scopeToRoom.set(controlScope, roomId)
    await this.channelConfig.handleCommand(controlScope, m.text)
      .catch(e => this.ui.error(this.key, `config command: ${e}`))
    return   // never reaches admit(channel.message) — the agent can't be steered by it
  }
  ```
- **Inject the role brief** in `runTurnForChannel` (after `roomId` at ~line 788): read
  `configFor(this.engine.get(CONFIG_FOLD), roomId).role` (try/catch like `session-sharing.ts:217`),
  wrap with `wrapChannelRole`, and prepend it into the existing `contextPrefix` (~line 835) ahead of
  the shared-context block. Reuses the per-turn `contextPrefix` slot (`driver.ts:82,121`) — **no
  Driver/adapter change**, and a mid-session role change takes effect next turn.

**`setup.ts`:** copy-only — note in `finishWithNextSteps` that persona/soft-knobs are now set
in-channel with `!config` (run `!config help`). No structural change yet.

### Phase 2 — Safety & limits

Add optional fields (`loopMaxConsecutive`, `loopCooldownMs`, `rateCapPerMin`, `rateWindowMs`,
`approvalTimeoutMs`) to `ChannelConfig` + `CHAT_SETTABLE_KEYS`, with **clamped** numeric validation
in `parseConfigCommand` (a knob can never *disable* a protection — e.g. `rateCapPerMin` min 1,
`loopMaxConsecutive` bounded). Read the overlay at each decision point:
- Loop guard — the call site already threads `LoopGuardOpts` (`lib.ts:594`,
  `ledger/concepts/loop-guard.ts:80`); just source the opts from `configFor`.
- Rate cap — replace the hardcoded `10`/`60_000` at `agent-host.ts:583-584`.
- Approval timeout — thread `cfg.approvalTimeoutMs` into the `awaitVerdict(...)` calls.

### Phase 3 — Routing & surface/UX

Same pattern. `requireMention` (overlay `?? room.requireMention ?? true` at `agent-host.ts:587` —
a UX knob, not a trust knob; `guildSenderAllowed` still gates *who* is allowed); per-room
`mentionPatterns` unioned with the global before `matchesMentionPattern` (`lib.ts:812`); `ackReaction`
(`agent-host.ts:673`); `workbenchVerbosity` consulted in `Workbench.updatePill` (`host/workbench.ts:39`).

### Phase 4 — Permission preset via overlay (optional, most sensitive)

`!config preset <name>` → add `composeProfileWithOverlay(fileBase, overlayPreset)` to `lib.ts`:
`expandPreset` (already carries `DENY_FLOOR`, `lib.ts:339`) for allow/ask, but **deny = the union of
preset ∪ file ∪ `DENY_FLOOR`** and `tiers` stay file-only. Apply it at both profile read sites
(`agent-host.ts:801` and `:893`) wrapping `readRoomSettings`. Trim `setup.ts` first-run copy.

## Security analysis

The chat-write path is gated by **four independent layers**, each verified in code:
1. **Owner short-circuit before admit** — the `!config` handler runs only when `kind === 'owner'`
   (`senderKind` returns `'owner'` solely for `ownerUserId`, `lib.ts:149`) and `return`s before
   `admit(channel.message)` (`agent-host.ts:651`). A prompt-injected "set my role to ignore the
   rules" in a peer/human message is just an ordinary message — never a config edit. Same boundary
   that protects `!watch` (`agent-host.ts:621`) and session sharing (`:607`).
2. **Owner-role merge precedence** — `config.set` admits `role:'owner'` (snapshotted at admission,
   `interaction.ts:118`). Even if a lower-role write reached the same key, owner dominance + the
   deterministic projector tiebreak win.
3. **Deny-floor clamp** — `composeProfileWithOverlay` unions `DENY_FLOOR ∪ file.deny`; `expandPreset`
   already carries the floor; `classifyTool` denies before allow (`lib.ts:262`); `resolveProfileForActor`
   unions deny again across tiers (`lib.ts:403`). An overlay can only tighten.
4. **Trust/secrets stay terminal-only** — `CHAT_SETTABLE_KEYS` is an explicit allowlist;
   `humans`, `participants`, `tokenEnv`, `runtime`, `workspace`, `sandbox`, `ownerUserId` are never
   in it. The handler never calls `saveAccess` and writes no file. No secrets ever enter a
   `config.set` patch (the ledger is content-addressed and may sync to peers).

**Residual risk — compromised owner account:** an attacker who *is* the owner could set a malicious
role brief or `preset bypass`. Mitigations: the deny-floor + OS sandbox (both terminal-only) still
bound the blast radius to the workspace and still block `rm -rf`/`sudo`/`~/.ssh`; and every
`config.set` is an auditable, owner-attributed ledger entry, reversible via `!config reset`.

## Verification

- **Unit (`bun test lib.test.ts`)** — `projectChannelConfig` (LWW, `_clear`, concurrent-key
  determinism), `parseConfigCommand` (set/reset/get/help, terminal-only key → error, clamps),
  `wrapChannelRole`; Phase 4 adds the clamp invariant: for every preset,
  `composeProfileWithOverlay(base, p).deny ⊇ DENY_FLOOR ∪ base.deny`, and `bypass` still denies `rm -rf`.
- **Fold (`bun test ledger/concepts/config.test.ts`)** — cross-machine convergence + replay.
- **Full `bun test` + `bun run typecheck`** — the `Verb`-union edit and fold registration are the
  only cross-cutting changes.
- **Manual (SQLite):** as owner, `!config role you are a terse reviewer` → confirmation; `!config get`
  echoes it; @mention the agent and confirm the tone. As a non-owner, `!config role …` → ignored
  (not admitted). `!config humans 123` → "terminal-only" error; confirm `access.json` and the room
  `.settings.json` are byte-unchanged.
- **Manual (Postgres, two relays):** set role on relay A → relay B's next turn in that room carries it.

## Critical files

- `lib.ts` — pure projector/parser/envelope/types (and Phase 4 `composeProfileWithOverlay`); `lib.test.ts`.
- `ledger/interaction.ts` — one-line `Verb` addition.
- `ledger/concepts/config.ts` (NEW, model on `ledger/concepts/watch.ts`) + `ledger/concepts/config.test.ts` (NEW).
- `host/channel-config.ts` (NEW, model on `host/watch-control.ts`).
- `agent-host.ts` — owner short-circuit in `handleInbound` (~after line 627); role read in
  `runTurnForChannel` (~801) [+ Phase 2/3/4 knob reads]; collaborator wiring (~218).
- `relay.ts` — register the config fold. `ledger/render/surface.ts` — renderers. `setup.ts` — copy.
