/**
 * HostContext — the slice of AgentHost its UI collaborators depend on.
 *
 * AgentHost was a 1,300-line god object. Its cohesive clusters — the Workbench,
 * the conflict card, session sharing/resume, and watch control — are now
 * separate collaborators in this directory. Each OWNS its own state and reaches
 * the few shared host capabilities through this narrow interface instead of a
 * back-reference to the whole host. AgentHost implements it.
 */

import type { MessagingAdapter } from '../messaging-adapter.ts'
import type { Access } from '../lib.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import type { Store } from '../ledger/store.ts'
import type { FoldEngine } from '../ledger/fold.ts'
import type { Ledger } from '../ledger/capture.ts'
import type { ConsoleUI } from '../console-ui.ts'

export type HostContext = {
  readonly key: string
  /** The messaging platform this host talks to (Discord today). All chat I/O —
   *  send/edit/react/pin/dm/thread — goes through here; no collaborator imports a
   *  platform SDK. */
  readonly messaging: MessagingAdapter
  readonly store: Store
  readonly engine: FoldEngine
  readonly ledger: Ledger
  readonly ui: ConsoleUI
  getAccess(): Access
  /** Resolve a task scope (thread/channel) to the room this host serves, else
   *  undefined. The single seam between scope (ledger) and room (permissions). */
  roomForScope(scopeId: ChannelId): ChannelId | undefined
  /** Owner/approver for a scope this host serves (room-resolved), else undefined. */
  getOwnerForChannel(scopeId: ChannelId): string | undefined
  /** Send a chunk to a scope's channel; returns the posted message id. Thin host
   *  wrapper over `messaging.send` that also records the id for self-reply dedup. */
  discordSend(scopeId: ChannelId, text: string): Promise<string | undefined>
  /** Remember a message this host posted (dedup for self-reply / reaction gating). */
  noteBotMsg(id: string): void
  /** Refresh the pinned per-thread config card for a scope (after a `!config` /
   *  `!context` edit, or when a task thread is created). Best-effort, throttled. */
  refreshConfigCard(scopeId: ChannelId): void
}
