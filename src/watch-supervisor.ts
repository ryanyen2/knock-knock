/**
 * WatchSupervisor — the one piece that touches the operating system.
 *
 * It subscribes to the `watch` fold and reconciles desired-vs-running: spawn a
 * long-lived child for each armed watch, kill the child for each watch that
 * leaves the fold. Every stdout line runs through the pure `watchGate`; on a
 * match it admits a `watch.fired` directly against the store — outside any
 * synchronization wave, exactly as AgentHost admits an inbound channel.message.
 *
 * The live child is NOT in the ledger; it's runtime state rebuilt from the fold
 * on boot (the fold replays armed-minus-disarmed watches and our initial
 * subscribe callback re-arms them). The ledger holds the intent; we hold the
 * handle. See docs/knock-knock-watches.md §2.4.
 */

import { admit } from './ledger/admit.ts'
import { discordArtifact } from './ledger/interaction.ts'
import { WATCH_FOLD, type WatchFoldState } from './ledger/concepts/watch.ts'
import { watchGate, FRESH_WATCH_GATE, type WatchSpec, type WatchGateState } from './lib.ts'
import type { Store } from './ledger/store.ts'
import type { FoldEngine } from './ledger/fold.ts'

/** A spawned watch process, abstracted so tests can inject a fake. */
export type WatchProcess = {
  /** Stdout, line by line. Ends when the process exits or is killed. */
  lines: AsyncIterable<string>
  /** Resolves with the exit code once the process ends. */
  exited: Promise<{ code: number | null }>
  /** Terminate the process (idempotent). */
  kill: () => void
}

/** Where + whether a watch's command may run, resolved per owning host. */
export type WatchRunEnv = { workspace: string; decision: 'allow' | 'ask' | 'deny' }

export type WatchSupervisorOpts = {
  store: Store
  engine: FoldEngine
  /** Resolve workspace + permission for a watch. undefined = no host owns it here. */
  resolve: (spec: WatchSpec) => WatchRunEnv | undefined
  /** Spawn the command as a long-running process. Injectable for tests. */
  spawn: (command: string, cwd: string) => WatchProcess
  log?: (msg: string) => void
  /** This relay's unique id. With several relays sharing one (Postgres) ledger
   *  and serving the same agent, each would otherwise spawn the watch command —
   *  running it N times with N output streams. When set, a relay must win a
   *  cross-relay claim on the watch's identity before spawning, so the command
   *  runs on exactly one machine (with failover when the owner's claim lapses).
   *  Omit for a single-relay setup. */
  relayId?: string
  /** TTL for the single-owner spawn claim; renewed at half-TTL while running. */
  claimTtlMs?: number
}

type Running = {
  spec: WatchSpec
  proc: WatchProcess
  ttlTimer?: ReturnType<typeof setTimeout>
  claimTimer?: ReturnType<typeof setInterval>
}

function keyFor(spec: WatchSpec): string {
  return `${spec.channel}:${spec.name}`
}

/**
 * Stable signature of the runnable shape — a change means restart the child.
 * Everything EXCEPT the identity (name/channel/agentKey) is part of the shape,
 * so any field added to WatchSpec is captured automatically rather than being
 * silently excluded from the restart decision.
 */
function sig(spec: WatchSpec): string {
  const { name: _n, channel: _c, agentKey: _a, ...runnable } = spec
  return JSON.stringify(runnable, Object.keys(runnable).sort())
}

export class WatchSupervisor {
  private readonly running = new Map<string, Running>()
  /** Keys whose async startWatch (claim acquisition) is in flight, so a second
   *  reconcile tick doesn't try to start the same watch twice before it lands
   *  in `running`. */
  private readonly starting = new Set<string>()
  private unsubscribe?: () => void
  /** Periodic failover tick (multi-relay only): re-reconcile against the current
   *  fold so a standby relay re-attempts a lapsed single-owner claim even when
   *  the fold is quiescent (the owner relay died). */
  private reconcileTimer?: ReturnType<typeof setInterval>
  /** Set by stop() so an in-flight startWatch that resolves its claim after
   *  shutdown doesn't spawn a child or start a renewal timer no one will clear. */
  private stopped = false

  constructor(private readonly opts: WatchSupervisorOpts) {}

  /** Begin reconciling against the watch fold. Idempotent. */
  start(): void {
    if (this.unsubscribe) return
    this.stopped = false
    this.unsubscribe = this.opts.engine.subscribe<WatchFoldState>(WATCH_FOLD, state =>
      this.reconcile(state),
    )
    // Failover only matters with multiple relays. The fold subscription alone
    // never re-fires on a quiescent fleet, so a dead owner's lapsed claim would
    // never be retaken; a half-TTL tick re-reconciles to take it over.
    if (this.opts.relayId) {
      const ttl = this.opts.claimTtlMs ?? 30_000
      this.reconcileTimer = setInterval(
        () => this.reconcile(this.opts.engine.get<WatchFoldState>(WATCH_FOLD)),
        Math.max(1_000, Math.floor(ttl / 2)),
      )
    }
  }

  /** Stop reconciling and kill every running child. */
  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = undefined
    for (const key of [...this.running.keys()]) this.kill(key)
    // A startWatch awaiting acquireClaim won't be in `running` yet; clear the
    // in-flight set so a later start() isn't blocked, and the `stopped` flag
    // makes those awaits return without spawning.
    this.starting.clear()
  }

  // ─── Reconciliation ─────────────────────────────────────────────────────────

  private reconcile(state: WatchFoldState): void {
    const desired = new Set(state.keys())
    // Stop watches that left the fold (disarmed / replaced).
    for (const key of [...this.running.keys()]) {
      if (!desired.has(key)) this.kill(key)
    }
    // Start watches that are armed but not yet running; restart any whose spec
    // changed under the same name (re-arm with a new command/gate).
    for (const [key, spec] of state) {
      const run = this.running.get(key)
      if (run && sig(run.spec) !== sig(spec)) this.kill(key)
      if (!this.running.has(key) && !this.starting.has(key)) void this.startWatch(key, spec)
    }
  }

  private async startWatch(key: string, spec: WatchSpec): Promise<void> {
    if (this.stopped || this.starting.has(key) || this.running.has(key)) return
    // Guard ALL paths through this async function (not just the claim block), so
    // a second reconcile tick can't double-dispatch — and double-spawn — a watch
    // before the first lands in `running`, including the single-relay (no claim)
    // case. Cleared in finally once the watch is running or declined.
    this.starting.add(key)
    try {
      const env = this.opts.resolve(spec)
      if (!env) {
        this.opts.log?.(`watch «${spec.name}»: no host owns ${spec.channel} here — not started`)
        return
      }
      if (env.decision === 'deny') {
        // Deny floor backstop: a watch.armed only reaches the fold after arm-time
        // gating (allow, or an owner-approved `ask`), but the supervisor still
        // refuses to RUN a command that hits the hard floor, however it got armed.
        this.opts.log?.(`watch «${spec.name}»: command hits the deny floor — refusing`)
        void this.disarm(spec, 'command hits the deny floor')
        return
      }

      // Single-owner election: across relays sharing the ledger, exactly one runs
      // the command. The claim key is the watch's stable identity (same on every
      // relay), so the first to acquire spawns; the others stand by and a later
      // reconcile retries — taking over if the owner's claim lapses (failover).
      const claimKey = `watch-run/${spec.agentKey}/${spec.channel}/${spec.name}`
      const ttl = this.opts.claimTtlMs ?? 30_000
      if (this.opts.relayId) {
        try {
          const lock = await this.opts.store.acquireClaim(claimKey, this.opts.relayId, ttl)
          if (!lock.acquired) {
            this.opts.log?.(`watch «${spec.name}»: another relay owns the run — standing by`)
            return
          }
        } catch (err) {
          this.opts.log?.(`watch «${spec.name}»: claim failed: ${err}`)
          return
        }
        // Re-check after the await: a stop() or kill/disarm may have landed.
        if (this.stopped || this.running.has(key)) return
      }

      let proc: WatchProcess
      try {
        proc = this.opts.spawn(spec.command, env.workspace)
      } catch (err) {
        this.opts.log?.(`watch «${spec.name}»: spawn failed: ${err}`)
        void this.disarm(spec, `spawn failed: ${err}`)
        return
      }

      const run: Running = { spec, proc }
      if (spec.ttlMs !== undefined) {
        run.ttlTimer = setTimeout(() => void this.disarm(spec, 'ttl expired'), spec.ttlMs)
      }
      // Renew the spawn claim at half-TTL so ownership survives a long-running
      // watch; on kill the timer is cleared and the claim lapses, enabling failover.
      if (this.opts.relayId) {
        run.claimTimer = setInterval(() => {
          // Log transient renewal failures (DB pressure) rather than swallowing:
          // a silently-lapsed claim lets another relay double-spawn the command.
          void this.opts.store
            .acquireClaim(claimKey, this.opts.relayId!, ttl)
            .catch(err => this.opts.log?.(`watch «${spec.name}»: claim renewal failed: ${err}`))
        }, Math.max(1_000, Math.floor(ttl / 2)))
      }
      this.running.set(key, run)
      this.opts.log?.(`watch «${spec.name}» armed: ${spec.fireOn.kind} on \`${spec.command}\``)
      void this.readLoop(key, spec, proc)
    } finally {
      this.starting.delete(key)
    }
  }

  private async readLoop(key: string, spec: WatchSpec, proc: WatchProcess): Promise<void> {
    let gate: WatchGateState = FRESH_WATCH_GATE
    try {
      for await (const line of proc.lines) {
        if (!this.running.has(key)) return // killed mid-stream
        const r = watchGate(spec, gate, line)
        gate = r.next
        if (r.fire) {
          await this.fire(spec, r.text!)
          if (await this.maybeComplete(spec, gate)) return
        }
      }
      // Stream ended → the process exited. Give `fireOn: exit` its one shot.
      const { code } = await proc.exited
      const r = watchGate(spec, gate, `code ${code}`, true)
      if (r.fire) await this.fire(spec, r.text!)
      if (this.running.has(key)) await this.disarm(spec, 'process exited')
    } catch (err) {
      this.opts.log?.(`watch «${spec.name}» read loop error: ${err}`)
      if (this.running.has(key)) await this.disarm(spec, `error: ${err}`)
    }
  }

  /** Disarm if the spec's one-shot / max-fires budget is spent. */
  private async maybeComplete(spec: WatchSpec, gate: WatchGateState): Promise<boolean> {
    const done =
      spec.oneShot === true || (spec.maxFires !== undefined && gate.fires >= spec.maxFires)
    if (done) {
      await this.disarm(spec, spec.oneShot ? 'one-shot' : 'max fires reached')
      return true
    }
    return false
  }

  // ─── Ledger writes (outside any wave, like AgentHost.handleInbound) ──────────

  /** One watch.* ledger write — fire and disarm share everything but the verb,
   *  op, args, and effect (fire is an external-world trigger; disarm is pure). */
  private async admitWatchEvent(
    spec: WatchSpec,
    verb: 'watch.fired' | 'watch.disarmed',
    op: string,
    args: Record<string, unknown>,
    effect: 'pure' | 'external',
  ): Promise<void> {
    await admit(this.opts.store, {
      actor: spec.agentKey,
      role: 'agent',
      channel: spec.channel,
      target: { artifactId: discordArtifact(spec.channel), anchor: { kind: 'none' } },
      verb,
      patch: { kind: 'external', intent: { channel: 'tool', op, args } },
      effect,
      caused_by: [],
    }).catch(err => this.opts.log?.(`watch «${spec.name}» ${verb} admit failed: ${err}`))
  }

  private async fire(spec: WatchSpec, text: string): Promise<void> {
    await this.admitWatchEvent(
      spec,
      'watch.fired',
      'watch.fire',
      { name: spec.name, agentKey: spec.agentKey, text, messageId: `watch:${spec.name}` },
      'external',
    )
  }

  private async disarm(spec: WatchSpec, reason: string): Promise<void> {
    this.kill(keyFor(spec)) // tear down the child before the fold reconciles
    await this.admitWatchEvent(spec, 'watch.disarmed', 'watch.disarm', { name: spec.name, reason }, 'pure')
  }

  private kill(key: string): void {
    const run = this.running.get(key)
    if (!run) return
    this.running.delete(key)
    if (run.ttlTimer) clearTimeout(run.ttlTimer)
    // Stop renewing the single-owner claim so it lapses and another relay can
    // take over the run (failover); no explicit release — TTL hands it off.
    if (run.claimTimer) clearInterval(run.claimTimer)
    try {
      run.proc.kill()
    } catch {}
  }
}

/** Default production spawn: a bash child whose stdout is streamed line by line. */
export function bunSpawn(command: string, cwd: string): WatchProcess {
  const proc = Bun.spawn(['bash', '-lc', command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    lines: streamLines(proc.stdout as ReadableStream<Uint8Array>),
    exited: proc.exited.then(code => ({ code })),
    kill: () => {
      try {
        proc.kill()
      } catch {}
    },
  }
}

async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        yield buf.slice(0, nl)
        buf = buf.slice(nl + 1)
      }
    }
    if (buf.length > 0) yield buf
  } finally {
    reader.releaseLock()
  }
}
