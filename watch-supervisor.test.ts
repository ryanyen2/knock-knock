/**
 * WatchSupervisor: reconciles real (here, fake) processes against the watch
 * fold, runs each output line through watchGate, and admits watch.fired. The
 * deny floor refuses to spawn; one-shot/own lifecycle disarms.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from './ledger/store-sqlite.ts'
import { FoldEngine } from './ledger/fold.ts'
import { admit } from './ledger/admit.ts'
import { watchFold } from './ledger/concepts/watch.ts'
import { WatchSupervisor, type WatchProcess, type WatchRunEnv } from './watch-supervisor.ts'
import type { WatchSpec } from './lib.ts'
import type { ProposedInteraction } from './ledger/interaction.ts'

const CH = 'chan-1'

async function settle(ms = 30) {
  await new Promise(r => setTimeout(r, ms))
}

/** A controllable stand-in for a spawned process. */
class FakeProc implements WatchProcess {
  private queue: string[] = []
  private waiters: ((r: IteratorResult<string>) => void)[] = []
  private done = false
  killed = false
  private exitResolve!: (v: { code: number | null }) => void
  exited = new Promise<{ code: number | null }>(r => (this.exitResolve = r))

  push(line: string) {
    const w = this.waiters.shift()
    if (w) w({ value: line, done: false })
    else this.queue.push(line)
  }
  end(code: number | null = 0) {
    if (this.done) return
    this.done = true
    let w
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true })
    this.exitResolve({ code })
  }
  kill() {
    this.killed = true
    this.end(null)
  }
  get lines(): AsyncIterable<string> {
    const self = this
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          if (self.queue.length) return Promise.resolve({ value: self.queue.shift()!, done: false })
          if (self.done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise(res => self.waiters.push(res))
        },
      }),
    }
  }
}

function armProposal(spec: WatchSpec): ProposedInteraction {
  return {
    actor: spec.agentKey,
    role: 'owner',
    channel: spec.channel,
    target: { artifactId: `extp:discord/${spec.channel}`, anchor: { kind: 'none' } },
    verb: 'watch.armed',
    patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.arm', args: spec } },
    effect: 'pure',
    caused_by: [],
  }
}

async function harness(decision: WatchRunEnv['decision'] = 'allow') {
  const store = new SqliteStore(':memory:')
  const engine = new FoldEngine(store)
  await engine.register(watchFold)
  const procs: FakeProc[] = []
  const sup = new WatchSupervisor({
    store,
    engine,
    resolve: () => ({ workspace: '/tmp', decision }),
    spawn: () => {
      const p = new FakeProc()
      procs.push(p)
      return p
    },
  })
  sup.start()
  return { store, engine, sup, procs }
}

test('supervisor: change watch fires once per distinct line', async () => {
  const { store, sup, procs } = await harness()
  const spec: WatchSpec = { name: 'notes', channel: CH, agentKey: 'bot', command: 'cat x', fireOn: { kind: 'change' } }
  await admit(store, armProposal(spec))
  await settle()
  expect(procs).toHaveLength(1)

  procs[0]!.push('v1')
  procs[0]!.push('v1') // duplicate — no fire
  procs[0]!.push('v2')
  await settle()

  const fired = await store.listByVerb('watch.fired')
  expect(fired).toHaveLength(2)
  expect((fired[0]!.patch as any).intent.args.text).toContain('v1')

  sup.stop()
  store.close()
})

test('supervisor: deny-classified command never spawns and is disarmed', async () => {
  const { store, sup, procs } = await harness('deny')
  const spec: WatchSpec = { name: 'danger', channel: CH, agentKey: 'bot', command: 'rm -rf /', fireOn: { kind: 'each-line' } }
  await admit(store, armProposal(spec))
  await settle()

  expect(procs).toHaveLength(0)
  expect(await store.listByVerb('watch.fired')).toHaveLength(0)
  expect(await store.listByVerb('watch.disarmed')).toHaveLength(1)

  sup.stop()
  store.close()
})

test('supervisor: an ask-classified (owner-approved) watch spawns and fires', async () => {
  // By the time a watch.armed reaches the fold, an `ask` command was approved at
  // arm time; the supervisor only backstops the deny floor, so it must run.
  const { store, sup, procs } = await harness('ask')
  const spec: WatchSpec = { name: 'notes', channel: CH, agentKey: 'bot', command: 'fswatch x', fireOn: { kind: 'each-line' } }
  await admit(store, armProposal(spec))
  await settle()
  expect(procs).toHaveLength(1)

  procs[0]!.push('changed')
  await settle()
  expect(await store.listByVerb('watch.fired')).toHaveLength(1)

  sup.stop()
  store.close()
})

test('supervisor: one-shot fires once then disarms and kills the process', async () => {
  const { store, sup, procs } = await harness()
  const spec: WatchSpec = {
    name: 'ping',
    channel: CH,
    agentKey: 'bot',
    command: 'echo hi',
    fireOn: { kind: 'each-line' },
    oneShot: true,
  }
  await admit(store, armProposal(spec))
  await settle()

  procs[0]!.push('hello')
  await settle()

  expect(await store.listByVerb('watch.fired')).toHaveLength(1)
  expect(await store.listByVerb('watch.disarmed')).toHaveLength(1)
  expect(procs[0]!.killed).toBe(true)

  sup.stop()
  store.close()
})

test('supervisor: re-arming the same name with a new command restarts the child', async () => {
  const { store, sup, procs } = await harness()
  const base: WatchSpec = { name: 'w', channel: CH, agentKey: 'bot', command: 'cmd-v1', fireOn: { kind: 'each-line' } }
  await admit(store, armProposal(base))
  await settle()
  expect(procs).toHaveLength(1)

  await admit(store, armProposal({ ...base, command: 'cmd-v2' }))
  await settle()
  expect(procs).toHaveLength(2) // old killed, new spawned
  expect(procs[0]!.killed).toBe(true)

  sup.stop()
  store.close()
})

test('supervisor: exit watch fires on process exit', async () => {
  const { store, sup, procs } = await harness()
  const spec: WatchSpec = { name: 'job', channel: CH, agentKey: 'bot', command: './train.sh', fireOn: { kind: 'exit' } }
  await admit(store, armProposal(spec))
  await settle()

  procs[0]!.push('working…') // non-exit lines don't fire for kind:exit
  procs[0]!.end(0)
  await settle()

  const fired = await store.listByVerb('watch.fired')
  expect(fired).toHaveLength(1)
  expect((fired[0]!.patch as any).intent.args.text).toContain('exited')

  sup.stop()
  store.close()
})
