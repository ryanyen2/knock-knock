/**
 * HostContext — the slice of AgentHost its UI collaborators depend on.
 *
 * AgentHost was a 1,300-line god object. Its cohesive clusters — the Workbench,
 * the conflict card, session sharing/resume, and watch control — are now
 * separate collaborators in this directory. Each OWNS its own state and reaches
 * the few shared host capabilities through this narrow interface instead of a
 * back-reference to the whole host. AgentHost implements it.
 */

import type { Client } from 'discord.js'
import type { Access } from '../lib.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import type { Store } from '../ledger/store.ts'
import type { FoldEngine } from '../ledger/fold.ts'
import type { Ledger } from '../ledger/capture.ts'
import type { ConsoleUI } from '../console-ui.ts'

export type HostContext = {
  readonly key: string
  readonly client: Client
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
  /** Send a chunk to a scope's Discord channel; returns the posted message id. */
  discordSend(scopeId: ChannelId, text: string): Promise<string | undefined>
  /** Remember a message this host posted (dedup for self-reply / reaction gating). */
  noteBotMsg(id: string): void
}
