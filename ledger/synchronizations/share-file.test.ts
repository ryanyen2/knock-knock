/**
 * share-file tests (U6). Drive fire() with stub deps + a capturing ctx, and a
 * store stub whose claim always succeeds. The secret-floor refusal and the
 * deny→refuse path are the load-bearing ones (no credential ever leaves).
 */

import { test, expect } from 'bun:test'
import { shareFile, type ShareFileDeps } from './share-file.ts'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3])
const SECRET_BYTES = new Uint8Array([...'KEY=AKIAIOSFODNN7EXAMPLE'].map(c => c.charCodeAt(0)))

function request(relpath: string) {
  return {
    hash: 'h_req',
    actor: 'OWNER',
    role: 'owner',
    channel: 'SCOPE1',
    target: { artifactId: 'extp:discord/SCOPE1', anchor: { kind: 'none' } },
    verb: 'file.shared',
    lifecycle: 'applied',
    patch: { kind: 'external', intent: { channel: 'discord', op: 'requested', args: { relpath, requestedBy: 'owner' } } },
  } as any
}

function harness(over: Partial<ShareFileDeps>) {
  const admitted: any[] = []
  const sent: { name: string }[] = []
  const notes: string[] = []
  const deps: ShareFileDeps = {
    resolveFile: over.resolveFile ?? (async (_s, rel) => ({ name: rel.split('/').pop()!, bytes: PDF_BYTES })),
    classify: over.classify ?? (() => 'allow'),
    send:
      over.send ??
      (async (_s, _h, name) => {
        sent.push({ name })
        return true
      }),
    note: over.note ?? ((_s, t) => notes.push(t)),
  }
  const ctx = {
    store: {
      acquireClaim: async () => ({ acquired: true }),
      releaseClaim: async () => {},
    } as any,
    engine: {} as any,
    admit: async (p: any) => {
      admitted.push(p)
      return { kind: 'admitted', interaction: { ...p, hash: 'h_done' } } as any
    },
  }
  return { sync: shareFile(deps), ctx, admitted, sent, notes }
}

test('matches only a file.shared request (op:requested)', () => {
  const { sync } = harness({})
  expect(sync.matches(request('a.pdf'))).toBe(true)
  const completed = request('a.pdf')
  completed.patch.intent.op = 'completed'
  expect(sync.matches(completed)).toBe(false)
  const other = request('a.pdf')
  other.verb = 'channel.message'
  expect(sync.matches(other)).toBe(false)
})

test('an allowed file is sent and recorded file.shared (completed)', async () => {
  const { sync, ctx, admitted, sent } = harness({})
  await sync.fire(request('docs/report.pdf'), ctx as any)
  expect(sent).toEqual([{ name: 'report.pdf' }])
  expect(admitted.length).toBe(1)
  expect(admitted[0].verb).toBe('file.shared')
  expect(admitted[0].patch.intent.op).toBe('completed')
})

test('a credential PATH is refused by the secret scan — never sent', async () => {
  const { sync, ctx, admitted, sent, notes } = harness({
    resolveFile: async () => ({ name: '.env', bytes: PDF_BYTES }),
    classify: () => 'allow', // even if the room would allow it, the path scan blocks
  })
  await sync.fire(request('config/.env'), ctx as any)
  expect(sent.length).toBe(0)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain('credentials')
})

test('a non-secret file the room denies (e.g. strict) is refused by classify', async () => {
  const { sync, ctx, admitted, sent, notes } = harness({
    resolveFile: async () => ({ name: 'report.pdf', bytes: PDF_BYTES }),
    classify: () => 'deny',
  })
  await sync.fire(request('report.pdf'), ctx as any)
  expect(sent.length).toBe(0)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain('not allowed')
})

test('a credential CONTENT in an innocuous path is refused before classify', async () => {
  const { sync, ctx, sent, notes } = harness({
    resolveFile: async () => ({ name: 'notes.txt', bytes: SECRET_BYTES }),
    classify: () => 'allow', // even if permitted, content scan blocks it
  })
  await sync.fire(request('notes.txt'), ctx as any)
  expect(sent.length).toBe(0)
  expect(notes.join(' ')).toContain('credentials')
})

test('ask collapses to allow for an owner-initiated share', async () => {
  const { sync, ctx, sent } = harness({ classify: () => 'ask' })
  await sync.fire(request('report.pdf'), ctx as any)
  expect(sent.length).toBe(1)
})

test('an unresolvable path is noted, nothing sent', async () => {
  const { sync, ctx, sent, notes } = harness({
    resolveFile: async () => ({ error: 'path is outside the workspace' }),
  })
  await sync.fire(request('../../etc/hosts'), ctx as any)
  expect(sent.length).toBe(0)
  expect(notes.join(' ')).toContain('outside the workspace')
})

test('a lost claim means another relay posts — no double send', async () => {
  const { sync, admitted, sent } = harness({})
  const ctx = {
    store: { acquireClaim: async () => ({ acquired: false, currentHolder: 'other' }), releaseClaim: async () => {} },
    engine: {},
    admit: async (p: any) => {
      admitted.push(p)
      return undefined
    },
  }
  await sync.fire(request('report.pdf'), ctx as any)
  expect(sent.length).toBe(0)
  expect(admitted.length).toBe(0)
})
