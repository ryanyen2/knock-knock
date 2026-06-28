/**
 * Discovery enumeration is duck-typed (OFF the MessagingAdapter interface, like
 * fetchRecent) and three-valued: a genuine success (possibly empty) is `results`;
 * a platform rejection of a call it should support is `degraded` (NOT an empty
 * `results`); and `unsupported` is what the caller infers when the method is ABSENT.
 * These tests inject a fake client into the private field via a structural cast (the
 * pattern from discord-payload.test.ts) and assert the results/degraded distinction
 * plus the presence/absence of methods per the capability matrix.
 */

import { test, expect } from 'bun:test'
import { SlackMessagingAdapter } from '../../src/adapters-msg/slack.ts'
import { GitHubMessagingAdapter } from '../../src/adapters-msg/github.ts'
import { NotionMessagingAdapter } from '../../src/adapters-msg/notion.ts'
import { TelegramMessagingAdapter } from '../../src/adapters-msg/telegram.ts'
import { DiscordMessagingAdapter } from '../../src/adapters-msg/discord.ts'

test('Slack listMembers: success normalizes member ids to {id,label}[] (kind:results)', async () => {
  const adapter = new SlackMessagingAdapter()
  ;(adapter as any).web = {
    conversations: { members: async () => ({ members: ['U1', 'U2'] }) },
  }
  const out = await adapter.listMembers('C123')
  expect(out).toEqual({ kind: 'results', items: [{ id: 'U1', label: 'U1' }, { id: 'U2', label: 'U2' }] })
})

test('Slack listMembers: an empty-but-successful list is results[], NOT degraded', async () => {
  const adapter = new SlackMessagingAdapter()
  ;(adapter as any).web = { conversations: { members: async () => ({ members: [] }) } }
  expect(await adapter.listMembers('C123')).toEqual({ kind: 'results', items: [] })
})

test('Slack listMembers: a platform rejection (throw) returns degraded with a reason', async () => {
  const adapter = new SlackMessagingAdapter()
  ;(adapter as any).web = {
    conversations: {
      members: async () => {
        throw new Error('missing_scope')
      },
    },
  }
  const out = await adapter.listMembers('C123')
  expect(out.kind).toBe('degraded')
  if (out.kind === 'degraded') expect(typeof out.reason).toBe('string')
})

test('Slack: no web client (before connect) degrades rather than throwing', async () => {
  const adapter = new SlackMessagingAdapter()
  expect((await adapter.listMembers('C123')).kind).toBe('degraded')
})

test('GitHub listMembers: maps repo collaborators by login (kind:results)', async () => {
  const adapter = new GitHubMessagingAdapter()
  ;(adapter as any).octokit = {
    repos: { listCollaborators: async () => ({ data: [{ login: 'alice' }, { login: 'bob' }] }) },
  }
  const out = await adapter.listMembers('owner/repo')
  expect(out).toEqual({
    kind: 'results',
    items: [{ id: 'alice', label: 'alice' }, { id: 'bob', label: 'bob' }],
  })
})

test('GitHub listMembers: a 403/rejection returns degraded (distinct from empty results)', async () => {
  const adapter = new GitHubMessagingAdapter()
  ;(adapter as any).octokit = {
    repos: {
      listCollaborators: async () => {
        throw { status: 403 }
      },
    },
  }
  expect((await adapter.listMembers('owner/repo')).kind).toBe('degraded')
})

test('Notion listMembers: filters to person users and maps name→label', async () => {
  const adapter = new NotionMessagingAdapter()
  ;(adapter as any).notion = {
    users: {
      list: async () => ({
        results: [
          { id: 'p1', type: 'person', name: 'Ada' },
          { id: 'b1', type: 'bot', name: 'KnockBot' }, // bot dropped
          { id: 'p2', type: 'person', name: null }, // falls back to id
        ],
      }),
    },
  }
  const out = await adapter.listMembers('page-id')
  expect(out).toEqual({
    kind: 'results',
    items: [{ id: 'p1', label: 'Ada' }, { id: 'p2', label: 'p2' }],
  })
})

test('method presence matches the capability matrix', () => {
  const telegram = new TelegramMessagingAdapter()
  const github = new GitHubMessagingAdapter()
  const notion = new NotionMessagingAdapter()
  const discord = new DiscordMessagingAdapter()
  const slack = new SlackMessagingAdapter()

  // createChannel only on Discord + Slack.
  expect(typeof (telegram as any).createChannel).toBe('undefined')
  expect(typeof (github as any).createChannel).toBe('undefined')
  expect(typeof (notion as any).createChannel).toBe('undefined')
  expect(typeof (discord as any).createChannel).toBe('function')
  expect(typeof (slack as any).createChannel).toBe('function')

  // Telegram supports NO discovery calls at all.
  expect(typeof (telegram as any).listChannels).toBe('undefined')
  expect(typeof (telegram as any).listMembers).toBe('undefined')

  // listChannels only on Discord + Slack (GitHub/Notion are listMembers-only).
  expect(typeof (github as any).listChannels).toBe('undefined')
  expect(typeof (notion as any).listChannels).toBe('undefined')
  expect(typeof (discord as any).listChannels).toBe('function')
  expect(typeof (slack as any).listChannels).toBe('function')

  // listMembers present on Discord/Slack/GitHub/Notion, absent on Telegram.
  for (const a of [discord, slack, github, notion]) {
    expect(typeof (a as any).listMembers).toBe('function')
  }
})
