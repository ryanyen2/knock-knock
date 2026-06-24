/**
 * The Synchronizer — the firing engine for behavior. For each insert, every
 * synchronization that `matches` runs; follow-up `ctx.admit`s are bounded by a
 * per-wave cap (default 16). A throwing synchronization is logged and skipped.
 */

import type { Interaction, ProposedInteraction } from './interaction.ts'
import type { Store } from './store.ts'
import type { FoldEngine } from './fold.ts'
import { admit as gateAdmit, type AdmissionResult } from './admit.ts'

export interface Synchronization {
  name: string
  /** Pre-filter — return true to consider firing for this interaction. */
  matches: (i: Interaction) => boolean
  /** Run the behavior. Use ctx.admit for follow-up proposals (wave-counted). */
  fire: (i: Interaction, ctx: SyncCtx) => Promise<void>
}

export interface SyncCtx {
  store: Store
  engine: FoldEngine
  /** Admit a follow-up proposal under the current wave's cap. */
  admit: (p: ProposedInteraction) => Promise<AdmissionResult | undefined>
}

export type SynchronizerOpts = { waveCap?: number }

const DEFAULT_WAVE_CAP = 16

export class Synchronizer {
  private readonly subs: Synchronization[] = []
  private storeUnsubscribe?: () => void
  /** Tracks how many admits the current synchronization wave has consumed. */
  private currentWave?: { rootHash: string; consumed: number }

  constructor(
    private readonly store: Store,
    private readonly engine: FoldEngine,
    private readonly opts: SynchronizerOpts = {},
  ) {}

  register(s: Synchronization): void {
    if (this.subs.some(x => x.name === s.name)) {
      throw new Error(`synchronization ${s.name} already registered`)
    }
    this.subs.push(s)
  }

  /** Start listening. Returns an unsubscribe; stop() also tears down. */
  start(): () => void {
    if (this.storeUnsubscribe) return this.storeUnsubscribe
    this.storeUnsubscribe = this.store.subscribe(i => {
      // Fire-and-forget so the store's insert path isn't blocked; errors surface inside onInsert.
      void this.onInsert(i)
    })
    return () => this.stop()
  }

  stop(): void {
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = undefined
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async onInsert(i: Interaction): Promise<void> {
    const isWaveRoot = !this.currentWave
    if (isWaveRoot) {
      this.currentWave = { rootHash: i.hash, consumed: 0 }
    }

    try {
      // Snapshot — registrations during firing don't affect this wave.
      const subs = [...this.subs]
      for (const s of subs) {
        if (!s.matches(i)) continue
        try {
          await s.fire(i, this.makeCtx())
        } catch (err) {
          process.stderr.write(
            `sync ${s.name} on ${i.hash.slice(0, 10)} threw: ${err}\n`,
          )
        }
      }
    } finally {
      if (isWaveRoot) this.currentWave = undefined
    }
  }

  private makeCtx(): SyncCtx {
    return {
      store: this.store,
      engine: this.engine,
      admit: async p => {
        const wave = this.currentWave
        if (!wave) {
          // Out-of-wave admit: allow it but don't count it.
          return gateAdmit(this.store, p)
        }
        const cap = this.opts.waveCap ?? DEFAULT_WAVE_CAP
        if (wave.consumed >= cap) {
          process.stderr.write(
            `sync wave ${wave.rootHash.slice(0, 10)} hit cap ${cap}; admit dropped\n`,
          )
          return undefined
        }
        wave.consumed++
        return gateAdmit(this.store, p)
      },
    }
  }
}
