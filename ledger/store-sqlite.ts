/**
 * SQLite-backed Store. Single-machine, single-process — Phase 0 through 3.
 * Phase 4 introduces store-pg.ts for the shared cross-machine case.
 *
 * `seq` is the store's local insertion order, used only for paging. It is
 * NEVER causal truth: the DAG in `caused_by` is the only authority.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type {
  Interaction,
  Hash,
  ChannelId,
  ArtifactId,
  Verb,
  Lifecycle,
} from './interaction.ts'
import type { Store } from './store.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interaction (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  hash          TEXT NOT NULL UNIQUE,
  actor         TEXT NOT NULL,
  role          TEXT NOT NULL,
  channel       TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  anchor        TEXT NOT NULL,
  verb          TEXT NOT NULL,
  patch         TEXT NOT NULL,
  effect        TEXT NOT NULL,
  caused_by     TEXT NOT NULL,
  lifecycle     TEXT NOT NULL,
  supersedes    TEXT,
  denied_reason TEXT,
  signature     BLOB,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_by_channel  ON interaction (channel, seq);
CREATE INDEX IF NOT EXISTS i_by_artifact ON interaction (artifact_id, seq);
CREATE INDEX IF NOT EXISTS i_by_verb     ON interaction (verb, seq);
CREATE INDEX IF NOT EXISTS i_by_lifecycle ON interaction (lifecycle) WHERE lifecycle != 'applied';

CREATE TABLE IF NOT EXISTS interaction_parent (
  child  TEXT NOT NULL,
  parent TEXT NOT NULL,
  PRIMARY KEY (child, parent)
);
CREATE INDEX IF NOT EXISTS ip_parent ON interaction_parent (parent);
`

type Row = {
  seq: number
  hash: string
  actor: string
  role: string
  channel: string
  artifact_id: string
  anchor: string
  verb: string
  patch: string
  effect: string
  caused_by: string
  lifecycle: string
  supersedes: string | null
  denied_reason: string | null
  signature: Uint8Array | null
  created_at: string
}

function rowToInteraction(r: Row): Interaction {
  const i: Interaction = {
    hash: r.hash,
    actor: r.actor,
    role: r.role as Interaction['role'],
    channel: r.channel,
    target: {
      artifactId: r.artifact_id,
      anchor: JSON.parse(r.anchor),
    },
    verb: r.verb as Interaction['verb'],
    patch: JSON.parse(r.patch),
    effect: r.effect as Interaction['effect'],
    caused_by: JSON.parse(r.caused_by),
    lifecycle: r.lifecycle as Interaction['lifecycle'],
    createdAt: r.created_at,
  }
  if (r.supersedes) i.supersedes = JSON.parse(r.supersedes)
  if (r.denied_reason) i.deniedReason = r.denied_reason
  if (r.signature) i.signature = Buffer.from(r.signature).toString('base64')
  return i
}

export class SqliteStore implements Store {
  private readonly db: Database
  private readonly subscribers = new Set<(i: Interaction) => void>()

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  async append(i: Interaction): Promise<{ inserted: boolean }> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO interaction (
        hash, actor, role, channel, artifact_id, anchor, verb, patch, effect,
        caused_by, lifecycle, supersedes, denied_reason, signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const sigBuf = i.signature ? Buffer.from(i.signature, 'base64') : null
    const result = stmt.run(
      i.hash,
      i.actor,
      i.role,
      i.channel,
      i.target.artifactId,
      JSON.stringify(i.target.anchor),
      i.verb,
      JSON.stringify(i.patch),
      i.effect,
      JSON.stringify(i.caused_by),
      i.lifecycle,
      i.supersedes ? JSON.stringify(i.supersedes) : null,
      i.deniedReason ?? null,
      sigBuf,
      i.createdAt,
    )

    const inserted = result.changes > 0
    if (inserted) {
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO interaction_parent (child, parent) VALUES (?, ?)',
      )
      for (const parent of i.caused_by) ins.run(i.hash, parent)
      for (const cb of this.subscribers) {
        try {
          cb(i)
        } catch (err) {
          process.stderr.write(`store: subscriber threw: ${err}\n`)
        }
      }
    }
    return { inserted }
  }

  async getByHash(hash: Hash): Promise<Interaction | undefined> {
    const r = this.db.prepare('SELECT * FROM interaction WHERE hash = ?').get(hash) as
      | Row
      | null
    return r ? rowToInteraction(r) : undefined
  }

  async latestInChannel(channelId: ChannelId): Promise<Interaction | undefined> {
    const r = this.db
      .prepare('SELECT * FROM interaction WHERE channel = ? ORDER BY seq DESC LIMIT 1')
      .get(channelId) as Row | null
    return r ? rowToInteraction(r) : undefined
  }

  async listByChannel(channelId: ChannelId, sinceSeq = 0): Promise<Interaction[]> {
    const rows = this.db
      .prepare('SELECT * FROM interaction WHERE channel = ? AND seq > ? ORDER BY seq ASC')
      .all(channelId, sinceSeq) as Row[]
    return rows.map(rowToInteraction)
  }

  async listByArtifact(artifactId: ArtifactId, sinceSeq = 0): Promise<Interaction[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM interaction WHERE artifact_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(artifactId, sinceSeq) as Row[]
    return rows.map(rowToInteraction)
  }

  async listByVerb(verb: Verb, sinceSeq = 0): Promise<Interaction[]> {
    const rows = this.db
      .prepare('SELECT * FROM interaction WHERE verb = ? AND seq > ? ORDER BY seq ASC')
      .all(verb, sinceSeq) as Row[]
    return rows.map(rowToInteraction)
  }

  async listAllSince(sinceSeq = 0, limit = 1000): Promise<Interaction[]> {
    const rows = this.db
      .prepare('SELECT * FROM interaction WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(sinceSeq, limit) as Row[]
    return rows.map(rowToInteraction)
  }

  async updateLifecycle(
    hash: Hash,
    lifecycle: Lifecycle,
    extra?: { supersedes?: Hash[]; deniedReason?: string },
  ): Promise<void> {
    this.db
      .prepare(
        'UPDATE interaction SET lifecycle = ?, supersedes = ?, denied_reason = ? WHERE hash = ?',
      )
      .run(
        lifecycle,
        extra?.supersedes ? JSON.stringify(extra.supersedes) : null,
        extra?.deniedReason ?? null,
        hash,
      )
  }

  /**
   * Walk parent edges from `of` until either `maybeAncestor` is found or
   * `maxDepth` is exceeded. Conservative bound — if we hit the depth limit we
   * return false, which the merge gate treats as "concurrent" (safer to flag
   * than miss a real conflict).
   */
  async isAncestor(maybeAncestor: Hash, of: Hash, maxDepth = 64): Promise<boolean> {
    if (maybeAncestor === of) return true
    const stmt = this.db.prepare(
      'SELECT parent FROM interaction_parent WHERE child = ?',
    )
    const seen = new Set<Hash>([of])
    let frontier: Hash[] = [of]
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: Hash[] = []
      for (const node of frontier) {
        const parents = stmt.all(node) as { parent: string }[]
        for (const p of parents) {
          if (p.parent === maybeAncestor) return true
          if (!seen.has(p.parent)) {
            seen.add(p.parent)
            next.push(p.parent)
          }
        }
      }
      frontier = next
    }
    return false
  }

  /**
   * Channel frontier = admitted heads with no admitted children inside this
   * channel. Computed live; the Postgres impl will cache via `channel_frontier`.
   */
  async channelFrontier(channelId: ChannelId): Promise<Hash[]> {
    const rows = this.db
      .prepare(
        `SELECT i.hash FROM interaction i
         WHERE i.channel = ?
           AND i.lifecycle IN ('admitted', 'applied')
           AND NOT EXISTS (
             SELECT 1 FROM interaction_parent ip
             JOIN interaction c ON c.hash = ip.child
             WHERE ip.parent = i.hash
               AND c.channel = ?
               AND c.lifecycle IN ('admitted', 'applied')
           )`,
      )
      .all(channelId, channelId) as { hash: string }[]
    return rows.map(r => r.hash)
  }

  subscribe(cb: (i: Interaction) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  async maxSeq(): Promise<number> {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM interaction').get() as
      | { m: number | null }
      | null
    return r?.m ?? 0
  }

  close(): void {
    this.db.close()
  }
}
