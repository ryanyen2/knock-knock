/**
 * Watch concept — the live set of armed watches, folded from the log.
 *
 * The fold IS the watch state; nothing else holds it. `watch.armed` adds (or
 * replaces, by name) a spec; `watch.disarmed` removes it. On relay boot the
 * fold replays, so still-armed watches survive a restart — the WatchSupervisor
 * reconciles real OS processes against this set (watch-supervisor.ts).
 *
 * Keyed `${channel}:${name}` so re-arming the same name in the same channel
 * replaces rather than duplicates — the dedup-key idea borrowed from Claude
 * Code Monitors (docs/knock-knock-watches.md §3).
 */

import type { Fold } from '../fold.ts'
import type { Interaction, ChannelId } from '../interaction.ts'
import type { WatchSpec } from '../../lib.ts'

export type WatchFoldState = ReadonlyMap<string, WatchSpec>

export const WATCH_FOLD = 'watch'

function keyFor(channel: ChannelId, name: string): string {
  return `${channel}:${name}`
}

function argsOf(i: Interaction): { name?: unknown } & Partial<WatchSpec> | undefined {
  return i.patch.kind === 'external' ? (i.patch.intent.args as Partial<WatchSpec>) : undefined
}

export const watchFold: Fold<WatchFoldState> = {
  name: WATCH_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    (i.verb === 'watch.armed' || i.verb === 'watch.disarmed'),
  step: (state, i) => {
    const args = argsOf(i)
    if (!args || typeof args.name !== 'string') return state
    const next = new Map(state)
    const k = keyFor(i.channel, args.name)
    if (i.verb === 'watch.armed') {
      // Trust the channel/agentKey snapshotted on the interaction over whatever
      // the args claim, so a watch always points at where it was armed.
      next.set(k, { ...(args as WatchSpec), channel: i.channel })
    } else {
      next.delete(k)
    }
    return next
  },
}

/** Convenience: the armed watches as a flat list. */
export function liveWatches(state: WatchFoldState): WatchSpec[] {
  return [...state.values()]
}
