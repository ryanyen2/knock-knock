/**
 * ingest-attachment tests (U4). Drive the sync's fire() with stub deps and a
 * capturing ctx.admit — the pipeline (budget → download → sniff → secret scan →
 * sanitize → materialize → file.received) is exercised without a store, Discord,
 * or disk. The pure decisions themselves are covered in lib.test.ts.
 */

import { test, expect } from 'bun:test'
import { ingestAttachment, type IngestAttachment, type IngestAttachmentDeps } from './ingest-attachment.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ENV_BYTES = new Uint8Array([...'API_KEY=AKIAIOSFODNN7EXAMPLE\nFOO=bar\n'].map(c => c.charCodeAt(0)))
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])

function makeMessage(attachments: { name: string; sizeBytes?: number }[]) {
  return {
    hash: 'h_msg',
    actor: 'U1',
    role: 'human',
    channel: 'SCOPE1',
    verb: 'channel.message',
    lifecycle: 'admitted',
    patch: {
      kind: 'external',
      intent: { channel: 'discord', op: 'received', args: { text: 'hi', attachments } },
    },
  } as any
}

function harness(over: Partial<IngestAttachmentDeps> & { bytesByName?: Record<string, Uint8Array> }) {
  const admitted: any[] = []
  const notes: string[] = []
  const stored: { name: string; bytes: Uint8Array }[] = []
  const bytesByName = over.bytesByName ?? {}
  const deps: IngestAttachmentDeps = {
    filesInbound: over.filesInbound ?? (() => ({ maxBytes: 10 * 1024 * 1024 })),
    loadAttachments:
      over.loadAttachments ??
      ((_s, _h) =>
        Object.keys(bytesByName).map<IngestAttachment>(name => ({
          name,
          url: `https://cdn/${name}`,
          sizeBytes: bytesByName[name]!.length,
        }))),
    download: over.download ?? (async (_s, att) => bytesByName[att.name]),
    materialize:
      over.materialize ??
      (async (_s, safeName, bytes) => {
        stored.push({ name: safeName, bytes })
        return `inbox/${safeName}`
      }),
    note: over.note ?? ((_s, t) => notes.push(t)),
  }
  const ctx = {
    store: {} as any,
    engine: {} as any,
    admit: async (p: any) => {
      admitted.push(p)
      return { kind: 'admitted', interaction: { ...p, hash: `h_${admitted.length}` } } as any
    },
  }
  return { sync: ingestAttachment(deps), ctx, admitted, notes, stored }
}

test('matches only a channel.message that carries attachments', () => {
  const { sync } = harness({})
  expect(sync.matches(makeMessage([{ name: 'a.png' }]))).toBe(true)
  expect(sync.matches(makeMessage([]))).toBe(false)
  const noAtt = makeMessage([{ name: 'x' }])
  noAtt.patch.intent.args = { text: 'hi' }
  expect(sync.matches(noAtt)).toBe(false)
  const notMsg = makeMessage([{ name: 'a.png' }])
  notMsg.verb = 'turn.replied'
  expect(sync.matches(notMsg)).toBe(false)
})

test('a supported file is materialized once and recorded as file.received', async () => {
  const { sync, ctx, admitted, stored } = harness({ bytesByName: { 'shot.png': PNG } })
  await sync.fire(makeMessage([{ name: 'shot.png', sizeBytes: PNG.length }]), ctx as any)
  expect(stored.length).toBe(1)
  expect(admitted.length).toBe(1)
  expect(admitted[0].verb).toBe('file.received')
  expect(admitted[0].patch.intent.op).toBe('ingested')
  expect(admitted[0].patch.intent.args.kind).toBe('image')
  expect(admitted[0].patch.intent.args.relpath).toContain('inbox/')
  expect(admitted[0].caused_by).toEqual(['h_msg'])
})

test('an unsupported type is rejected with a note, nothing recorded', async () => {
  const { sync, ctx, admitted, notes, stored } = harness({ bytesByName: { 'archive.zip': ZIP } })
  await sync.fire(makeMessage([{ name: 'archive.zip', sizeBytes: ZIP.length }]), ctx as any)
  expect(admitted.length).toBe(0)
  expect(stored.length).toBe(0)
  expect(notes.join(' ')).toContain('unsupported')
})

test('a file whose content looks like a secret is refused', async () => {
  const { sync, ctx, admitted, notes } = harness({ bytesByName: { 'notes.txt': ENV_BYTES } })
  await sync.fire(makeMessage([{ name: 'notes.txt', sizeBytes: ENV_BYTES.length }]), ctx as any)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain('credentials')
})

test('an oversize file is rejected before/after download', async () => {
  const { sync, ctx, admitted, notes } = harness({
    filesInbound: () => ({ maxBytes: 4 }), // tiny cap
    bytesByName: { 'big.png': PNG },
  })
  await sync.fire(makeMessage([{ name: 'big.png', sizeBytes: PNG.length }]), ctx as any)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain('too large')
})

test('a failed download is skipped with a note', async () => {
  const { sync, ctx, admitted, notes } = harness({
    loadAttachments: () => [{ name: 'gone.png', url: 'https://cdn/gone.png', sizeBytes: 10 }],
    download: async () => undefined,
  })
  await sync.fire(makeMessage([{ name: 'gone.png', sizeBytes: 10 }]), ctx as any)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain("couldn't fetch")
})

test('a path that escapes the workspace (materialize undefined) is skipped', async () => {
  const { sync, ctx, admitted, notes } = harness({
    bytesByName: { 'shot.png': PNG },
    materialize: async () => undefined,
  })
  await sync.fire(makeMessage([{ name: 'shot.png', sizeBytes: PNG.length }]), ctx as any)
  expect(admitted.length).toBe(0)
  expect(notes.join(' ')).toContain("couldn't store")
})

test('no inbound file capability → sync no-ops (peer/unsupported)', async () => {
  const { sync, ctx, admitted } = harness({
    filesInbound: () => undefined,
    bytesByName: { 'shot.png': PNG },
  })
  await sync.fire(makeMessage([{ name: 'shot.png', sizeBytes: PNG.length }]), ctx as any)
  expect(admitted.length).toBe(0)
})

test('served scope but empty side table (peer relay) → no ingest', async () => {
  const { sync, ctx, admitted } = harness({
    loadAttachments: () => [], // peer didn't receive the message
    bytesByName: { 'shot.png': PNG },
  })
  await sync.fire(makeMessage([{ name: 'shot.png', sizeBytes: PNG.length }]), ctx as any)
  expect(admitted.length).toBe(0)
})
