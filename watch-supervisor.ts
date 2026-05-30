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
}

type Running = { spec: WatchSpec; proc: WatchProcess; ttlTimer?: ReturnType<typeof setTimeout> }

function keyFor(spec: WatchSpec): string {
  return `${spec.channel}:${spec.name}`
}

/** Stable signature of the runnable shape — a change means restart the child. */
function sig(spec: WatchSpec): string {
  return JSON.stringify([spec.command, spec.fireOn, spec.ttlMs, spec.maxFires, spec.oneShot])
}

export class WatchSupervisor {
  private readonly running = new Map<string, Running>()
  private unsubscribe?: () => void

  constructor(private readonly opts: WatchSupervisorOpts) {}

  /** Begin reconciling against the watch fold. Idempotent. */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.opts.engine.subscribe<WatchFoldState>(WATCH_FOLD, state =>
      this.reconcile(state),
    )
  }

  /** Stop reconciling and kill every running child. */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const key of [...this.running.keys()]) this.kill(key)
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
      if (!this.running.has(key)) this.startWatch(key, spec)
    }
  }

  private startWatch(key: string, spec: WatchSpec): void {
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
    this.running.set(key, run)
    this.opts.log?.(`watch «${spec.name}» armed: ${spec.fireOn.kind} on \`${spec.command}\``)
    void this.readLoop(key, spec, proc)
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

  private async fire(spec: WatchSpec, text: string): Promise<void> {
    await admit(this.opts.store, {
      actor: spec.agentKey,
      role: 'agent',
      channel: spec.channel,
      target: { artifactId: `extp:discord/${spec.channel}`, anchor: { kind: 'none' } },
      verb: 'watch.fired',
      patch: {
        kind: 'external',
        intent: {
          channel: 'tool',
          op: 'watch.fire',
          args: { name: spec.name, agentKey: spec.agentKey, text, messageId: `watch:${spec.name}` },
        },
      },
      effect: 'external',
      caused_by: [],
    }).catch(err => this.opts.log?.(`watch «${spec.name}» fire admit failed: ${err}`))
  }

  private async disarm(spec: WatchSpec, reason: string): Promise<void> {
    this.kill(keyFor(spec)) // tear down the child before the fold reconciles
    await admit(this.opts.store, {
      actor: spec.agentKey,
      role: 'agent',
      channel: spec.channel,
      target: { artifactId: `extp:discord/${spec.channel}`, anchor: { kind: 'none' } },
      verb: 'watch.disarmed',
      patch: {
        kind: 'external',
        intent: { channel: 'tool', op: 'watch.disarm', args: { name: spec.name, reason } },
      },
      effect: 'pure',
      caused_by: [],
    }).catch(err => this.opts.log?.(`watch «${spec.name}» disarm admit failed: ${err}`))
  }

  private kill(key: string): void {
    const run = this.running.get(key)
    if (!run) return
    this.running.delete(key)
    if (run.ttlTimer) clearTimeout(run.ttlTimer)
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
