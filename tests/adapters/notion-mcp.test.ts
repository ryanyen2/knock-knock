/**
 * Pure tests for the page-scoped Notion write tool's helpers: text→paragraph-block
 * chunking (2000-char node cap, 100-block ceiling, blank-line paragraph split) and
 * plain-text extraction from arbitrary Notion blocks. No SDK/network.
 */

import { test, expect } from 'bun:test'
import {
  textToParagraphBlocks,
  blockPlainText,
  NOTION_TOOL_NAMES,
} from '../../src/adapters/notion-mcp.ts'

test('textToParagraphBlocks: splits on blank lines into one block per paragraph', () => {
  const blocks = textToParagraphBlocks('first para\n\nsecond para')
  expect(blocks.length).toBe(2)
  expect(blocks[0]!.paragraph.rich_text[0]!.text.content).toBe('first para')
  expect(blocks[1]!.paragraph.rich_text[0]!.text.content).toBe('second para')
  expect(blocks[0]!.type).toBe('paragraph')
})

test('textToParagraphBlocks: hard-wraps a paragraph longer than the 2000-char node cap', () => {
  const long = 'x'.repeat(4500)
  const blocks = textToParagraphBlocks(long)
  expect(blocks.length).toBe(3) // 2000 + 2000 + 500
  expect(blocks[0]!.paragraph.rich_text[0]!.text.content.length).toBe(2000)
  expect(blocks[2]!.paragraph.rich_text[0]!.text.content.length).toBe(500)
})

test('textToParagraphBlocks: empty / whitespace yields no blocks', () => {
  expect(textToParagraphBlocks('')).toEqual([])
  expect(textToParagraphBlocks('   \n\n  ')).toEqual([])
})

test('textToParagraphBlocks: caps at 100 blocks', () => {
  const many = Array.from({ length: 250 }, (_, i) => `p${i}`).join('\n\n')
  expect(textToParagraphBlocks(many).length).toBe(100)
})

test('blockPlainText: pulls rich_text from any block type, empty when none', () => {
  expect(
    blockPlainText({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'hello' }] } }),
  ).toBe('hello')
  expect(
    blockPlainText({ type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } }),
  ).toBe('Title')
  expect(blockPlainText({ type: 'divider', divider: {} })).toBe('')
  expect(blockPlainText(null)).toBe('')
  expect(blockPlainText({})).toBe('')
})

test('NOTION_TOOL_NAMES: namespaced under mcp__notion__', () => {
  expect(NOTION_TOOL_NAMES).toContain('mcp__notion__read_page')
  expect(NOTION_TOOL_NAMES).toContain('mcp__notion__append_to_page')
})
