/**
 * Tests for the event-driven (webhook) intake path and the poll-adapter improvements:
 *  - pure routing/signature/parse helpers (webhook-receiver, github, notion)
 *  - GitHub `ingestWebhook` (ping, issue_comment parse + emit, dedup, repo scoping)
 *  - Notion `ingestWebhook` (verification handshake, signature, comment.created emit)
 *  - Notion edit-in-place (`comments.update`) + capability flip
 * No network: the GitHub issue_comment path is self-contained, and the Notion comment
 * fetch is exercised against a tiny stubbed client.
 */

import { test, expect } from 'bun:test'
import { createHmac } from 'crypto'
import {
  parseWebhookPath,
  routeWebhook,
  type WebhookHost,
} from '../../src/webhook-receiver.ts'
import {
  GitHubMessagingAdapter,
  verifyGitHubSignature,
  parseIssueCommentEvent,
} from '../../src/adapters-msg/github.ts'
import {
  NotionMessagingAdapter,
  verifyNotionSignature,
  normalizeNotionId,
} from '../../src/adapters-msg/notion.ts'
import type { IncomingMessage } from '../../src/messaging-adapter.ts'

// ─── webhook-receiver pure helpers ────────────────────────────────────────────

test('parseWebhookPath: two-segment /<platform>/<botKey> only', () => {
  expect(parseWebhookPath('/github/reviewer')).toEqual({ platform: 'github', botKey: 'reviewer' })
  expect(parseWebhookPath('/notion/docs-bot')).toEqual({ platform: 'notion', botKey: 'docs-bot' })
  expect(parseWebhookPath('/github')).toBeUndefined()
  expect(parseWebhookPath('/a/b/c')).toBeUndefined()
  expect(parseWebhookPath('/')).toBeUndefined()
})

test('routeWebhook: matches on botKey AND platform', () => {
  const hosts: WebhookHost[] = [
    { botKey: 'gh', platform: 'github', ingestWebhook: async () => ({ status: 200 }) },
    { botKey: 'nt', platform: 'notion', ingestWebhook: async () => ({ status: 200 }) },
  ]
  expect(routeWebhook(hosts, { platform: 'github', botKey: 'gh' })?.botKey).toBe('gh')
  expect(routeWebhook(hosts, { platform: 'notion', botKey: 'gh' })).toBeUndefined() // platform mismatch
  expect(routeWebhook(hosts, { platform: 'github', botKey: 'nope' })).toBeUndefined()
})

// ─── GitHub signature + parse ─────────────────────────────────────────────────

test('verifyGitHubSignature: valid HMAC accepted, tampered/missing rejected', () => {
  const secret = 's3cret'
  const body = '{"hello":"world"}'
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  expect(verifyGitHubSignature(secret, body, sig)).toBe(true)
  expect(verifyGitHubSignature(secret, body + 'x', sig)).toBe(false)
  expect(verifyGitHubSignature(secret, body, undefined)).toBe(false)
  expect(verifyGitHubSignature(secret, body, 'sha1=abc')).toBe(false)
})

test('parseIssueCommentEvent: extracts scope/room/author/body; rejects junk', () => {
  const body = JSON.stringify({
    action: 'created',
    comment: { id: 42, body: 'hey @bot', user: { login: 'octocat' }, author_association: 'OWNER' },
    issue: { number: 7 },
    repository: { name: 'widgets', owner: { login: 'acme' } },
  })
  const p = parseIssueCommentEvent(body)
  expect(p).toEqual({
    action: 'created',
    room: 'acme/widgets',
    scope: 'acme/widgets#7',
    commentId: 42,
    authorLogin: 'octocat',
    authorAssociation: 'OWNER',
    body: 'hey @bot',
  })
  expect(parseIssueCommentEvent('not json')).toBeUndefined()
  expect(parseIssueCommentEvent('{}')).toBeUndefined()
})

// ─── GitHub ingestWebhook ─────────────────────────────────────────────────────

function ghEvent(headers: Record<string, string>, payload: unknown) {
  return { headers, body: JSON.stringify(payload) }
}

test('GitHub ingestWebhook: ping → pong', async () => {
  const a = new GitHubMessagingAdapter()
  const res = await a.ingestWebhook({ headers: { 'x-github-event': 'ping' }, body: '{}' })
  expect(res).toEqual({ status: 200, body: 'pong' })
})

test('GitHub ingestWebhook: issue_comment emits one IncomingMessage, dedups on replay', async () => {
  const a = new GitHubMessagingAdapter()
  const seen: IncomingMessage[] = []
  a.onMessage(m => seen.push(m))
  const evt = ghEvent(
    { 'x-github-event': 'issue_comment' },
    {
      action: 'created',
      comment: { id: 99, body: 'do the thing', user: { login: 'dev' }, author_association: 'COLLABORATOR' },
      issue: { number: 3 },
      repository: { name: 'repo', owner: { login: 'org' } },
    },
  )
  expect((await a.ingestWebhook(evt)).status).toBe(200)
  expect((await a.ingestWebhook(evt)).status).toBe(200) // replay
  expect(seen.length).toBe(1)
  expect(seen[0]!.scope).toBe('org/repo#3')
  expect(seen[0]!.authorAssociation).toBe('COLLABORATOR')
  expect(seen[0]!.text).toBe('do the thing')
})

test('GitHub ingestWebhook: trackedRepos scopes which repos are surfaced', async () => {
  const a = new GitHubMessagingAdapter()
  a.configure({ trackedRooms: ['org/allowed'] })
  const seen: IncomingMessage[] = []
  a.onMessage(m => seen.push(m))
  const mk = (owner: string, repo: string, id: number) =>
    ghEvent(
      { 'x-github-event': 'issue_comment' },
      { action: 'created', comment: { id, body: 'x', user: { login: 'u' } }, issue: { number: 1 }, repository: { name: repo, owner: { login: owner } } },
    )
  await a.ingestWebhook(mk('org', 'other', 1))
  await a.ingestWebhook(mk('org', 'allowed', 2))
  expect(seen.map(m => m.scope)).toEqual(['org/allowed#1'])
})

test('GitHub ingestWebhook: bad signature → 401 when a secret is configured', async () => {
  const a = new GitHubMessagingAdapter()
  ;(a as unknown as { webhookSecret: string }).webhookSecret = 'shhh' // avoid a live connect
  const res = await a.ingestWebhook(
    ghEvent({ 'x-github-event': 'issue_comment', 'x-hub-signature-256': 'sha256=bad' }, { action: 'created' }),
  )
  expect(res.status).toBe(401)
})

// ─── Notion signature + ingestWebhook ─────────────────────────────────────────

test('verifyNotionSignature: valid HMAC accepted, junk rejected', () => {
  const token = 'verif-tok'
  const body = '{"type":"comment.created"}'
  const sig = 'sha256=' + createHmac('sha256', token).update(body).digest('hex')
  expect(verifyNotionSignature(token, body, sig)).toBe(true)
  expect(verifyNotionSignature(token, body, undefined)).toBe(false)
  expect(verifyNotionSignature(token + 'x', body, sig)).toBe(false)
})

test('Notion ingestWebhook: verification handshake captures + echoes + logs the token', async () => {
  const a = new NotionMessagingAdapter()
  const res = await a.ingestWebhook({ headers: {}, body: JSON.stringify({ verification_token: 'abc123' }) })
  expect(res.status).toBe(200)
  expect(res.body).toBe('abc123')
  expect(res.log).toContain('abc123') // surfaced to the relay console for the operator
  // Now signed events verify against the captured token.
  const body = JSON.stringify({ type: 'page.updated' })
  const goodSig = 'sha256=' + createHmac('sha256', 'abc123').update(body).digest('hex')
  expect((await a.ingestWebhook({ headers: { 'x-notion-signature': goodSig }, body })).status).toBe(202)
  expect((await a.ingestWebhook({ headers: { 'x-notion-signature': 'sha256=nope' }, body })).status).toBe(401)
})

test('Notion ingestWebhook: comment.created fetches the body and emits', async () => {
  const a = new NotionMessagingAdapter()
  // Stub the client + bot id so the fetch path runs offline.
  ;(a as unknown as { _botUserId: string })._botUserId = 'me'
  ;(a as unknown as { notion: { comments: { retrieve: (args: unknown) => Promise<unknown> } } }).notion = {
    comments: {
      retrieve: async () => ({
        id: 'c1',
        created_by: { id: 'human' },
        rich_text: [{ type: 'text', plain_text: 'please review' }],
        display_name: { resolved_name: 'Ada' },
      }),
    },
  }
  const seen: IncomingMessage[] = []
  a.onMessage(m => seen.push(m))
  // Notion delivers a hyphenated UUID; the emitted scope must be hyphenless so it
  // matches the access.json room key (this is the bug that dropped webhook'd comments).
  const res = await a.ingestWebhook({
    headers: {},
    body: JSON.stringify({
      type: 'comment.created',
      entity: { id: 'c1', type: 'comment' },
      data: { page_id: '38b9163d-2d71-8008-a82f-f34d6e070a5b' },
    }),
  })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(1)
  expect(seen[0]!.scope).toBe('38b9163d2d718008a82ff34d6e070a5b') // hyphenless
  expect(seen[0]!.text).toBe('please review')
  // Replay is deduped.
  await a.ingestWebhook({
    headers: {},
    body: JSON.stringify({ type: 'comment.created', entity: { id: 'c1', type: 'comment' }, data: { page_id: 'page-7' } }),
  })
  expect(seen.length).toBe(1)
})

// ─── Notion edit-in-place ─────────────────────────────────────────────────────

test('Notion capabilities advertise edit:true', () => {
  const a = new NotionMessagingAdapter()
  expect(a.capabilities().edit).toBe(true)
})

test('Notion edit() calls comments.update and returns true', async () => {
  const a = new NotionMessagingAdapter()
  let updatedWith: { comment_id?: string } | undefined
  ;(a as unknown as { notion: { comments: { update: (args: { comment_id: string }) => Promise<unknown> } } }).notion = {
    comments: { update: async args => { updatedWith = args; return {} } },
  }
  const ok = await a.edit({ id: 'c9', scope: 'page-1' }, 'updated status')
  expect(ok).toBe(true)
  expect(updatedWith?.comment_id).toBe('c9')
})
