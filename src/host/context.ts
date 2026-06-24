// HostContext — the narrow slice of AgentHost its UI collaborators depend on.

import type { MessagingAdapter } from '../messaging-adapter.ts'
import type { Access } from '../lib.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import type { Store } from '../ledger/store.ts'
import type { FoldEngine } from '../ledger/fold.ts'
import type { Ledger } from '../ledger/capture.ts'
import type { ConsoleUI } from '../console-ui.ts'

export type HostContext = {
  readonly key: string
  /** All chat I/O goes through here; no collaborator imports a platform SDK. */
  readonly messaging: MessagingAdapter
  readonly store: Store
  readonly engine: FoldEngine
  readonly ledger: Ledger
  readonly ui: ConsoleUI
  getAccess(): Access
  /** Resolve a task scope to the room this host serves — seam between scope (ledger) and room (permissions). */
  roomForScope(scopeId: ChannelId): ChannelId | undefined
  /** Owner/approver for a scope this host serves (room-resolved), else undefined. */
  getOwnerForChannel(scopeId: ChannelId): string | undefined
  /** Send a chunk to a scope's channel and record the id for self-reply dedup. */
  discordSend(scopeId: ChannelId, text: string): Promise<string | undefined>
  /** Remember a message this host posted (dedup for self-reply / reaction gating). */
  noteBotMsg(id: string): void
  /** Refresh the pinned per-thread config card for a scope. Best-effort, throttled. */
  refreshConfigCard(scopeId: ChannelId): void
}
