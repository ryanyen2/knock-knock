/**
 * Inbound-attachment ingest timing — the fix for "the bot says 'I don't see a file
 * attached' even though one was". The ingest-attachment sync reads the real
 * (URL-bearing) attachments from the host's in-process side table, NOT the ledger.
 * The Synchronizer subscribes to the store and fires SYNCHRONOUSLY inside admit's
 * insert (store.subscribe → void onInsert → fire runs up to its first await). So if
 * the host populates its side table AFTER `await admit(...)` returns, the sync has
 * already run and seen an empty list — no file.received is ever recorded.
 *
 * These tests reproduce the ordering against a real store + Synchronizer + the real
 * ingestAttachment sync. The host side table is modeled as a Map keyed by the
 * content hash admit derives.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../../src/ledger/store-sqlite.ts'
import { FoldEngine } from '../../src/ledger/fold.ts'
import { Synchronizer } from '../../src/ledger/sync.ts'
import { admit } from '../../src/ledger/admit.ts'
import { hashInteraction } from '../../src/ledger/canonical.ts'
import { ingestAttachment, type IngestAttachment } from '../../src/ledger/synchronizations/ingest-attachment.ts'
import { discordArtifact, type ProposedInteraction } from '../../src/ledger/interaction.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SCOPE = 'SCOPE1'

/** Let the fire-and-forget sync wave (download → materialize → file.received admit) settle. */
const flush = () => new Promise(r => setTimeout(r, 20))

/** Build the inbound channel.message proposal carrying one attachment descriptor. */
function inbound(): ProposedInteraction {
  return {
    actor: 'U1',
    role: 'human',
    channel: SCOPE,
    target: { artifactId: discordArtifact(SCOPE), anchor: { kind: 'none' } },
    verb: 'channel.message',
    patch: {
      kind: 'external',
      intent: {
        channel: 'discord',
        op: 'received',
        args: { text: 'save this file', attachments: [{ name: 'shot.png', sizeBytes: PNG.length }] },
      },
    },
    effect: 'external',
    caused_by: [],
  }
}

/** Wire a real store + Synchronizer + ingestAttachment whose loadAttachments reads a
 *  host side table (Map). Returns helpers + the list of file.received that were admitted. */
function harness() {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  const sideTable = new Map<string, IngestAttachment[]>()
  const sync = new Synchronizer(store, engine)
  sync.register(
    ingestAttachment({
      filesInbound: () => ({ maxBytes: 10 * 1024 * 1024 }),
      loadAttachments: (_scope, hash) => sideTable.get(hash) ?? [],
      download: async () => PNG,
      materialize: async (_s, name) => `inbox/${name}`,
    }),
  )
  sync.start()

  const received = async () => store.listByVerb('file.received')

  return { store, sideTable, received }
}

test('side table populated BEFORE admit → file.received is recorded (the fix)', async () => {
  const { store, sideTable, received } = harness()
  const proposal = inbound()
  const hash = hashInteraction(proposal)
  // Host order: stash the real attachment handles first, THEN admit.
  sideTable.set(hash, [{ name: 'shot.png', url: 'https://cdn/shot.png', sizeBytes: PNG.length }])
  await admit(store, proposal)
  await flush()
  expect((await received()).length).toBe(1)
})

test('side table populated AFTER admit → nothing recorded (the original bug)', async () => {
  const { store, sideTable, received } = harness()
  const proposal = inbound()
  const hash = hashInteraction(proposal)
  // Original (buggy) order: admit first — the sync fires synchronously and sees [].
  await admit(store, proposal)
  sideTable.set(hash, [{ name: 'shot.png', url: 'https://cdn/shot.png', sizeBytes: PNG.length }])
  await flush()
  expect((await received()).length).toBe(0)
})
