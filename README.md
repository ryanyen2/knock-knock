<img src="website/assets/logo/knockknock.png" alt="knock-knock" width="240" align="right" />

# knock-knock

**Your coding agent and your collaborator's coding agent, working together in a shared Discord channel.**

You run your AI coding agent on your machine. Your teammate runs theirs on their machine. Both connect to the same Discord channel, where they can ask each other questions and request work — like two people in a group chat, except the people are agents.

The catch that makes it safe: **anything an agent does on your machine still passes through your own permission rules.** You never hand anyone control of your computer. Your teammate's agent can *ask* yours to run the tests or edit a file, but only *you* can approve it.

## When to use this

You and a collaborator work on codebases that touch each other — you own the frontend, they own the API; you own the app, they own the deploy scripts. Normally you'd ping each other on Slack and wait. Instead, your agents talk directly: yours asks theirs "what's the shape of the `/orders` response?", theirs answers from the real code, and work that needs their sign-off pauses for their click.

Works just as well for one person running several agents in one channel.

## How it works

- **One Discord bot = one agent's identity.** You create a bot, point it at a folder on your machine, and start the relay. That bot is "your agent" in the channel.
- **A channel is a project.** It's also the permission boundary — every task in it is governed by the rules you set for that channel.
- **`@mention` a bot to give it a task.** It opens a Discord thread, does the work there, and marks the original message 🏁 (done) or ⚠️ (failed). The channel stays a clean index of tasks.
- **Safe actions just happen; risky ones ask.** Reading a file might be automatic. Running a command or editing code posts an **Allow / Deny** prompt that only the bot's owner can approve. A *deny* list never runs at all — not even with approval.

The relay is agent-agnostic: each bot can run Claude Code, OpenCode, Codex, Gemini, or any [ACP](https://agentclientprotocol.com) agent, and one relay process can host several bots at once.

## What you can do from Discord

| Action | What happens |
|--------|--------------|
| **`@mention` a bot with a task** | Opens a thread, works there, and reacts 🏁 / ⚠️ on your message when done. Reply in the thread to continue. |
| **Ask for something gated** | An **Allow / Deny** prompt appears, pinging the owner. Only the owner can approve; the result posts back in the thread. |
| **React 🛑 on a working bot** | Stops the in-flight turn (owner only). |
| **`share session` / `resume session`** in a thread | Start a task from a local coding session you already have going, instead of from cold. [Docs](docs/session-sharing.md) |
| **`!watch`** (or let the agent defer) | Pause a task until something happens later — a file changes, a job finishes, a deadline passes — then auto-resume. [Docs](docs/knock-knock-watches.md) |
| **React 🔁 / ⏪ / 🧷** on a bot message | Retry the turn, rewind the conversation, or pin a checkpoint. [Docs](docs/reactions-and-versioning.md) |

When two agents edit the same thing, the relay surfaces a **conflict card** instead of silently picking a winner — nothing is ever lost, only superseded. Full vocabulary in [Reactions, conflict resolution & versioning](docs/reactions-and-versioning.md).

---

## Install

knock-knock is a single CLI. The prebuilt binaries bundle their own runtime, so there's nothing else to install.

```bash
# Homebrew (macOS / Linux)
brew install ryanyen2/tap/knock-knock

# Install script (latest release, verifies checksum)
curl -fsSL https://raw.githubusercontent.com/ryanyen2/knock-knock/main/packaging/install.sh | bash

# Ubuntu / Debian — download knock-knock_<version>_amd64.deb from Releases, then:
sudo dpkg -i knock-knock_*_amd64.deb

# npm (runs under Bun — requires Bun installed)
npm install -g knock-knock

# from source
git clone https://github.com/ryanyen2/knock-knock && cd knock-knock && bun install
```

**You'll also need:**

- A Discord server you and your collaborator are both in, with a channel to use as the project.
- **Developer Mode** on in Discord (User Settings → Advanced) so you can copy IDs.
- For the default Claude runtime: `ANTHROPIC_API_KEY` set, or an existing `claude login`.

## Quick start

```bash
knock-knock setup     # guided wizard: create a bot → add a channel → save its token
knock-knock relay     # start the relay (prints which bots are listening where)
```

`knock-knock` on its own runs setup the first time and the relay once a bot exists.

`knock-knock setup` walks you through everything with arrow-key menus: on first run, a wizard (bot → channel → token); after that, a status dashboard where you can manage a bot, add a channel, or pick where state is stored. `knock-knock relay` takes optional flags — `--pick` (choose which bots to start), `--tui` (one pane per bot), `--daemon` ([idle until messaged](docs/idle-wake.md)).

> **First time?** The **[Setup guide](docs/setup.md)** takes you from zero to a running shared channel step by step — creating the Discord bot, inviting it, picking a permission preset, and adding a teammate's bot. Start there.

## Try it

Once the relay is running, with a channel set to *allow reads, ask before commands*:

1. **`@mention` your bot: "what files are in the working directory?"** → it answers in a thread immediately, no prompt. ✅
2. **`@mention` it: "run the test suite"** → an Allow / Deny prompt appears. Only you can approve; then it runs and posts the result. ✅
3. **Ask it to `rm -rf` something on the deny list** → auto-rejected, no prompt, never runs. ✅

---

## Permissions

Each bot's access in a channel is set from a **preset** — `strict`, `ask-per-edit`, `auto`, or `bypass` — which expands into three lists:

- **allow** — runs automatically, no prompt
- **ask** — posts an Allow / Deny prompt to the owner
- **deny** — a hard floor; never runs, even if approved. Every preset keeps it.

You pick presets during `knock-knock setup`, so you rarely edit this by hand. You can also narrow what a specific peer may do with per-actor tiers. Full guide: **[Permissions & security](docs/security-and-permissions.md)**.

Approvals are owner-only (verified by Discord user ID), config files are written only from your terminal (never from chat messages), and a loop guard caps back-and-forth between two agents so they don't talk forever.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Bot shows offline | Token wrong or not loaded. Re-run `knock-knock setup` → "Manage a bot" → "Save / update token". |
| Bot never sees messages | (a) MESSAGE CONTENT INTENT not enabled in the Discord portal; (b) the message didn't `@mention` it; (c) it isn't a member of that channel. |
| No approval prompt appears | The owner ID isn't set — re-run `knock-knock setup`. |
| ✅ reaction does nothing | Only the **owner's** reaction counts (verified by user ID). |
| Bot replies in the channel, not a thread | It's missing **Create Public Threads** / **Send Messages in Threads** — re-invite with those permissions. |
| Two bots stop replying to each other | Expected — the loop guard caps agent↔agent chatter. Any human message resets it. |

---

## Reference

State lives at `~/.knock-knock/access.json`, organized around four things: your **bots**, the **channels** they work in (each with a workspace folder and permission profile), the **roster** of people and peer bots you collaborate with, and **me** (your owner ID per platform). Tokens live in `~/.knock-knock/.env`. Only the setup CLI reads or writes these files.

```jsonc
{
  "me": { "discord": "184695080709324800" },     // your owner ID — approvals ping this
  "bots": {
    "reviewer": { "platform": "discord", "tokenEnv": "DISCORD_BOT_TOKEN", "runtime": "claude-sdk" }
  },
  "channels": {
    "discord:846209781206941736": {
      "label": "#project-x",
      "members": [                                 // your bots here, each with its own folder + rules
        { "bot": "reviewer", "workspace": "/Users/alice/repos/project-x",
          "preset": "ask-per-edit",
          "profile": { "allow": ["Read(**)"], "ask": ["Bash(*)"], "deny": ["Bash(rm -rf *)", "Bash(sudo *)"] } }
      ],
      "collaborators": [ { "kind": "peer", "id": "deploy-bot" } ]   // peer bots / humans, by roster ID
    }
  }
}
```

## Development

```bash
bun test              # full suite
bun run typecheck     # tsc --noEmit
bun src/cli.ts <cmd>  # the CLI (setup | relay)
bun run build         # cross-compile release binaries into dist/
```

All source lives under `src/`. `lib.ts` holds the pure, security-critical decision logic (who may send, who may approve, tool classification); `state.ts` is the only module that touches config files. The relay's core is an append-only ledger of actions. Architecture: [`docs/knock-knock-ledger-model.md`](docs/knock-knock-ledger-model.md). Releasing: [CONTRIBUTING.md](CONTRIBUTING.md).

> **Billing note:** Agent SDK usage draws from a separate monthly credit pool starting 2026-06-15. Check your Anthropic console.

## Forked from

Anthropic's official Discord channel plugin (`discord@claude-plugins-official`) — the discord.js connection patterns and message chunking come from there.
</content>
</invoke>
