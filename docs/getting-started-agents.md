# Getting started: running knock-knock with different agents

Phase 1 makes the runtime swappable. The relay drives **any** coding agent
through one `AgentAdapter` seam; you pick the agent with the `KNOCK_KNOCK_AGENT`
environment variable. Nothing in `relay.ts` / `driver.ts` / `lib.ts` knows which
agent is underneath.

There are two transports behind that seam:

| Transport | Agents | How it talks |
|-----------|--------|--------------|
| In-process SDK | Claude Code (`claude-sdk`) | Claude Agent SDK, in this process |
| **ACP over stdio** | **OpenCode, Codex, Gemini, Claude Code, Cursor, …** | spawns the agent as a subprocess, JSON-RPC on stdin/stdout ([Agent Client Protocol](https://agentclientprotocol.com)) |

ACP is the universal path: one adapter (`adapters/acp.ts`) drives every
ACP-speaking agent — the agent is chosen by **which command we spawn**, not by
any agent-specific code.

```
KNOCK_KNOCK_AGENT   agent / transport
─────────────────   ──────────────────────────────────────────────
claude-sdk          Claude Code, in-process SDK  (default; no install)
claude-acp          Claude Code, via ACP         (npx @zed-industries/claude-code-acp)
opencode            OpenCode, via ACP            (opencode acp)
codex               OpenAI Codex, via ACP        (npx @agentclientprotocol/codex-acp)
gemini              Gemini CLI, via ACP          (gemini --experimental-acp)
acp                 any agent — set KNOCK_KNOCK_ACP_COMMAND / _ARGS yourself
opencode-http       OpenCode over HTTP+SSE       (legacy/experimental — see note)
```

All modes start the same way:

```bash
KNOCK_KNOCK_AGENT=<agent> KNOCK_KNOCK_WORKSPACE=/abs/path/to/workspace bun relay.ts
```

Prerequisite for every mode: a room set up via `/knock-knock:room setup` in
Claude Code (so `access.json` and the room `settings.json` exist), and
`DISCORD_BOT_TOKEN` available. See the main [README](../README.md).

---

## ⚠️ The one thing that matters for the deny floor

The room profile (`allow` / `ask` / `deny`) is enforced **inside the adapter**
when the agent asks permission to run a tool:

- **deny** → auto-rejected; the owner never even sees it (hard floor)
- **allow** → auto-approved; no Discord prompt
- **ask** → posted to Discord for the owner to Allow/Deny

This only works if **the agent actually asks before running tools.** ACP has no
policy you hand the agent up front — if an agent is configured to run shell
commands autonomously, it never sends a permission request and the floor is
bypassed. So for each ACP agent you must ensure it runs in an **ask-first** mode
(its normal default — just don't put it in a "yolo"/auto-approve mode). The
per-agent sections below say exactly how.

> Verified behaviour (OpenCode): out of the box OpenCode auto-ran both `echo`
> and `rm -rf` with **zero** permission requests. After adding
> `"permission": { "bash": "ask" }` to its config, every shell call surfaced as
> an ACP permission request and the `deny` floor blocked `rm -rf` correctly,
> even when OpenCode mislabelled the tool kind. The matcher therefore blocks a
> denied command literal regardless of the reported tool kind.

---

## Claude Code

**Option A — in-process SDK (simplest, nothing to install):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # or an existing `claude` login
KNOCK_KNOCK_AGENT=claude-sdk \
KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
```

The SDK enforces `deny` natively (`disallowedTools`) and routes `ask` through
`canUseTool` — the deny floor is solid without extra config.

**Option B — via ACP** (same code path as the other agents):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
KNOCK_KNOCK_AGENT=claude-acp \
KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
```

`npx` fetches `@zed-industries/claude-code-acp` on first run. Claude Code asks
before non-allowlisted tools by default, so the floor holds.

---

## OpenCode

1. Install: `brew install sst/tap/opencode` (or see opencode.ai).
2. Configure a provider/model — OpenCode won't prompt without one:
   `opencode auth login` (pick Anthropic / OpenAI / etc.).
3. **Make it ask before tools** — add to `opencode.json` in your workspace
   (or `~/.config/opencode/opencode.json`):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" }
   }
   ```

4. Run:

   ```bash
   KNOCK_KNOCK_AGENT=opencode \
   KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
   ```

The relay spawns `opencode acp` and drives it over stdio. (No global install of
an adapter needed — ACP is built into OpenCode.)

---

## OpenAI Codex

1. Auth: `export OPENAI_API_KEY=sk-...` (the `codex-acp` server reads it).
2. **Approval mode:** run Codex with an approval policy that asks before
   commands (do **not** use a full-auto / `--dangerously-bypass` mode). The
   default `codex-acp` behaviour surfaces tool calls as ACP permission requests.
3. Run:

   ```bash
   KNOCK_KNOCK_AGENT=codex \
   KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
   ```

`npx` fetches `@agentclientprotocol/codex-acp` on first run. If you have a
locally built `codex-acp` binary instead, point at it directly:

```bash
KNOCK_KNOCK_AGENT=acp \
KNOCK_KNOCK_ACP_COMMAND=codex-acp \
KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
```

---

## Any other ACP agent (Gemini, Cursor, …)

Use the generic escape hatch — set the spawn command yourself:

```bash
KNOCK_KNOCK_AGENT=acp \
KNOCK_KNOCK_ACP_COMMAND=gemini \
KNOCK_KNOCK_ACP_ARGS="--experimental-acp" \
KNOCK_KNOCK_WORKSPACE=/abs/path bun relay.ts
```

`gemini` also has a built-in preset (`KNOCK_KNOCK_AGENT=gemini`).

---

## Verifying it works (T1 / T2 / T3)

With the room profile `allow: ["Read(**)"]`, `ask: ["Bash(*)"]`,
`deny: ["Bash(rm -rf *)", "Bash(sudo *)"]`, in the Discord room:

- **T1 — Auto:** "what files are in the working directory?" → answered, **no**
  approval prompt.
- **T2 — Gated:** "run `echo hello`" → an **Allow / Deny** prompt appears
  mentioning the owner; tapping Allow runs it; a non-owner tapping Allow is
  rejected.
- **T3 — Hard deny:** "delete everything with `rm -rf`" → **blocked, no prompt
  ever appears** (auto-rejected by the floor); the command never runs.

Run with `KNOCK_KNOCK_DEBUG=1` to log every ACP event and each permission
decision (`[acp] permission: … → allow|ask|deny`) — a real turn produces tool
and message events; a reply with no upstream events is a stub.

---

## Note on `opencode-http`

An earlier adapter (`adapters/opencode.ts`) drove OpenCode over its HTTP+SSE
API. It is **superseded** by the ACP path (`KNOCK_KNOCK_AGENT=opencode`), which
is native, simpler, and verified. The HTTP adapter is kept only as a
structurally-different reference (it remains reachable as
`KNOCK_KNOCK_AGENT=opencode-http`) and is not part of the supported flow.
