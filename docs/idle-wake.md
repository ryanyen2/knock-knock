# Daemon mode: idle bots that wake on message

By default `knock-knock relay` starts the bots you name (or all of them) as **active**:
each connects its messaging gateway and gets a live view. **Daemon mode** (`--daemon`,
alias `--wake`) adds a second tier — **idle** bots that are still connected and listening,
but spun down until someone messages them.

```bash
knock-knock relay --pick --daemon        # pick the active bots; the rest start idle
knock-knock relay reviewer --daemon      # reviewer active; every other configured bot idle
knock-knock relay --pick --daemon --tui  # …with the multi-pane view
```

## The model

The relay process **is** the daemon. In daemon mode it constructs and connects a host for
**every credentialed, channel-configured bot**, so all of them can hear messages. Only the
**picked** bots are *active* (they get a TUI pane / boot announcement); the rest are *idle*
and ride the footer's idle strip.

```
relay --pick --daemon
  ├─ active bots  → gateway connected · pane · ready
  └─ idle bots    → gateway connected · no pane · no coding-agent session
                      │
        message in an idle bot's channel (passes the usual gates)
                      ▼
                    WAKE → bot becomes active, gets a pane, drives the turn normally
```

**What "idle" costs.** Only the gateway connection (a heartbeat + a little memory). The
expensive part — the coding-agent runtime/session — is created lazily on the first turn
(`getOrCreateSession`), so an idle bot that is never messaged spins up nothing. This is the
accepted trade-off: to *hear* a message at all, a bot must hold its gateway open.

A bot still needs a token, a channel membership, and a workspace to be idle-listening — an
unconfigured bot can't hear anything, so it is skipped exactly as in non-daemon mode.

## The wake point

Wake fires in `AgentHost.handleInbound`, **right after** the inbound `channel.message` is
admitted (`agent-host.ts`, after the `inboundResult.kind !== 'admitted'` guard). By then the
normal gates have already run — allowlist (`guildSenderAllowed`), `requireMention`, the rate
cap, and reply-claim / targeting — so an idle bot only wakes for a message it would actually
answer. We do **not** wake every idle bot in a shared channel on one message; the same
turn-taking that elects a single responder decides who wakes.

On wake the host flips `active = true` and calls its `onWake` callback (set by the relay),
which promotes it to an active pane (`PaneTUI.activate`) or notes it on the console. The turn
then proceeds through the unchanged chain — reply-claim → drive-turn → lazy
`getOrCreateSession`. Wake is **quiet**: it posts no chat message (the inbound 👀 ack still
fires as usual).

## Relation to other flags

- `--pick` chooses the **active** set; in daemon mode everything else is idle. Without
  `--daemon`, unpicked bots simply don't start.
- `--tui` shows active bots as panes and idle bots in the footer strip; a woken bot's pane
  appears live.
- `--config` quick-config applies to the bots you picked (active), seeding their rooms before
  connect.

## Limits (v1)

- Daemon mode is **single-process** (the relay is the daemon); there is no detachable
  client/server attach model yet. The renderer seam (`RelayUI`) leaves room for one later.
- Idle is per-process: a bot configured to run on another machine should be launched there,
  not woken here. Daemon mode connects every bot *this* relay is credentialed for.
