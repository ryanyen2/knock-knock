/**
 * The in-process MCP server that lets an agent arm/disarm watches by *calling a
 * tool*, the way Claude Code's Monitor tool works — so "start watching the notes
 * file" or "ping me when the W&B run finishes" become real tool calls instead of
 * an owner typing `!watch`. See docs/knock-knock-watches.md §8.
 *
 * Lives in adapters/ because it imports the Claude Agent SDK (the relay/host
 * never do). The host supplies plain handler functions bound to a channel +
 * agent; this module only translates the tool surface to them. The command a
 * watch runs is still deny-floored by the host before anything is armed.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import type { WatchFireOn } from '../lib.ts'
import type { WatchArmPartial, WatchToolHandlers } from '../agent-adapter.ts'

export type { WatchToolHandlers }

/** MCP server key — tools surface to the model as `mcp__knock-knock__<tool>`. */
export const WATCH_MCP_SERVER = 'knock-knock'

/** The tool names to auto-allow so arming doesn't trigger an approval prompt
 *  (the *command* is still classified by the host before it runs). */
export const WATCH_TOOL_NAMES = [
  `mcp__${WATCH_MCP_SERVER}__watch`,
  `mcp__${WATCH_MCP_SERVER}__unwatch`,
  `mcp__${WATCH_MCP_SERVER}__watch_list`,
]

const armShape = {
  name: z.string().describe('Short stable id for the watch; re-arming the same name replaces it.'),
  command: z
    .string()
    .describe(
      'Shell command to run and watch. Each stdout line is an event. For polling, make it loop, e.g. `while :; do wandb status; sleep 30; done`.',
    ),
  fire_on: z
    .enum(['each-line', 'change', 'match', 'exit'])
    .describe(
      'When a line becomes a turn: each-line (every line), change (distinct from last), match (regex hit), exit (once, when the process ends).',
    ),
  pattern: z.string().optional().describe('Regex; required when fire_on=match.'),
  prompt_template: z
    .string()
    .optional()
    .describe('How to phrase the resumed turn; {line} and {name} are substituted.'),
  once: z.boolean().optional().describe('Disarm after the first fire.'),
  ttl_seconds: z.number().optional().describe('Auto-disarm after this many seconds.'),
  max_fires: z.number().optional().describe('Auto-disarm after this many fires.'),
}

type ArmArgs = {
  name: string
  command: string
  fire_on: 'each-line' | 'change' | 'match' | 'exit'
  pattern?: string
  prompt_template?: string
  once?: boolean
  ttl_seconds?: number
  max_fires?: number
}

/**
 * Pure translation of the tool's flat args into a WatchArmPartial. Exported so
 * it's unit-tested without spinning up the SDK. Returns an error string for
 * invalid combinations (match without a pattern).
 */
export function armArgsToPartial(a: ArmArgs): { spec?: WatchArmPartial; error?: string } {
  let fireOn: WatchFireOn
  if (a.fire_on === 'match') {
    if (!a.pattern) return { error: 'fire_on=match requires a `pattern`.' }
    fireOn = { kind: 'match', pattern: a.pattern }
  } else {
    fireOn = { kind: a.fire_on }
  }
  return {
    spec: {
      name: a.name,
      command: a.command,
      fireOn,
      ...(a.prompt_template ? { promptTemplate: a.prompt_template } : {}),
      ...(a.once || a.fire_on === 'exit' ? { oneShot: true } : {}),
      ...(a.ttl_seconds != null ? { ttlMs: Math.round(a.ttl_seconds * 1000) } : {}),
      ...(a.max_fires != null ? { maxFires: a.max_fires } : {}),
    },
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

/** Build the SDK MCP server exposing watch / unwatch / watch_list. */
export function makeWatchMcpServer(h: WatchToolHandlers): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: WATCH_MCP_SERVER,
    version: '0.1.0',
    tools: [
      tool(
        'watch',
        'Watch something that will change later (a file, a long-running job, a deadline) and get woken to act when it does. Returns immediately; you are re-prompted when the watch fires.',
        armShape,
        async (a: ArmArgs) => {
          const { spec, error } = armArgsToPartial(a)
          if (error) return textResult(error, true)
          const r = await h.arm(spec!)
          return textResult(r.message, !r.ok)
        },
      ),
      tool('unwatch', 'Cancel a watch by name.', { name: z.string() }, async ({ name }: { name: string }) => {
        const r = await h.disarm(name)
        return textResult(r.message, !r.ok)
      }),
      tool('watch_list', 'List the watches currently armed in this channel.', {}, async () =>
        textResult(await h.list()),
      ),
    ],
  })
}
