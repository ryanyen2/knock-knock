/**
 * Postgres-backed Store — Phase 4 cross-machine path.
 *
 * Same contract as SqliteStore (every method, every behavior). Differences
 * from SQLite are syntactic (`$1`/`$2` bind, `JSONB`, `TEXT[]`, `BIGSERIAL`,
 * `BYTEA`) plus one important addition: `subscribe` is driven by
 * `LISTEN interaction_inserted` so a write on machine A becomes a callback
 * on machine B within ~100ms.
 *
 * Bootstrap is in ledger/bootstrap.ts — a new machine joining points at the
 * shared database, runs bootstrap(), then registers FoldEngine. The folds
 * replay every existing interaction (which the engine already does via
 * listAllSince(0) on register), giving the new machine a fully-warm view
 * before any local Discord traffic arrives.
 *
 * Trust model: every host writes interactions for its OWN agents (the
 * agent key in `actor`). Cross-host verification of "did the right host
 * write this?" is the Ed25519 signature path described in plan §9.4 —
 * Phase 4 ships the SQL/wiring; signatures + agent_pubkey table are
 * Phase 4.1 work (deferred to keep this phase scoped).
 */

import { Client, Pool, type PoolClient } from 'pg'
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
  hash         TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  role         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  artifact_id  TEXT NOT NULL,
  anchor       JSONB NOT NULL,
  verb         TEXT NOT NULL,
  patch        JSONB NOT NULL,
  effect       TEXT NOT NULL,
  caused_by    TEXT[] NOT NULL,
  lifecycle    TEXT NOT NULL,
  supersedes   TEXT[],
  denied_reason TEXT,
  signature    BYTEA,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq          BIGSERIAL
);
CREATE INDEX IF NOT EXISTS i_by_channel   ON interaction (channel, seq);
CREATE INDEX IF NOT EXISTS i_by_artifact  ON interaction (artifact_id, seq);
CREATE INDEX IF NOT EXISTS i_by_verb      ON interaction (verb, seq);
CREATE INDEX IF NOT EXISTS i_by_lifecycle ON interaction (lifecycle) WHERE lifecycle <> 'applied';
CREATE INDEX IF NOT EXISTS i_caused_by_gin ON interaction USING gin (caused_by);
CREATE INDEX IF NOT EXISTS i_anchor_gin   ON interaction USING gin (anchor jsonb_path_ops);

CREATE TABLE IF NOT EXISTS interaction_parent (
  child  TEXT NOT NULL,
  parent TEXT NOT NULL,
  PRIMARY KEY (child, parent)
);
CREATE INDEX IF NOT EXISTS ip_parent ON interaction_parent (parent);

CREATE TABLE IF NOT EXISTS channel_frontier (
  channel    TEXT PRIMARY KEY,
  hashes     TEXT[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS external_claim (
  artifact_id  TEXT PRIMARY KEY,
  held_by_hash TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);

-- NOTIFY trigger so other connections (other machines) see new admissions
-- without polling. The payload is the inserted interaction's hash.
CREATE OR REPLACE FUNCTION notify_interaction_inserted() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('interaction_inserted', NEW.hash);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS interaction_inserted_trigger ON interaction;
CREATE TRIGGER interaction_inserted_trigger
  AFTER INSERT ON interaction
  FOR EACH ROW EXECUTE FUNCTION notify_interaction_inserted();
`

type Row = {
  hash: string
  actor: string
  role: string
  channel: string
  artifact_id: string
  anchor: unknown // already-parsed JSONB
  verb: string
  patch: unknown // already-parsed JSONB
  effect: string
  caused_by: string[]
  lifecycle: string
  supersedes: string[] | null
  denied_reason: string | null
  signature: Buffer | null
  created_at: Date
  seq: string // BIGINT comes back as string
}

function rowToInteraction(r: Row): Interaction {
  const i: Interaction = {
    hash: r.hash,
    actor: r.actor,
    role: r.role as Interaction['role'],
    channel: r.channel,
    target: {
      artifactId: r.artifact_id,
      anchor: r.anchor as Interaction['target']['anchor'],
    },
    verb: r.verb as Interaction['verb'],
    patch: r.patch as Interaction['patch'],
    effect: r.effect as Interaction['effect'],
    caused_by: r.caused_by,
    lifecycle: r.lifecycle as Interaction['lifecycle'],
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString(),
  }
  if (r.supersedes) i.supersedes = r.supersedes
  if (r.denied_reason) i.deniedReason = r.denied_reason
  if (r.signature) i.signature = r.signature.toString('base64')
  return i
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const
  private readonly subscribers = new Set<(i: Interaction) => void>()
  private readonly lifecycleSubscribers = new Set<
    (hash: Hash, lifecycle: Lifecycle) => void | Promise<void>
  >()
  /**
   * Hashes this process inserted locally and already delivered to subscribers in
   * `append`. The AFTER-INSERT trigger NOTIFYs *every* insert — including our
   * own, since `pg_notify` reaches all LISTENing sessions on the database — so
   * without this guard the listener would deliver each local write a SECOND time
   * (double turns, double posts). We skip a hash here exactly once when its own
   * echo returns; genuine remote writes (never in this set) flow through.
   */
  private readonly locallyDelivered = new Set<Hash>()
  private listenClient?: Client
  private closed = false
  private reconnectTimer?: ReturnType<typeof setTimeout>

  private constructor(
    private readonly pool: Pool,
    private readonly connStr: string,
  ) {}

  /**
   * Open a pool, ensure the schema exists, and start LISTENing on
   * `interaction_inserted`. The returned store is ready for read/write.
   */
  static async connect(connStr: string, opts?: { poolMax?: number }): Promise<PgStore> {
    const pool = new Pool({ connectionString: connStr, max: opts?.poolMax ?? 4 })
    await pool.query(SCHEMA)
    const store = new PgStore(pool, connStr)
    await store.startListen()
    return store
  }

  private async startListen(): Promise<void> {
    await this.openListener()
  }

  /**
   * Open (or re-open) the dedicated LISTEN client and re-subscribe.
   *
   * A server with idle autosuspend (Neon scales to zero after ~5 min on the free
   * plan) or any transient network drop SEVERS this session — and the `LISTEN`
   * registration is session state, so it's gone on reconnect. Without
   * re-LISTENing, cross-machine NOTIFY silently stops (the single most common
   * "it just stopped syncing" failure). So we reconnect with a fixed backoff and
   * re-issue `LISTEN` on every drop. Note: interactions written by other hosts
   * DURING a disconnect are missed by this listener (they're in the DB, but no
   * notification replays) — restart the relay to fully re-fold, or disable
   * scale-to-zero for an always-on listener. Local in-process subscribers are
   * unaffected; this only concerns cross-machine notifications.
   */
  private async openListener(): Promise<void> {
    if (this.closed) return
    const client = new Client({ connectionString: this.connStr, keepAlive: true })
    client.on('notification', async msg => {
      if (msg.channel !== 'interaction_inserted' || !msg.payload) return
      // Skip the echo of our own local write — `append` already delivered it.
      // (Genuine remote writes are never in this set, so they flow through.)
      if (this.locallyDelivered.delete(msg.payload)) return
      const i = await this.getByHash(msg.payload)
      if (!i) return
      for (const cb of this.subscribers) {
        try {
          cb(i)
        } catch (err) {
          process.stderr.write(`pg store: subscriber threw: ${err}\n`)
        }
      }
    })
    client.on('error', err => {
      process.stderr.write(`pg store: listen client error: ${err}; reconnecting\n`)
      this.scheduleReconnect()
    })
    client.on('end', () => this.scheduleReconnect())
    try {
      await client.connect()
      await client.query('LISTEN interaction_inserted')
      this.listenClient = client
    } catch (err) {
      // Don't crash the relay over a transient listen failure — the query pool
      // still works for local writes; retry the listener in the background.
      process.stderr.write(`pg store: listen connect failed: ${err}; retrying\n`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.openListener()
    }, 3000)
  }

  async append(i: Interaction): Promise<{ inserted: boolean }> {
    const c = await this.pool.connect()
    try {
      const sigBuf = i.signature ? Buffer.from(i.signature, 'base64') : null
      const result = await c.query(
        `INSERT INTO interaction (
          hash, actor, role, channel, artifact_id, anchor, verb, patch, effect,
          caused_by, lifecycle, supersedes, denied_reason, signature, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (hash) DO NOTHING`,
        [
          i.hash,
          i.actor,
          i.role,
          i.channel,
          i.target.artifactId,
          JSON.stringify(i.target.anchor),
          i.verb,
          JSON.stringify(i.patch),
          i.effect,
          i.caused_by,
          i.lifecycle,
          i.supersedes ?? null,
          i.deniedReason ?? null,
          sigBuf,
          i.createdAt,
        ],
      )
      const inserted = (result.rowCount ?? 0) > 0
      if (inserted) {
        await this.writeParents(c, i)
        // Deliver to local in-process subscribers immediately — same semantics
        // as SqliteStore for fold engines on this machine — and remember the
        // hash so the trigger's NOTIFY echo of THIS write is skipped (above).
        this.locallyDelivered.add(i.hash)
        if (this.locallyDelivered.size > 8192) {
          // Backstop: if the listener was down when we wrote, the echo never
          // arrives to evict the hash. Drop the oldest so the set can't grow
          // unbounded — a lingering hash is harmless (the row already exists).
          const oldest = this.locallyDelivered.values().next().value
          if (oldest) this.locallyDelivered.delete(oldest)
        }
        for (const cb of this.subscribers) {
          try {
            cb(i)
          } catch (err) {
            process.stderr.write(`pg store: subscriber threw: ${err}\n`)
          }
        }
      }
      return { inserted }
    } finally {
      c.release()
    }
  }

  private async writeParents(c: PoolClient, i: Interaction): Promise<void> {
    if (i.caused_by.length === 0) return
    const values = i.caused_by
      .map((_, idx) => `($1, $${idx + 2})`)
      .join(', ')
    const args = [i.hash, ...i.caused_by]
    await c.query(
      `INSERT INTO interaction_parent (child, parent) VALUES ${values} ON CONFLICT DO NOTHING`,
      args,
    )
  }

  async getByHash(hash: Hash): Promise<Interaction | undefined> {
    const r = await this.pool.query<Row>('SELECT * FROM interaction WHERE hash = $1', [hash])
    return r.rows[0] ? rowToInteraction(r.rows[0]) : undefined
  }

  async latestInChannel(channelId: ChannelId): Promise<Interaction | undefined> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM interaction WHERE channel = $1 ORDER BY seq DESC LIMIT 1',
      [channelId],
    )
    return r.rows[0] ? rowToInteraction(r.rows[0]) : undefined
  }

  async listByChannel(channelId: ChannelId, sinceSeq = 0): Promise<Interaction[]> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM interaction WHERE channel = $1 AND seq > $2 ORDER BY seq ASC',
      [channelId, sinceSeq],
    )
    return r.rows.map(rowToInteraction)
  }

  async listByArtifact(artifactId: ArtifactId, sinceSeq = 0): Promise<Interaction[]> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM interaction WHERE artifact_id = $1 AND seq > $2 ORDER BY seq ASC',
      [artifactId, sinceSeq],
    )
    return r.rows.map(rowToInteraction)
  }

  async listByVerb(verb: Verb, sinceSeq = 0): Promise<Interaction[]> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM interaction WHERE verb = $1 AND seq > $2 ORDER BY seq ASC',
      [verb, sinceSeq],
    )
    return r.rows.map(rowToInteraction)
  }

  async listAllSince(sinceSeq = 0, limit = 1000): Promise<Interaction[]> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM interaction WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
      [sinceSeq, limit],
    )
    return r.rows.map(rowToInteraction)
  }

  async updateLifecycle(
    hash: Hash,
    lifecycle: Lifecycle,
    extra?: { supersedes?: Hash[]; deniedReason?: string },
  ): Promise<void> {
    await this.pool.query(
      'UPDATE interaction SET lifecycle = $1, supersedes = $2, denied_reason = $3 WHERE hash = $4',
      [lifecycle, extra?.supersedes ?? null, extra?.deniedReason ?? null, hash],
    )
    // Awaited in-process fanout: live folds re-fold so a superseded/denied
    // interaction leaves the live view immediately. This UPDATE is local-only —
    // the NOTIFY trigger fires on INSERT, not UPDATE. Cross-machine convergence
    // does NOT rely on it: the `apply-supersession` synchronization re-derives
    // the supersession on each peer from the winner's immutable `supersedes` op
    // (which DOES cross, via the winner's INSERT NOTIFY) — the AOCM pattern.
    for (const cb of this.lifecycleSubscribers) {
      try {
        await cb(hash, lifecycle)
      } catch (err) {
        process.stderr.write(`store: lifecycle subscriber threw: ${err}\n`)
      }
    }
  }

  async isAncestor(maybeAncestor: Hash, of: Hash, maxDepth = 64): Promise<boolean> {
    if (maybeAncestor === of) return true
    // Recursive CTE bounded by depth.
    const r = await this.pool.query<{ found: boolean }>(
      `WITH RECURSIVE anc(h, d) AS (
         SELECT $1::text, 0
         UNION ALL
         SELECT ip.parent, anc.d + 1
           FROM interaction_parent ip
           JOIN anc ON ip.child = anc.h
          WHERE anc.d < $3
       )
       SELECT EXISTS (SELECT 1 FROM anc WHERE h = $2) AS found`,
      [of, maybeAncestor, maxDepth],
    )
    return r.rows[0]?.found ?? false
  }

  async channelFrontier(channelId: ChannelId): Promise<Hash[]> {
    const r = await this.pool.query<{ hash: string }>(
      `SELECT i.hash FROM interaction i
        WHERE i.channel = $1
          AND i.lifecycle IN ('admitted', 'applied')
          AND NOT EXISTS (
            SELECT 1 FROM interaction_parent ip
            JOIN interaction c ON c.hash = ip.child
            WHERE ip.parent = i.hash
              AND c.channel = $1
              AND c.lifecycle IN ('admitted', 'applied')
          )`,
      [channelId],
    )
    return r.rows.map(x => x.hash)
  }

  subscribe(cb: (i: Interaction) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  subscribeLifecycle(
    cb: (hash: Hash, lifecycle: Lifecycle) => void | Promise<void>,
  ): () => void {
    this.lifecycleSubscribers.add(cb)
    return () => this.lifecycleSubscribers.delete(cb)
  }

  async maxSeq(): Promise<number> {
    const r = await this.pool.query<{ m: string | null }>('SELECT MAX(seq) AS m FROM interaction')
    return r.rows[0]?.m ? Number(r.rows[0].m) : 0
  }

  // ─── External-proxy Claim primitive ───────────────────────────────────────

  async acquireClaim(
    artifactId: ArtifactId,
    holderHash: Hash,
    ttlMs: number,
  ): Promise<{ acquired: boolean; currentHolder?: Hash }> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      // Atomic upsert: take it if free/expired/own, otherwise return current.
      const r = await c.query<{ held_by_hash: string; expires_at: Date }>(
        `INSERT INTO external_claim (artifact_id, held_by_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (artifact_id) DO UPDATE
           SET held_by_hash = EXCLUDED.held_by_hash,
               expires_at = EXCLUDED.expires_at
           WHERE external_claim.expires_at <= now()
              OR external_claim.held_by_hash = EXCLUDED.held_by_hash
         RETURNING held_by_hash, expires_at`,
        [artifactId, holderHash, expiresAt],
      )
      await c.query('COMMIT')
      if (r.rowCount && r.rowCount > 0) return { acquired: true }
      // ON CONFLICT didn't update — someone else's live claim holds.
      const cur = await this.pool.query<{ held_by_hash: string }>(
        'SELECT held_by_hash FROM external_claim WHERE artifact_id = $1',
        [artifactId],
      )
      return { acquired: false, currentHolder: cur.rows[0]?.held_by_hash }
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    } finally {
      c.release()
    }
  }

  async releaseClaim(
    artifactId: ArtifactId,
    holderHash: Hash,
  ): Promise<{ released: boolean }> {
    const r = await this.pool.query(
      'DELETE FROM external_claim WHERE artifact_id = $1 AND held_by_hash = $2',
      [artifactId, holderHash],
    )
    return { released: (r.rowCount ?? 0) > 0 }
  }

  async getClaim(
    artifactId: ArtifactId,
  ): Promise<{ holder: Hash; expiresAt: Date } | undefined> {
    const r = await this.pool.query<{ held_by_hash: string; expires_at: Date }>(
      'SELECT held_by_hash, expires_at FROM external_claim WHERE artifact_id = $1',
      [artifactId],
    )
    const row = r.rows[0]
    if (!row) return undefined
    const expiresAt = new Date(row.expires_at)
    if (expiresAt.getTime() <= Date.now()) return undefined
    return { holder: row.held_by_hash, expiresAt }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    void this.listenClient?.end()
    void this.pool.end()
  }
}
