/** In-process MCP server letting a `claude-sdk` agent READ and WRITE the Notion page
 *  it's working in. Scoped to ONE page (the conversation's scope) so the agent can only
 *  touch the page it was summoned on — it cannot roam the workspace. Imports the SDK +
 *  the Notion client (the relay/host never do). Mirrors `watch-mcp.ts`.
 *
 *  Why: a Notion bot's chat reply posts as a *comment*; to change the page *body* the
 *  agent needs a tool. "describe the codebase in the page" then appends a paragraph to
 *  the page instead of editing local files. */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import { Client } from '@notionhq/client'

/** MCP server key — tools surface to the model as `mcp__notion__<tool>`. */
export const NOTION_MCP_SERVER = 'notion'

/** Tool names auto-allowed (no per-call prompt): writing to the bound page IS the bot's
 *  job, and the server is locked to a single page id. */
export const NOTION_TOOL_NAMES = [
  `mcp__${NOTION_MCP_SERVER}__read_page`,
  `mcp__${NOTION_MCP_SERVER}__append_to_page`,
]

/** Notion rich_text caps a text node at 2000 chars; a block holds one here. */
const MAX_BLOCK_CHARS = 2000
/** Notion's children-append ceiling per call. */
const MAX_BLOCKS = 100

type ParagraphBlock = {
  object: 'block'
  type: 'paragraph'
  paragraph: { rich_text: Array<{ type: 'text'; text: { content: string } }> }
}

/**
 * Turn free text into Notion paragraph blocks: split on blank lines into paragraphs,
 * hard-wrap any paragraph longer than the 2000-char node cap, and bound the total to
 * Notion's 100-children ceiling. Pure (unit-testable).
 */
export function textToParagraphBlocks(text: string): ParagraphBlock[] {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const chunks: string[] = []
  for (const p of paras) {
    if (p.length <= MAX_BLOCK_CHARS) {
      chunks.push(p)
    } else {
      for (let i = 0; i < p.length; i += MAX_BLOCK_CHARS) chunks.push(p.slice(i, i + MAX_BLOCK_CHARS))
    }
  }
  const block = (content: string): ParagraphBlock => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] },
  })
  return chunks.slice(0, MAX_BLOCKS).map(block)
}

/** Extract plain text from one Notion block of any rich-text-bearing type. Pure. */
export function blockPlainText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const b = block as { type?: string } & Record<string, unknown>
  const type = b.type
  if (!type) return ''
  const body = b[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined
  const rt = body?.rich_text
  if (!Array.isArray(rt)) return ''
  return rt.map(n => n.plain_text ?? '').join('')
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

/**
 * Build the SDK MCP server exposing read_page / append_to_page, locked to `pageId`.
 * `token` is the Notion integration token / PAT (same one the transport uses).
 */
export function makeNotionMcpServer(token: string, pageId: string): McpSdkServerConfigWithInstance {
  const notion = new Client({ auth: token })
  return createSdkMcpServer({
    name: NOTION_MCP_SERVER,
    version: '0.1.0',
    tools: [
      tool(
        'read_page',
        'Read the current Notion page\'s text content (the page this conversation is on). Returns the page body as plain text. Use this to see what is already on the page before editing.',
        {},
        async () => {
          try {
            const res = (await notion.blocks.children.list({ block_id: pageId, page_size: 100 })) as {
              results?: unknown[]
            }
            const text = (res.results ?? []).map(blockPlainText).filter(Boolean).join('\n')
            return textResult(text || '(the page has no readable text blocks yet)')
          } catch (e) {
            return textResult(`Could not read the page: ${String(e)}`, true)
          }
        },
      ),
      tool(
        'append_to_page',
        'Append text to the CURRENT Notion page as new paragraph(s). This writes INTO the page body (not a comment). Use this when asked to add/write/describe something in the page. Markdown is not rendered — plain paragraphs separated by blank lines.',
        { text: z.string().describe('The text to append. Blank lines separate paragraphs.') },
        async ({ text }: { text: string }) => {
          const blocks = textToParagraphBlocks(text)
          if (blocks.length === 0) return textResult('Nothing to append (empty text).', true)
          try {
            await notion.blocks.children.append({ block_id: pageId, children: blocks as never })
            return textResult(`Appended ${blocks.length} paragraph block(s) to the page.`)
          } catch (e) {
            return textResult(`Could not append to the page: ${String(e)}`, true)
          }
        },
      ),
    ],
  })
}
