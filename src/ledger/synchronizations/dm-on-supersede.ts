/** dm-on-supersede — DM the losing agent's owner when the merge gate writes a
 *  supersession note to its inbox. Owner lookup + DM send are injected. */

import type { Synchronization } from '../sync.ts'
import { renderOverrideDm } from '../render/surface.ts'

export type DmOnSupersedeOpts = {
  /** Resolve the owner (Discord user id) for an agent key, or undefined. */
  getOwnerForAgent: (agentKey: string) => string | undefined
  /** Send a DM. Returns best-effort message id. */
  dmSend: (ownerUserId: string, text: string) => Promise<string | undefined>
  /** Human label for a channel id. Defaults to `#<id>`. */
  channelLabel?: (channelId: string) => string
}

const INBOX_RE = /^know:actor\/(.+)\/inbox$/

export function dmOnSupersede(opts: DmOnSupersedeOpts): Synchronization {
  return {
    name: 'dm-on-supersede',
    matches: i =>
      i.verb === 'knowledge.append' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
      i.actor === 'system:merge-gate' &&
      INBOX_RE.test(i.target.artifactId),
    fire: async i => {
      const loser = INBOX_RE.exec(i.target.artifactId)?.[1]
      if (!loser) return
      const ownerId = opts.getOwnerForAgent(loser)
      if (!ownerId) return // not an agent we host, or no owner
      if (i.patch.kind !== 'knowledge' || !i.patch.append) return

      const label = (opts.channelLabel ?? (id => `#${id}`))(i.channel)
      const text = renderOverrideDm({ channelLabel: label, note: i.patch.append.body })
      await opts.dmSend(ownerId, text)
    },
  }
}
