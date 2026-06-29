---
title: "IBM Bob Shell automation surface — what the v1.0.5 CLI actually exposes"
date: 2026-06-29
category: integration-issues
module: adapters
problem_type: integration_issue
component: tooling
symptoms:
  - "planning a Bob Shell runtime from web docs gave a pessimistic, partly-wrong picture (no resume, no structured output)"
  - "need to know whether Bob exposes a programmatic per-tool approval hook before committing to a permission design"
root_cause: documentation_drift
resolution_type: investigation
severity: medium
related_components:
  - "adapters"
  - "agent-adapter"
tags:
  - bob-shell
  - bobshell
  - ibm
  - acp
  - runtime-adapter
  - permissions
---

# IBM Bob Shell automation surface (probed empirically, v1.0.5)

## Context

We planned a `bob` runtime for knock-knock (see `docs/plans/2026-06-29-001-feat-bob-shell-runtime-integration-plan.md`). The plan was built from bob.ibm.com web docs and was deliberately spike-gated because the docs left the critical questions (per-tool approval hook, resume, structured output) unanswered or answered pessimistically.

This note records what the **actual shipped binary** exposes. Ground truth was the installed package — `bobshell@1.0.5` at `…/lib/node_modules/bobshell/bundle/bob.js` — its `--help`, its bundled docs (`bundle/bobshell-docs/`), and string-level inspection of the bundle. Probed offline (no `BOBSHELL_API_KEY`); anything requiring a live turn is flagged below.

## What the docs got wrong (and the build was adjusted to match)

| Web-doc assumption (plan KTD) | Reality in v1.0.5 | Build adjustment |
|---|---|---|
| KTD5: no structured output; degraded final-text-only events | `-o, --output-format text\|json\|stream-json` exists | `stream-json` parsed into full `AgentEvent`s |
| KTD4: no session resume; use a synthetic id | `-r, --resume latest\|<index>`, `--list-sessions`, `--delete-session`; `init` event returns `session_id` | real resume with fresh-fallback |
| KTD6 / R-B: deny floor weak, leans on leaky `.bobignore` | `-s, --sandbox` with shipped macOS `sandbox-exec` profiles + a Docker sandbox image | deny floor reinforced by OS sandbox |
| TurnOptions ignored | `-m, --model` and `--max-coins` exist | `options.model` maps to `--model` |

## The decisive question: per-tool `ask` gate → **Branch B**

knock-knock's core guarantee is per-action allow/ask/deny, where `ask` pauses a single tool call for the owner's Allow/Deny click. **Bob exposes no programmatic per-call approval callback.** `--approval-mode` has exactly three coarse values:

- `default` — prompt for approval (interactive TTY only; in non-interactive mode Bob runs read-only / non-destructive tools only)
- `auto_edit` — auto-approve edit tools
- `yolo` — auto-approve all tools (`-y`/`--yolo`)

There is no stdin protocol to answer an individual tool request (no ACP, no `canUseTool`-style hook; `tools.callCommand` is a custom-tool *dispatcher*, not an approval gate). So the per-call `ask` tier cannot be honored. We degrade **honestly to a turn-level gate** (one owner Allow/Deny per turn that could write) and lean on the OS sandbox + `.bobignore` + `--allowed-tools` for the rest. This is weaker than the SDK/ACP runtimes and is documented as such.

## `stream-json` event schema (authoritative, from the bundle)

`--output-format stream-json` emits newline-delimited JSON objects. Event-type enum and shapes, verbatim from `bundle/bob.js`:

```
init        { type:"init",        timestamp, session_id, model }
message     { type:"message",     timestamp, role:"user"|"assistant", content, delta?:true }
tool_use    { type:"tool_use",    timestamp, tool_name, tool_id, parameters }
tool_result { type:"tool_result", timestamp, tool_id, status:"success"|"error", output, error? }
error       { type:"error", … }
result      { type:"result",      timestamp, status:"success"|"error", error?, stats }
```

This maps almost 1:1 onto knock-knock's `AgentEvent` union (`src/agent-adapter.ts`):
`init`→`session_init`, `message`(assistant)→`assistant_text`, `tool_use`→`tool_call`, `tool_result`→`tool_result`, `result`→`turn_done`.

## Auth (headless, CI-ready)

- `BOBSHELL_API_KEY` env var (key created in the Bob web portal, "Inference" scope; added v1.0.3).
- `--accept-license` accepts the IBM license non-interactively (needed on first run).
- No interactive IBMid browser login required once the key is set — same inherit-`process.env` model knock-knock already uses for ACP runtimes.
- `--logout` clears saved credentials. (README testing note: set `BOBSHELL_API_KEY` *and* `GEMINI_API_KEY` to the same value for local testing.)

## Sandbox (the real deny floor)

`-s, --sandbox` runs tools under OS-level isolation. Shipped macOS `sandbox-exec` profiles in `bundle/`: `sandbox-macos-{permissive,restrictive}-{open,closed,proxied}.sb`. Linux uses a Docker image (`package.json` `config.sandboxImageUri: docker.io/library/node:25-trixie`). Note: even with `--yolo`, Bob will not write outside the directory it was started in (built-in workspace boundary).

## Sessions / resume (a real limitation)

- `--resume latest` or `--resume <index>`; sessions are **project/cwd-scoped and addressed by index or "latest"**, not by the opaque `session_id` from the `init` event.
- Consequence: an externally-stored `session_id` can't be turned into a precise `--resume` target without parsing `--list-sessions`. v1 of the adapter passes the stored id to `--resume` and **falls back to a fresh session** if Bob rejects it (mirrors `ClaudeSdkAdapter`'s resume-fail-fallback). Precise resume across multiple interleaved scopes sharing one workspace is a known gap, deferred.
- Checkpointing (`general.checkpointing.enabled`, `/restore`) is a separate file-snapshot feature in `~/.bob/history/<project_hash>` — not used by the adapter.

## Other surface (not used by v1, noted for later)

- `mcp` subcommand (`bob mcp add|remove|list`) — Bob is an MCP **client** with per-server `alwaysAllow`. Could let knock-knock expose tools *to* Bob, but does not gate Bob's built-in tools.
- `extensions` subcommand, `--chat-mode plan|code|advanced|ask`, `--include-directories`, `--pre-check-auto-approved`, `--max-coins` (budget cap, exit 1 when exceeded).

## Remaining live-verification gap

Everything above is from the binary/docs offline. **One live smoke test still needs a `BOBSHELL_API_KEY`**: confirm a real `bob -p "…" -o stream-json` turn emits the events in the documented shape and that `--resume <id>` either resumes or exits non-zero (triggering our fresh-fallback). Pure parsing/argv logic is unit-tested against the schema above; the adapter wiring is built to it.
