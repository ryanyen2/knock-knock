/**
 * fetchRecent — the mesh's reconnect-replay source. NOT on the MessagingAdapter interface
 * (the host duck-types it); these tests pin the two contracts the mesh depends on:
 *   1. OLDEST-first ordering (the platforms return newest-first, so the adapter reverses).
 *   2. Discord pages past its 100/call cap with a `before` cursor up to `limit`.
 *   3. Slack skips an unattributable (bot_id-only, no `user`) message — else its provenance
 *      fails silently on ingest.
 * Both are exercised against injected mock clients (no live gateway/socket).
 */

import { test, expect } from 'bun:test'
import { DiscordMessagingAdapter } from '../../src/adapters-msg/discord.ts'
import { SlackMessagingAdapter } from '../../src/adapters-msg/slack.ts'

type Recent = { authorId: string; text: string }

// ─── Discord: paging + reversal ─────────────────────────────────────────────

/** A mock text channel backed by `all` (oldest-first). `messages.fetch({limit, before})`
 *  returns up to `limit` messages NEWEST-first, strictly older than `before` — mirroring
 *  the discord.js paging contract the adapter relies on. */
function discordChannel(all: { id: string; author: { id: string }; content: string }[]) {
  return {
    isTextBased: () => true,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => {
        let pool = all
        if (before !== undefined) {
          const idx = all.findIndex(m => m.id === before)
          pool = idx >= 0 ? all.slice(0, idx) : []
        }
        const newestFirst = [...pool].reverse()
        return new Map(newestFirst.slice(0, limit).map(m => [m.id, m]))
      },
    },
  }
}

function withClient(channel: unknown) {
  const a = new DiscordMessagingAdapter() as unknown as {
    client: { channels: { fetch: (s: string) => Promise<unknown> } }
    fetchRecent(scope: string, limit: number): Promise<Recent[]>
  }
  ;(a as { client: unknown }).client = { channels: { fetch: async () => channel } }
  return a
}

test('discord fetchRecent pages past the 100/call cap and returns oldest-first', async () => {
  const all = Array.from({ length: 250 }, (_, k) => ({
    id: String(k + 1),
    author: { id: k % 2 ? 'A' : 'B' },
    content: `line ${k + 1}`,
  }))
  const a = withClient(discordChannel(all))
  const got = await a.fetchRecent('chan', 200)

  expect(got).toHaveLength(200) // 2 pages of 100, capped at limit
  // Oldest-first: the window is the newest 200 (ids 51..250), reversed to ascending.
  expect(got[0]).toEqual({ authorId: 'B', text: 'line 51' })
  expect(got[got.length - 1]).toEqual({ authorId: 'A', text: 'line 250' })
})

test('discord fetchRecent stops at the start of a short history', async () => {
  const all = Array.from({ length: 5 }, (_, k) => ({
    id: String(k + 1),
    author: { id: 'A' },
    content: `m${k + 1}`,
  }))
  const a = withClient(discordChannel(all))
  const got = await a.fetchRecent('chan', 200)
  expect(got.map(g => g.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']) // oldest-first, no hang
})

test('discord fetchRecent returns [] for a missing / non-text channel', async () => {
  const a = withClient(null)
  expect(await a.fetchRecent('chan', 200)).toEqual([])
})

// ─── Slack: reversal + bot_id-only skip ──────────────────────────────────────

function slackAdapter(messages: unknown[]) {
  const a = new SlackMessagingAdapter() as unknown as {
    web: unknown
    fetchRecent(scope: string, limit: number): Promise<Recent[]>
  }
  ;(a as { web: unknown }).web = {
    conversations: { history: async () => ({ messages }) },
  }
  return a
}

test('slack fetchRecent reverses to oldest-first and skips bot_id-only messages', async () => {
  // newest-first, as conversations.history returns. The middle one has bot_id but no user.
  const a = slackAdapter([
    { user: 'U3', text: 'third' },
    { bot_id: 'B1', text: 'unattributable' }, // no `user` → skipped
    { user: 'U1', text: 'first' },
  ])
  const got = await a.fetchRecent('C123', 200)
  expect(got).toEqual([
    { authorId: 'U1', text: 'first' },
    { authorId: 'U3', text: 'third' },
  ])
})

test('slack fetchRecent resolves a thread scope to its channel and returns [] with no client', async () => {
  const a = new SlackMessagingAdapter() as unknown as { fetchRecent(s: string, n: number): Promise<Recent[]> }
  expect(await a.fetchRecent('C123:169.42', 200)).toEqual([]) // web undefined ⇒ no throw
})
