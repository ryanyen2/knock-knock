/** In-process MCP server letting an agent share a workspace file back to the channel.
 *  Imports the SDK (relay/host never do). The share stays secret-floored + FileShare-
 *  classified by the host inside `share` — an ask-tier share is held for owner consent. */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import type { ShareToolHandlers } from '../agent-adapter.ts'

export type { ShareToolHandlers }

/** MCP server key — the tool surfaces to the model as `mcp__knock-knock-share__share_file`. */
export const SHARE_MCP_SERVER = 'knock-knock-share'

/** Tool name auto-allowed so the agent isn't prompted to use its own seam; the share
 *  itself is still secret-floored + classified (and consent-gated) by the host. */
export const SHARE_TOOL_NAMES = [`mcp__${SHARE_MCP_SERVER}__share_file`]

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

/** Build the SDK MCP server exposing share_file. */
export function makeShareMcpServer(h: ShareToolHandlers): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SHARE_MCP_SERVER,
    version: '0.1.0',
    tools: [
      tool(
        'share_file',
        'Upload a file from your workspace as an attachment in this channel — use this when asked to send/share a file, instead of pasting its contents as a message. Path is relative to your workspace. To hand a file to a peer agent, set `message` to a note that includes their <@botId> (from your roster) so the file and the mention land on one message — that is the only form a peer will pick up and read. Credentials are refused; if the room requires it, your owner is asked to approve before it is sent.',
        {
          path: z.string().describe('Workspace-relative path of the file to share, e.g. README.md or reports/summary.pdf.'),
          message: z
            .string()
            .optional()
            .describe('Optional caption posted with the file. For a peer handoff, include the target\'s <@botId> and what to do, e.g. "<@123> updated solver.py — run the benchmark on it". Defaults to a plain "shared <name>".'),
        },
        async ({ path, message }: { path: string; message?: string }) => {
          const r = await h.share(path, message)
          return textResult(r.message, !r.ok)
        },
      ),
    ],
  })
}
