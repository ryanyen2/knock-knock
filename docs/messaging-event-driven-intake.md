# Event-driven intake (webhooks) — opt-in, lower latency

knock-knock's default for every platform is **poll-based, no-inbound-server** intake:
Discord/Slack ride an outbound gateway WebSocket; GitHub/Notion poll their REST APIs.
A laptop with no public URL still receives events. This is the design thesis.

For the poll-based platforms (**GitHub ~60 s**, **Notion ~10 s**) you can opt into
**event-driven (webhook) intake** for near-instant delivery. This is the one place the
relay opens an *inbound* HTTP server, so it is strictly **opt-in** and **poll stays the
default**. Turning it on for one bot does not change any other bot.

```
platform  ──push──▶  forwarder/tunnel  ──▶  relay WebhookReceiver  ──▶  AgentHost.ingestWebhook
                     (gh / cloudflared)      POST /<platform>/<botKey>     → adapter parses → onMessage
```

## How it works

- **One process-wide receiver** (`src/webhook-receiver.ts`, a single `Bun.serve`) starts
  only when at least one bot is `intake: 'webhook'` (or `KNOCK_KNOCK_WEBHOOK_PORT` is set).
  It binds `127.0.0.1` by default — a forwarder/tunnel is the public front door.
- It routes `POST /<platform>/<botKey>` to that bot's `AgentHost.ingestWebhook`, which
  hands the raw body + headers to the platform adapter.
- The **adapter** owns parsing, signature/verification, and self-/dedup-filtering, then
  emits an `IncomingMessage` through the same `onMessage` path the poll loop uses — so
  everything downstream (gating, turns, approvals) is identical to poll mode.
- When a bot is in webhook mode, its **poll loop is not armed** (no double-delivery).

Config knobs:
- `Bot.intake: 'poll' | 'webhook'` in `access.json` (set by `knock-knock setup`).
- `KNOCK_KNOCK_WEBHOOK_PORT` — receiver port (default `8787`).
- Optional secrets (see below), stored in `.env`, resolved via the bot's `secretEnv`.

## GitHub — no public URL required

GitHub's CLI can forward a repo's webhooks straight to your localhost receiver — no public
endpoint, no tunnel:

```bash
gh extension install cli/gh-webhook        # once
gh webhook forward --repo <owner/repo> \
  --events issue_comment \
  --url http://localhost:8787/github/<botKey>
```

- `<botKey>` is the bot id from `access.json`. Keep `gh webhook forward` running alongside
  the relay (it's a dev/test tool; one forwarder per repo at a time).
- Latency drops from ~60 s to seconds.
- **Signature verification (optional):** set a webhook secret on the App/repo webhook and
  save it as the bot's `GITHUB_WEBHOOK_SECRET` (logical name `webhookSecret`). The adapter
  then verifies `X-Hub-Signature-256` and rejects mismatches with 401. `gh webhook forward`
  is unsigned, so leave it blank for the forward path.
- For a **GitHub App** webhook (production, signed) without a public server, front it with
  [smee.io](https://smee.io) instead of `gh webhook forward`.

Author gating is unchanged from poll mode: on a public repo only `OWNER` / `MEMBER` /
`COLLABORATOR` comment authors are auto-trusted (plus the owner + roster). See
`githubAssociationTrusted` in `lib.ts`.

## Notion — needs a public SSL URL (tunnel)

Notion webhooks require a public HTTPS endpoint (localhost is not reachable), so front the
receiver with a tunnel:

```bash
cloudflared tunnel --url http://localhost:8787      # or: ngrok http 8787
```

Then in the Notion integration (notion.so/profile/integrations → your connection →
**Webhooks → Create subscription**):

1. **Webhook URL**: `https://<your-tunnel-host>/notion/<botKey>`
2. **API version**: `2026-03-11`
3. **Events**: select **Comment** (the relay acts on `comment.created`).
4. Create. Notion immediately POSTs a one-time **verification token** to the URL — the
   adapter captures it automatically and echoes it back (you can also pre-seed it as the
   bot's `NOTION_VERIFICATION_TOKEN` secret). Once captured, each event's
   `X-Notion-Signature` is verified.

Notion payloads are ID-only, so the adapter fetches the comment body via REST before
emitting — still far faster than the 10 s poll, and it stops scanning the workspace.

## Security notes

- The receiver does **no** parsing/verification itself — that lives in each adapter, where
  the secret and payload shape are known. The receiver only routes by path.
- Binding `127.0.0.1` keeps the raw port off the network; the forwarder/tunnel is the only
  ingress. Use a webhook secret (GitHub) / verification token (Notion) so a leaked tunnel
  URL can't be used to inject events.
- Config is still terminal-only (`access.json` / `.env` are never written from chat), so
  webhook intake can't be enabled or pointed elsewhere by a message.

## When to use which

| | latency | inbound server | extra moving parts |
|---|---|---|---|
| **Poll** (default) | GitHub ~60 s · Notion ~10 s | none | none — pure local |
| **Webhook** | seconds | local `Bun.serve` (127.0.0.1) | GitHub: `gh webhook forward` · Notion: a tunnel |

Use poll for the zero-dependency local default; use webhook when you want fast turnaround
and can keep the forwarder/tunnel running.
