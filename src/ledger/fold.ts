/**
 * The fold engine — the only way concepts read state; a Concept's state IS its named fold.
 * Folds MUST be deterministic and order-independent (replay is in `seq` order, not topological).
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
  /** Serializes re-folds so window bookkeeping stays consistent under concurrent lifecycle changes. */
  private refoldChain: Promise<void> = Promise.resolve()
  /** The artifact whose slice the in-flight re-fold is rebuilding, or null. */
  private refoldArtifact: ArtifactId | null = null
  /** Inserts to `refoldArtifact` that arrived during the rebuild's await window,
   *  so the rebuild can re-apply them instead of dropping them. */
  private refoldWindow: Interaction[] = []

  constructor(private readonly store: Store) {
    // One shared store subscription fans out to every registered fold.
    this.storeUnsubscribe = this.store.subscribe(i => {
      // Capture inserts to a slice being rebuilt so the rebuild re-applies them (live-stale race).
      if (this.refoldArtifact !== null && i.target.artifactId === this.refoldArtifact) {
        this.refoldWindow.push(i)
      }
      for (const entry of this.folds.values()) this.applyTo(entry, i)
    })
    // A lifecycle change is an UPDATE, not an insert — re-fold affected folds so the live view tracks it.
    this.lifecycleUnsubscribe = this.store.subscribeLifecycle(hash => this.refold(hash))
  }

  /** Register a fold and bootstrap it from the ledger; after resolve, `get(name)` is synchronous. */
  async register<S>(f: Fold<S>): Promise<void> {
    if (this.folds.has(f.name)) throw new Error(`fold ${f.name} already registered`)
    const entry: FoldEntry<S> = { fold: f, state: f.init(), seen: new Set() }
    this.folds.set(f.name, entry as FoldEntry<unknown>)

    // Replay the store; `seen` prevents double-applying interactions already delivered via subscribe.
    const all = await this.store.listAllSince(0, Number.MAX_SAFE_INTEGER)
    for (const i of all) this.applyTo(entry as FoldEntry<unknown>, i)
  }

  /** Read the current state synchronously. Throws if the fold isn't registered. */
  get<S>(name: string): S {
    const entry = this.folds.get(name)
    if (!entry) throw new Error(`fold ${name} not registered`)
    return entry.state as S
  }

  /** Push notifications of state changes; initial state is delivered eagerly. */
  subscribe<S>(name: string, cb: (state: S, delta: Interaction | undefined) => void): () => void {
    const entry = this.folds.get(name)
    if (!entry) throw new Error(`fold ${name} not registered`)
    const set = this.subscribers.get(name) ?? new Set()
    this.subscribers.set(name, set)
    const wrapped = cb as (state: unknown, delta: Interaction | undefined) => void
    set.add(wrapped)
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
      process.stderr.write(`fold ${entry.fold.name} step threw: ${err}\n`)
      return
    }
    if (notify) this.notify(entry, i)
  }

  /** Fire a fold's subscribers (delta `undefined` for initial/re-fold pushes). Per-subscriber errors isolated. */
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

  /** Re-fold folds whose membership of `hash` depends on its lifecycle. Read-only, so it can't
   *  recurse into admission. Serialized via `refoldChain`. */
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
    // Only this artifact's slice changed: rebuild just it (O(artifact)) into a stripped state.
    // A fold whose state isn't an artifact map falls back to a full rebuild.
    if (affected.every(e => e.state instanceof Map)) {
      this.refoldArtifact = artifactId
      this.refoldWindow = []
      try {
        const slice = await this.store.listByArtifact(artifactId)
        const sliceHashes = new Set(slice.map(i => i.hash))
        // Synchronous from here; inserts that raced the await are captured in refoldWindow and re-applied below.
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

  /** Folds whose `key` verdict differs between an applied and a proposed snapshot of `updated`.
   *  INVARIANT: a lifecycle-keyed fold gates on the admitted|applied set in its `key`, else it stays stale. */
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

  /** Apply one interaction through key + step for a slice rebuild — no `seen` guard, no notify. */
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
