/**
 * The Synchronizer — the firing engine for behavior.
 *
 * A Synchronization is a pure function `(newly-admitted interaction, ctx) →
 * proposed interactions`. The Synchronizer subscribes to the store once;
 * for every insert, it asks each registered synchronization whether it
 * `matches` and, if so, calls its `fire`. The synchronization may admit
 * follow-up interactions via `ctx.admit`, which itself triggers more
 * synchronizations — that's how behavior composes (rubric #2: a new
 * behavior is one new synchronization, zero edits to existing concepts).
 *
 * Wave bounding: each "wave" is rooted at one externally-originated
 * insertion (typically a `channel.message` from Discord). Recursive admits
 * inside a synchronization count toward the wave's cap (default 16). When
 * the cap is reached, further admits short-circuit to a denied result and
 * a stderr warning — the cascade cannot run forever. This is the per-wave
 * companion to the per-channel LoopGuard fold that bounds agent↔agent
 * conversation length.
 *
 * Failure isolation: a synchronization that throws is logged and skipped;
 * other synchronizations for the same interaction still fire.
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
      // Fire-and-forget so the store's insert path isn't blocked on async
      // synchronization work. Errors are surfaced inside onInsert.
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
    // If this is the START of a wave (no current root), set ourselves up;
    // otherwise this insert is part of the current wave's cascade.
    const isWaveRoot = !this.currentWave
    if (isWaveRoot) {
      this.currentWave = { rootHash: i.hash, consumed: 0 }
    }

    try {
      // Snapshot the sub list — registrations during firing don't affect this wave.
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
          // Out-of-wave admit (a sync called admit after its fire returned, or
          // a manual call). Allow it but don't count it.
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
