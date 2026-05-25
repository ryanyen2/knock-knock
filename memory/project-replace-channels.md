---
name: project-replace-channels
description: Phase 0 relay implementation on replace-channels branch — files created, architecture, SDK version, test procedure
metadata:
  type: project
---

Phase 0 relay implementation is complete on the `replace-channels` branch. All new files created and TypeScript typechecks pass.

**Why:** Replace the `--channels` / `--dangerously-load-development-channels` architecture (MCP subprocess) with a relay host process that drives Claude via the Agent SDK directly.

**Files created:**
- `state.ts` — shared I/O (readAccessFile, saveAccess, readRoomSettings, path constants)
- `agent-adapter.ts` — AgentAdapter interface + PermissionProfile, Verdict types (no SDK imports)
- `adapters/claude-sdk.ts` — ClaudeSdkAdapter (only file that imports @anthropic-ai/claude-agent-sdk)
- `driver.ts` — Driver class: one session, turn queue, wires adapter
- `approvals.ts` — Approvals service: Discord Allow/Deny buttons, timeout (5min→deny), reaction support
- `relay.ts` — Entry point: Discord client, routing table Map<sessionKey, Driver>, gate, post

**SDK version:** `@anthropic-ai/claude-agent-sdk@^0.3.150`

**Key SDK types used:**
- `query({ prompt, options })` — returns `Query extends AsyncGenerator<SDKMessage>`
- `SDKSystemMessage` (subtype: 'init') — carries `session_id`
- `SDKResultSuccess` (subtype: 'success') — carries `result: string` (final text), `session_id`
- `Options.allowedTools` → auto-approve (T1); `Options.disallowedTools` → hard deny floor (T3); `Options.canUseTool` → interactive ask (T2)

**Start relay:** `bun relay.ts` (requires DISCORD_BOT_TOKEN + KNOCK_KNOCK_WORKSPACE env vars)

**Room settings file:** `~/.claude/channels/knock-knock/rooms/<channelId>.settings.json` with `{ allow, ask, deny }` arrays.

**How to apply:** When resuming work on this branch, the implementation is in place. Next step is manual T1/T2/T3 testing per plan §10.
