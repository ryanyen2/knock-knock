# Runtime: IBM Bob Shell

knock-knock can drive [IBM Bob Shell](https://bob.ibm.com) (`bob`) as a bot's coding agent, alongside Claude, Codex, OpenCode, and Gemini. Pick the **IBM Bob Shell** runtime for a bot in `knock-knock setup` (or `!config agent bob` in a thread).

Bob is a capable agent, but it does **not** expose the per-tool approval hook the SDK and ACP runtimes do. Read the [Permission posture](#permission-posture) section before you rely on it — knock-knock honors your allow/ask/deny rules for Bob at a coarser granularity than for other runtimes, and this page tells you exactly how.

## Prerequisites

1. **Install Bob:**
   ```bash
   npm install -g bobshell        # provides the `bob` command
   ```
   If `bob` lives somewhere unusual, set `KNOCK_KNOCK_BOB_COMMAND` to its path.

2. **Create an API key** in the Bob portal with **Inference** scope, then export it:
   ```bash
   export BOBSHELL_API_KEY=…       # the relay inherits this; no interactive IBMid login at runtime
   ```
   The key can't be retrieved again after creation — store it in your secrets manager.

3. **Accept the license** — the adapter passes `--accept-license` automatically, so the first headless run won't block.

Run `knock-knock doctor`. When a bot uses the `bob` runtime, doctor adds a **bob shell runtime** section that checks `bob` is on PATH and `BOBSHELL_API_KEY` is set, with a fix for each.

## Permission posture

knock-knock's other runtimes intercept **every individual tool call** and route `ask`-tier calls to the owner's Allow/Deny prompt. Bob has no such hook — its only approval controls are coarse (`--approval-mode default|auto_edit|yolo`). So the mapping is:

| Your rule | How Bob honors it |
|---|---|
| **allow** (no `ask` rules in the profile) | Bob auto-approves **edits** (`--approval-mode auto_edit`), inside the OS sandbox. Commands are not blanket-approved. |
| **ask** | **Turn-level gate.** Before a turn that could write, the owner gets **one** Allow/Deny prompt. Allow → Bob may edit files this turn (`auto_edit`, sandboxed). Deny → the turn runs **read-only**. There is no per-tool prompt. |
| **deny** | Enforced two ways: an OS-level `--sandbox` (the command/network floor) and a knock-knock-managed block in the project's `.bobignore` (the file-read floor, e.g. secrets) |

What this means in practice:

- **The owner's click is per-turn, not per-tool.** If you approve, Bob may make several edits in that turn without asking again.
- **Deny on the file floor leans on `.bobignore`**, which Bob's own docs note some write operations can bypass — so the `--sandbox` is the real floor. knock-knock always runs Bob sandboxed.
- **knock-knock never grants Bob blanket auto-approval (`yolo`).** Bob has no per-command approval hook, so `yolo` would run a command-tier deny like `Bash(rm -rf *)` unchecked — silently voiding the deny floor. Even an `auto` or `bypass` preset maps to `auto_edit` for Bob, not `yolo`. This is a deliberate, documented difference from the other runtimes.

If you need true per-tool approval, use the Claude SDK or an ACP runtime; Bob can't provide it today.

## What's supported

- **Non-interactive turns** via `bob -o stream-json`, parsed into knock-knock's normal progress events (assistant text, tool calls, tool results, completion).
- **Session resume** via Bob's `--resume`. Bob addresses sessions by index/"latest" per project, not by an opaque id, so the adapter resumes best-effort and **falls back to a fresh session** if Bob rejects the handle. Precise resume across multiple threads sharing one workspace is a known limitation.
- **Model selection** via `!config model …` (maps to Bob's `--model`).
- **🛑 stop** aborts the turn (the `bob` subprocess is killed).

## Limitations

- No per-tool `ask` (see above) — turn-level only.
- `thinking` / `effort` knobs don't apply to Bob.
- Cross-runtime session sharing (`share session` / `resume session`) doesn't list Bob sessions.

Full empirical detail on Bob's automation surface: [`docs/solutions/integration-issues/bob-shell-automation-surface.md`](solutions/integration-issues/bob-shell-automation-surface.md).
