/**
 * The fold engine — the only way concepts read state.
 *
 * A Concept's state IS its named fold over the ledger. There is no other
 * place state lives; this is the load-bearing piece of rubric #1
 * (Replayability). Any imperative `Map<X, Y>` we used to keep on AgentHost
 * is now a registered Fold and is recoverable by replay.
 *
 * The engine maintains state eagerly: subscribe to the store once, fan each
 * incoming interaction to every registered fold whose `key` predicate matches.
 * `get(name)` is synchronous after `register` resolves — bootstrap (replay
 * existing data) is the only async step.
 *
 * Folds MUST be deterministic and order-independent. The engine replays in
 * store-insertion (`seq`) order, NOT `caused_by`-topological order, so a fold's
 * projected state must not depend on the order interactions arrive in.
 * The engine does not enforce determinism — that's a property the fold author
 * carries. Mutation of `state` is fine when it's a fresh value the fold owns
 * (e.g. cloning a Map before set); never mutate an Interaction passed in.
 */

import type { Interaction, Hash, Lifecycle, ArtifactId } from './interaction.ts'
import type { Store } from './store.ts'

export interface Fold<S> {
  /** Unique name. Used as the cache + subscribe key. */
  name: string
  /** Empty starting state. */
  init: () => S
  /** Pre-filter: only interactions where key(i) is true reach `step`. */
  key?: (i: Interaction) => boolean
  /** Pure reducer. May return the same reference when nothing changed. */
  step: (state: S, i: Interaction) => S
}

type FoldEntry<S = unknown> = {
  fold: Fold<S>
  state: S
  /** Hashes seen — prevents double-application across the subscribe/replay race. */
  seen: Set<Hash>
}

export class FoldEngine {
  private readonly folds = new Map<string, FoldEntry>()
  private readonly subscribers = new Map<
    string,
    Set<(state: unknown, delta: Interaction | undefined) => void>
  >()
  private readonly storeUnsubscribe: () => void
  private readonly lifecycleUnsubscribe: () => void
  /** Serializes re-folds so the per-rebuild window bookkeeping stays consistent
   *  under concurrent lifecycle changes. Each re-fold is O(artifact), so this is
   *  cheap. */
  private refoldChain: Promise<void> = Promise.resolve()
  /** The artifact whose slice the in-flight re-fold is rebuilding, or null. */
  private refoldArtifact: ArtifactId | null = null
  /** Inserts to `refoldArtifact` that arrived during the rebuild's await window,
   *  so the rebuild can re-apply them instead of dropping them. */
  private refoldWindow: Interaction[] = []

  constructor(private readonly store: Store) {
    // One shared store subscription fans out to every registered fold so a
    // single SQLite insert triggers at most one notification path.
    this.storeUnsubscribe = this.store.subscribe(i => {
      // While a re-fold is rebuilding an artifact's slice, capture inserts to
      // that artifact so the rebuild re-applies any that land in its await
      // window — otherwise the snapshot would drop them (the live-stale race).
      if (this.refoldArtifact !== null && i.target.artifactId === this.refoldArtifact) {
        this.refoldWindow.push(i)
      }
      for (const entry of this.folds.values()) this.applyTo(entry, i)
    })
    // A lifecycle change (supersede / deny / resolve) is an UPDATE, not an
    // insert, so the subscription above never sees it. Re-fold the affected
    // folds so a superseded interaction leaves the live view immediately and a
    // newly-applied one (a resolved conflict branch) enters it.
    this.lifecycleUnsubscribe = this.store.subscribeLifecycle(hash => this.refold(hash))
  }

  /**
   * Register a fold and bootstrap it from the existing ledger. After this
   * promise resolves, `get(name)` returns up-to-date state synchronously.
   */
  async register<S>(f: Fold<S>): Promise<void> {
    if (this.folds.has(f.name)) throw new Error(`fold ${f.name} already registered`)
    const entry: FoldEntry<S> = { fold: f, state: f.init(), seen: new Set() }
    this.folds.set(f.name, entry as FoldEntry<unknown>)

    // Replay everything currently in the store. Interactions added between
    // construction and now were already delivered via subscribe → applyTo,
    // and `seen` prevents double-application here.
    const all = await this.store.listAllSince(0, Number.MAX_SAFE_INTEGER)
    for (const i of all) this.applyTo(entry as FoldEntry<unknown>, i)
  }

  /**
   * Read the current state synchronously. Throws if the fold isn't registered.
   * Callers should `await register(f)` before depending on `get(f.name)`.
   */
  get<S>(name: string): S {
    const entry = this.folds.get(name)
    if (!entry) throw new Error(`fold ${name} not registered`)
    return entry.state as S
  }

  /**
   * Push notifications of state changes. Initial state is delivered eagerly
   * so the subscriber doesn't need a separate `get` call.
   */
  subscribe<S>(name: string, cb: (state: S, delta: Interaction | undefined) => void): () => void {
    const entry = this.folds.get(name)
    if (!entry) throw new Error(`fold ${name} not registered`)
    const set = this.subscribers.get(name) ?? new Set()
    this.subscribers.set(name, set)
    const wrapped = cb as (state: unknown, delta: Interaction | undefined) => void
    set.add(wrapped)
    // Deliver current state immediately so subscribers don't race with `get`.
    cb(entry.state as S, undefined)
    return () => set.delete(wrapped)
  }

  /** Tear down the store subscriptions. Tests call this; production lets it persist. */
  close(): void {
    this.storeUnsubscribe()
    this.lifecycleUnsubscribe()
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private applyTo(entry: FoldEntry, i: Interaction, notify = true): void {
    if (entry.seen.has(i.hash)) return
    entry.seen.add(i.hash)
    if (entry.fold.key && !entry.fold.key(i)) return
    try {
      entry.state = entry.fold.step(entry.state, i)
    } catch (err) {
      // The ledger is still consistent; only this fold's view is stale.
      process.stderr.write(`fold ${entry.fold.name} step threw: ${err}\n`)
      return
    }
    if (notify) this.notify(entry, i)
  }

  /** Fire a fold's subscribers with the current state and the given delta
   *  (`undefined` for the initial push and post-rebuild re-folds). Per-subscriber
   *  errors are isolated so one bad subscriber can't starve the rest. */
  private notify(entry: FoldEntry, delta: Interaction | undefined): void {
    const subs = this.subscribers.get(entry.fold.name)
    if (!subs) return
    for (const cb of subs) {
      try {
        cb(entry.state, delta)
      } catch (err) {
        process.stderr.write(`fold ${entry.fold.name} subscriber threw: ${err}\n`)
      }
    }
  }

  /**
   * Re-fold the folds whose membership of `hash` depends on its lifecycle, after
   * its lifecycle changed (applied↔superseded/denied, or proposed→applied for a
   * resolved conflict branch). Serialized via `refoldChain` so concurrent
   * lifecycle changes don't interleave the window bookkeeping.
   *
   * Re-fold only reads and recomputes — it appends nothing — so it cannot
   * recurse into admission or the synchronizer, even when triggered
   * synchronously from inside `admit` / `resolveConflict`.
   */
  private refold(hash: Hash): Promise<void> {
    this.refoldChain = this.refoldChain.then(() => this.doRefold(hash))
    return this.refoldChain
  }

  private async doRefold(hash: Hash): Promise<void> {
    const updated = await this.store.getByHash(hash)
    if (!updated) return
    const affected = this.affectedFolds(updated)
    if (affected.length === 0) return

    const artifactId = updated.target.artifactId
    // Affected folds key their state by artifactId, and only this artifact's
    // slice changed — so rebuild just that slice by replaying the artifact's own
    // interactions (O(artifact), not O(all-time)) into a state stripped of the
    // slice. That is exactly what a fresh replay produces. A future affected fold
    // whose state isn't an artifact map falls back to a full rebuild.
    if (affected.every(e => e.state instanceof Map)) {
      this.refoldArtifact = artifactId
      this.refoldWindow = []
      try {
        const slice = await this.store.listByArtifact(artifactId)
        const sliceHashes = new Set(slice.map(i => i.hash))
        // Synchronous from here. Any insert to this artifact that raced the
        // await above was captured in refoldWindow and is re-applied below, so
        // none is dropped.
        for (const entry of affected) {
          const stripped = new Map(entry.state as ReadonlyMap<ArtifactId, unknown>)
          stripped.delete(artifactId)
          let state: unknown = stripped
          for (const i of slice) state = this.rebuildStep(entry, state, i)
          for (const i of this.refoldWindow) {
            if (!sliceHashes.has(i.hash)) state = this.rebuildStep(entry, state, i)
          }
          entry.state = state
        }
      } finally {
        this.refoldArtifact = null
        this.refoldWindow = []
      }
    } else {
      const all = await this.store.listAllSince(0, Number.MAX_SAFE_INTEGER)
      for (const entry of affected) {
        entry.state = entry.fold.init()
        entry.seen = new Set()
        for (const i of all) this.applyTo(entry, i, false)
      }
    }

    for (const entry of affected) this.notify(entry, undefined)
  }

  /**
   * The folds whose membership of `updated` depends on its lifecycle — those whose
   * `key` verdict differs between a live (applied) and a held (proposed) snapshot.
   * That captures both removal (now superseded/denied) and addition (a resolved
   * branch flipping proposed→applied), regardless of direction.
   *
   * INVARIANT this relies on: a lifecycle-keyed fold gates on the admitted|applied
   * set inside its `key`. A future fold that encodes lifecycle-sensitivity only in
   * `step`, or keys on some other lifecycle value, would be missed and stay stale.
   */
  private affectedFolds(updated: Interaction): FoldEntry[] {
    const liveSnap: Interaction = { ...updated, lifecycle: 'applied' as Lifecycle }
    const heldSnap: Interaction = { ...updated, lifecycle: 'proposed' as Lifecycle }
    const affected: FoldEntry[] = []
    for (const entry of this.folds.values()) {
      const key = entry.fold.key
      if (!key) continue // keyless folds see everything; lifecycle never excludes
      if (key(liveSnap) !== key(heldSnap)) affected.push(entry)
    }
    return affected
  }

  /** Apply one interaction through key + step for a slice rebuild — no `seen`
   *  guard, no subscriber notification (those are the live-insert path's job). */
  private rebuildStep(entry: FoldEntry, state: unknown, i: Interaction): unknown {
    if (entry.fold.key && !entry.fold.key(i)) return state
    try {
      return entry.fold.step(state, i)
    } catch (err) {
      process.stderr.write(`fold ${entry.fold.name} step threw: ${err}\n`)
      return state
    }
  }
}
