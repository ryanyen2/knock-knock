/** Watch concept — the live set of armed watches, folded from the log. Keyed
 *  `${channel}:${name}` so re-arming the same name replaces rather than duplicates. */

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
      // Trust the channel snapshotted on the interaction over the args.
      next.set(k, { ...(args as WatchSpec), channel: i.channel })
    } else {
      next.delete(k)
    }
    return next
  },
}

/** The armed watches as a flat list. */
export function liveWatches(state: WatchFoldState): WatchSpec[] {
  return [...state.values()]
}
