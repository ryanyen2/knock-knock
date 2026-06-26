# knock-knock — identity / setup / relay redesign

Status: **proposal** (planner round 1). Scope is the **config / identity / setup /
relay-UX layer**. The ledger core — Interaction DAG, folds, synchronizations, AOCM
merge, and the permission *classification* algebra in `lib.ts` (`classifyTool`,
`resolveProfileForActor`, `expandPreset`, `DENY_FLOOR`, the config-fold projection)
— is **preserved unchanged**. This is about how a human declares *who their bots
are, which projects they work in, and what they may do there* — and how the relay
makes that legible.

---

## 1. Vocabulary (locked)

The current code overloads several words. We fix the nouns first.

| Term | Definition |
|---|---|
| **Owner / me** | The human running this relay locally. Identified by a platform user-id per platform (`me.discord`, `me.slack`). Set **once**, reused as the default owner of every bot. |
| **Bot** | One coding-agent identity I run = one Discord/Slack *app* I created, holding a token locally. Its **name/avatar/description live on the platform** and are fetched live — never typed. Has a runtime. (Was: "agent" / `AgentConfig`.) |
| **Platform** | Discord, Slack, … A bot speaks exactly one platform. |
| **Channel** | A platform channel/group = **a project = a permission boundary**. The unit a bot is "invited" to. Globally keyed `${platform}:${channelId}` so two platforms never collide (also closes the ledger id-collision gap). (Was: "room".) |
| **Membership** | One of *my* bots active in one channel. **The permission boundary**: it carries this bot's **workspace folder** and its **allow/ask/deny** *for this project*. (New first-class object; was the implicit `agent.workspace` × `rooms/<key>/<channelId>.settings.json` pair.) |
| **Thread / Scope** | A task inside a channel; per-thread `!config` overlay (context/model/params). The channel is the inherited default. (Unchanged behavior; "scope" = thread-or-channel as today.) |
| **Roster** | Local address-book of known **people** (human collaborators) and **peers** (other people's bots), each entered **once** and referenced by id from channels. (New — eliminates re-pasting IDs.) |
| **Collaborator** | A roster reference attached to a channel: a human allowed to drive, or a peer bot present for discovery. |

**Room vs scope** — the split is real (a thread inherits its parent channel's
permission floor) but the word "room" is the confusing part. We rename **room →
channel** everywhere user-facing and keep **scope** as the internal thread-or-channel
id. `resolveRoomForScope` becomes `resolveChannelForScope`; the algebra is untouched.

---

## 2. Target conceptual model

```
me (owner): { discord: <my id>, slack: <my id> }

bots/ (apps I run, token-bearing)        roster/ (entered once, referenced by id)
  reviewer  ─ discord ─ token ─ runtime    people:  alice@discord, bob@slack
  builder   ─ slack   ─ token ─ runtime    peers:   carol-bot@discord "docs writer"
        │
        │ membership = (bot × channel): workspace + profile  ◄── permission boundary
        ▼
channels/ (projects)
  discord:#infra   ─ members[ reviewer→/repos/infra(strict), builder→/repos/infra(ask) ]
                     collaborators[ alice(human), carol-bot(peer) ]  requireMention
  discord:#web     ─ members[ reviewer→/repos/web(ask-per-edit) ]    collaborators[ alice ]
  slack:proj-z     ─ members[ builder→/repos/z(auto) ]               collaborators[ bob ]
        │
        ▼ thread (task) ── !config overlay: role / end-goal / model / thinking / effort / mode
```

The top-level object is **normalized**: bots, channels, and roster are sibling
tables; a channel references bots and roster entries by id. This is the key shift
away from `agents[key].rooms[channelId]` (where a shared channel is duplicated
across bots and there is nowhere to hang a roster).

### Proposed types (`lib.ts`)

```ts
export type Platform = 'discord' | 'slack' | 'telegram' | 'whatsapp' | 'imessage'

export type BotId = string      // stable local slug; NOT the platform display name
export type RosterId = string   // stable local slug for a person/peer
export type ChannelKey = string // `${platform}:${channelId}`

export type Bot = {
  platform: Platform
  tokenEnv: string               // NAME of env var holding the token
  appTokenEnv?: string           // Slack socket-mode app token env name
  runtime: string                // default runtime; a membership may override
  displayName?: string           // CACHED from platform on connect; cosmetic, non-authoritative
  blurb?: string                 // default capability text; a membership may override
}

export type Person = { platform: Platform; userId: string; label?: string }
export type Peer    = { platform: Platform; userId: string; blurb: string; label?: string }

export type Collaborator =
  | { kind: 'human'; id: RosterId }   // a person allowed to drive in this channel
  | { kind: 'peer';  id: RosterId }   // a peer bot present for discovery

export type Membership = {
  bot: BotId
  workspace: string              // folder THIS bot works in for THIS channel  ◄── per-(bot,channel)
  profile: RoomProfile           // allow/ask/deny (+ tiers) for this bot here
  runtime?: string               // optional per-channel override of Bot.runtime
  blurb?: string                 // optional per-channel override of Bot.blurb
}

export type Channel = {
  platform: Platform
  channelId: string
  label?: string                 // friendly project name for the TUI (cosmetic)
  project?: string               // optional cross-platform grouping label (cosmetic)
  members: Membership[]          // my bots active here
  collaborators: Collaborator[]  // humans + peer bots, by roster id
  requireMention?: boolean
  approvalActorId?: string       // override; defaults to the bot's owner (me)
}

export type Access = {
  me?: Partial<Record<Platform, string>>   // my user id per platform — set once
  bots: Record<BotId, Bot>
  channels: Record<ChannelKey, Channel>
  roster: { people: Record<RosterId, Person>; peers: Record<RosterId, Peer> }
  mentionPatterns?: string[]
  ackReaction?: string
}
```

**Why membership owns workspace + profile.** The user's own framing is "a channel is
the permission boundary — which folder a bot may work in." That boundary is *per bot
per project*: `reviewer` may have read-only `/repos/infra` in #infra and read-write
`/repos/web` in #web. Per-bot-global workspace cannot express this; per-membership
can, and it collapses two artifacts (`agent.workspace` + the profile file) into one
object. The profile keeps the exact `RoomProfile` shape, so `classifyTool` /
`resolveProfileForActor` / `DENY_FLOOR` are untouched.

---

## 3. Answers to the open questions

**(a) No server / local config.** There is no escaping that each operator declares
their own bots and tokens locally — tokens are secrets that must live on the machine
that runs the bot, and the platform has no channel to push them through. What we *can*
remove is the **repeated** local entry: the **roster** means a collaborator's id is
typed once and picked from a list thereafter; **`me`** means the owner id is typed
once; **live name-fetch** means bot names are never typed. So "each collaborator still
configures locally" stays true, but a second project with the same people is ~3
keystrokes (pick from roster), not a re-paste.

**(b) "Which bot is listening."** Today: all selected bots boot in one process and a
channel is claimed by whichever host sorts first — silently. New contract:
- One relay process, N bots (keep it — shares one ledger/fold engine; per-process-per-bot
  would fragment the ledger for no gain). `bun relay.ts [botId…]` / `--pick` still select.
- A bot listens in exactly the channels where it is a **member**. This is now
  enumerable, so the relay prints a **startup table** (see §6) and refuses to start
  silently mis-configured.
- A channel with **multiple of my bots** is legal (different roles). An @mention routes
  to the mentioned bot; see open decision #2 for the no-mention case.

**(c) Cross-platform channels.** A Discord human and a Slack bot cannot share one
channel — channel ids are platform-scoped and there is no bridge without a server. We
make this **honest**: a `project` label may group channels across platforms *for
organization/visualization only*; messages do not bridge. Bridging is explicitly out
of scope (would require the server we deliberately don't have).

**(d) Workspace granularity.** Recommend **per-membership** (see §2). Tradeoff: one more
field per channel a bot joins, vs. the ability to scope folders per project and a single
permission-boundary object. (Open decision #1.)

---

## 4. What survives / changes / is removed

| Current | Fate | Note |
|---|---|---|
| Ledger: Interaction DAG, `capture`/`admit`/`merge`/`fold`/`sync` | **keep** | untouched |
| AOCM file-edit convergence | **keep** | untouched |
| `classifyTool`, `DENY_FLOOR`, `PRESET_MODES`, `expandPreset`, `resolveProfileForActor` | **keep** | operate on `RoomProfile`; profile now lives in a membership |
| config fold + `projectChannelConfig` / `resolveTwoLayerConfig` / `resolveConfigFor` | **keep** | keyed by channelKey/scope; logic same |
| `resolveRoomForScope` | **rename** → `resolveChannelForScope` | same algorithm |
| `AgentConfig` (nested `rooms`) | **restructure** → `Bot` + `Channel` + `Membership` | the core change |
| `agent.workspace` (per-bot) | **move** → `Membership.workspace` | per-(bot,channel) |
| `rooms/<key>/<channelId>.settings.json` | **fold in** → `Membership.profile` | one file (access.json); both are terminal-only-written + read-live, so no invariant lost (later slice) |
| peer/human re-entry per room | **remove** → roster + pick-lists | |
| user-typed `agent.name`, `ownerUserId` per bot | **remove** → live-fetch name; `me` once | |
| `getAgentForChannel` first-match-wins | **replace** → membership lookup + mention-aware routing | |
| setup.ts agent-first wizard | **rewrite** → channel-centric TUI (§6) | |

---

## 5. Migration (`migrateAccess`, pure + tested)

A one-time, lossless reader. On load, if `access.json` has top-level `agents` (old) and
no `bots`, transform and write back (after backing up to `access.json.v1`):

```
for each [key, agent] in old.agents:
  bots[key] = { platform, tokenEnv, appTokenEnv, runtime, displayName: agent.name, blurb: agent.blurb }
  me[platform] ??= agent.ownerUserId
  for each [channelId, room] in agent.rooms:
    ck = `${platform}:${channelId}`
    channels[ck] ??= { platform, channelId, members: [], collaborators: [], requireMention: room.requireMention, approvalActorId: room.approvalActorId }
    channels[ck].members.push({ bot: key, workspace: agent.workspace, profile: readRoomSettings(key, channelId) })
    for each [peerId, info] in room.participants:
      rid = slug(info.name ?? peerId); roster.peers[rid] ??= { platform, userId: peerId, blurb: info.blurb, label: info.name }
      channels[ck].collaborators.push({ kind:'peer', id: rid })
    for each humanId in room.humans:
      rid = slug(humanId); roster.people[rid] ??= { platform, userId: humanId }
      channels[ck].collaborators.push({ kind:'human', id: rid })
```

Old per-channel profile files can be left in place until the inline-profile slice; until
then `Membership.profile` is populated by reading them during migration.

---

## 6. Setup TUI (channel-centric)

Main dashboard — a compact, always-visible map of the world:

```
 knock-knock                                   2 bots · 3 channels · 4 collaborators

 BOTS
   ● reviewer   discord   @ReviewBot#1234        claude-sdk
   ○ builder    slack     (not connected)        acp · codex

 CHANNELS  (project = permission boundary)
   #infra-prod  discord   reviewer ·strict· /repos/infra    + builder ·ask· /repos/infra
                          collab: alice(human) carol-bot(peer)     @mention required
   #web         discord   reviewer ·ask-per-edit· /repos/web       collab: alice
   proj-z       slack     builder ·auto· /repos/z                  collab: bob

 ROSTER
   people  alice @discord   bob @slack
   peers   carol-bot @discord  "docs writer"

 ›  [b]ot   [c]hannel   [r]oster   [p]ermissions   [t]okens   [l]edger   [q]uit
```

Flows:
- **Add channel** → pick platform → paste channel id (once) → pick member bots from the
  bot list → set each member's workspace + preset → add collaborators **by picking from
  roster** (or "+ new", which adds to roster). No id ever re-pasted.
- **Add bot** → pick platform → token env → runtime. Name is **fetched on
  first connect**, not asked. Owner defaults to `me[platform]` (prompted once, ever).
- **Roster** → list/add/edit people & peers; labels fetched live where the platform API
  allows.
- Status dots: ● connected (name known), ○ token present but not yet connected, ⨯ token
  missing.

---

## 7. Decisions (LOCKED by owner, 2026-06-24)

1. **Workspace** → **per-membership** (a bot scopes folder + profile per channel).
2. **Multi-bot routing** → **@mention routes to that bot; a bot also continues
   responding in threads/replies it owns.** A channel with a single member handles all
   its inbound (subject to `requireMention`). With >1 member: explicit @mention selects
   the bot; a reply/in-thread continuation routes to the bot that owns that thread; an
   un-mentioned brand-new top-level message is not auto-answered by everyone (no
   talking-over). Replaces first-match-wins.
3. **Migration** → **clean break, no migrator.** No existing users to preserve. The new
   normalized shape is the **only** format; **profiles are inlined** into
   `Membership.profile`; no dual-format readers; old `agents[]`/`rooms/` layout is
   removed. (Supersedes the migrator in §5 and folds in decisions #3/#4 below.)

### Original open decisions (for the record)

1. **Workspace granularity** — per-membership *(recommended: a bot can scope folders per
   project; one clean permission object)* vs. keep per-bot-global *(simpler types, but
   can't vary folder per project)*.
2. **Multiple of my bots in one channel, no @mention** — options: (a) only @mentioned bot
   responds; non-mention → nobody auto-responds *(recommended, least noise)*; (b) a
   designated "default" member responds; (c) all members respond *(loud)*.
3. **Breaking change vs. back-compat** — ship `migrateAccess` and adopt the new shape as
   the only format *(recommended; one migrator, clean code)* vs. keep dual-format readers
   indefinitely *(more code, slower cleanup)*.
4. **Profile storage** — fold profiles into `access.json` as `Membership.profile` *(one
   file, simplest mental model; recommended as an end-state slice)* vs. keep separate
   `rooms/<bot>/<channel>.settings.json` files *(smaller diffs, status quo)*.
5. **Cross-platform `project` grouping** — cosmetic label only *(recommended; honest
   about no bridging)* vs. drop the concept entirely for now.

---

## Follow-ups (post-review, owner-requested)

- **Storage moved to `~/.knock-knock/`** (was `~/.claude/channels/knock-knock`). knock-knock
  is agent-agnostic, so nesting state under *Claude's* dir was misleading and collided with
  the Claude Code harness's own `.claude/`. One shared store (not per-bot), keyed by bot.
  `KNOCK_KNOCK_STATE_DIR` still overrides. All docs/HTML updated.
- **Bot is a PORTAL, not tied to one coding agent.** `Bot.runtime` is the default;
  `Membership.runtime` overrides it **per channel** (same bot → `claude-sdk` here, `codex`
  there). Effective runtime = `Membership.runtime ?? Bot.runtime`, resolved in
  `getOrCreateSession` (also used for resume-compat + watch capability). Setup asks the coding
  agent per member; relay table + dashboard show overrides. **Terminal-written, not
  chat-settable** — runtime picks which local binary runs with workspace access.
- **Env lives in ONE place: `~/.knock-knock/.env`** — global, not per-cwd/per-channel. Set
  once, reused from any folder. (See the env-health additions in setup.)

## Status (engineering log)

- **Slice 1 — DONE.** `AuthoringAccess` + `Bot`/`Channel`/`Membership`/`Person`/`Peer`/
  `Collaborator` types and pure `projectToRuntime` added to `lib.ts`; `RoomConfig` gained
  optional `workspace`/`profile`. `state.ts` reads both shapes (`readAccessFile` projects
  the new shape; legacy honored as-is) and writes the new shape (`readAuthoringAccess` /
  `saveAuthoringAccess` / `parseAuthoringAccess`). 6 projection unit tests. typecheck + 183
  tests green.
- **Slice 2 — mostly DONE.** `getOrCreateSession` now uses the **membership workspace**
  (`room.workspace ?? agent.workspace`) and prefers the **inline profile**
  (`room.profile ?? readRoomSettings`); the audit path (`auditProfileForScope`) matches.
  `relay.ts` prints a **"who's listening where"** map and flags multi-bot channels. Green.
- **Slice 3 — DONE.** `setup.ts` rewritten channel-centric on `AuthoringAccess`: status
  dashboard, first-run wizard (bot → channel[members+workspace+preset+collaborators] →
  token → ledger), menu (add bot / add-edit channel / roster person+peer / token / ledger /
  remove). Owner id asked **once per platform** (`me`); bot names **not typed**;
  collaborators **picked from the roster**. Bundles clean; typecheck + 183 tests green.
- **Slice 4 — IN PROGRESS.** `CLAUDE.md` State-layout + Setup sections rewritten to the new
  shape/vocabulary. `docs/setup.md` + `README.md` + website delegated to a doc pass.
- **Review fixes (Slice 5):** (a) a legacy agent-keyed `access.json` is now backed up to
  `access.json.legacy` on first read before setup overwrites it (no silent data loss);
  (b) `pickCollaborators` persists real selections before looping through "+ add new".

### Independent UX review (Slice 5) — outcome
A read-only reviewer simulated the 5 core flows. Resolution:
- **"Mention routing incomplete" (claimed blocker)** — FALSE ALARM. `isMentioned` keys off
  `m.mentionsBot` = `msg.mentions.has(this._botUserId)` (`adapters-msg/discord.ts:310`), which
  is per-bot (each host owns its own client/token). A real @mention only passes the addressed
  bot's inbound gate, so only it admits (stamped `targetAgent`), and `prompt-on-message` routes
  to it. Routing IS complete for @mentions. (Generic `mentionPatterns` are not per-bot — a
  shared generic pattern can wake both bots; that's the documented "no require-mention →
  all respond" case, surfaced by the startup ⚠.)
- **Bot in no channel → vague skip** — FIXED. `relay.ts` now skips with "isn't a member of any
  channel" instead of "workspace not set".
- **Channel re-edit workspace default asymmetry** — FIXED. The prompt now marks `(saved)` vs
  `(new member — defaulting to cwd)`.
- Reviewer confirmed: projection handles no-member channels, channel-less bots, empty roster,
  and cross-platform collaborators safely; setup write-only / relay read-only isolation intact;
  roster reused across channels with no re-pasting.

### Known remaining gaps (tracked)
- **Slice 2b** — mention-aware routing (below).
- **Live bot-name display** — `Bot.displayName` is defined + shown but nothing writes it yet.
  Wiring it means caching the platform username on connect; doing so from the relay would
  bend the "only setup writes access.json" invariant, so it should land in a *separate*
  cosmetic cache file, not access.json. Deferred. (Not typing the name — the actual UX win —
  is already done.)
- ~~Roster entry removal~~ — DONE: setup now has "Remove a roster entry" (drops it from
  channels too). The bot surface has since been consolidated into a bot-centric
  **"Manage a bot"** bundle (rename key, owner id, token, add/remove channels with
  per-channel workspace/preset/collaborators, and coding-agent defaults — runtime/
  blurb), with bot removal inline. Management surface is complete: add/edit/remove
  for bots, channels, and roster + tokens + ledger.

  - **Remaining (Slice 2b):** mention-aware drive routing. Today `getAgentForChannel`
    picks the array-first serving host; the admitted `channel.message` doesn't carry the
    target bot. Fix: stamp the intended `agentKey` on the admission (the bot whose inbound
    mention-gate passed) and have `prompt-on-message` route to it instead of array-first.
    Single-bot channels are already correct; multi-bot is surfaced (startup ⚠) not silent.

## 8. Implementation slices (each independently green: `bun test` + `bun run typecheck`)

- **Slice 0 — types + migrator (no behavior change).** Add the new types in `lib.ts`
  beside the old; write pure `migrateAccess(old): Access` + unit tests (round-trip an old
  fixture). Nothing reads the new shape yet. *Lowest risk.*
- **Slice 1 — state.ts adopts new shape.** `readAccessFile` detects old shape, runs
  `migrateAccess`, backs up `access.json.v1`, writes new. Add resolvers
  `membershipFor(access, platform, channelId, botId)` and `botsListeningIn(access,
  channelId)`. Profiles still read from the per-channel files (populated at migration).
- **Slice 2 — relay + host adopt membership.** `relay.ts` iterates `bots`; each
  `AgentHost` resolves its channels/workspace/profile via membership; `resolveRoomForScope`
  → `resolveChannelForScope`; print the startup "who's listening where" table; replace
  `getAgentForChannel` first-match with membership + mention-aware routing (per decision #2).
- **Slice 3 — setup TUI rewrite.** Channel-centric dashboard + roster pick-lists + live
  name-fetch (per §6). Old menu actions re-expressed against the new shape.
- **Slice 4 — docs + website.** Rewrite `CLAUDE.md`, `docs/*`, and the website to the
  locked vocabulary (channel/membership/roster).
- **Slice 5 — inline profiles (per decision #4) + delete dead code.** Fold profile files
  into `Membership.profile`; remove `roomSettingsPath` once migrated.
```
