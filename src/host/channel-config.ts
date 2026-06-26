// ChannelConfigControl — owner `!config` surface; set/reset admits an owner-role
// config.set. Owner-gated upstream; never writes access.json or a settings file.

import type { HostContext } from './context.ts'
import { admit } from '../ledger/admit.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import {
  CONFIG_FOLD,
  buildConfigSet,
  configFor,
  resolveConfigFor,
  latestConfigHash,
  type ConfigFoldState,
} from '../ledger/concepts/config.ts'
import { parseConfigCommand } from '../lib.ts'
import {
  renderConfig,
  renderConfigHelp,
  renderConfigReset,
  renderConfigSet,
  renderResolvedConfig,
} from '../ledger/render/surface.ts'

export class ChannelConfigControl {
  constructor(private readonly ctx: HostContext) {}

  /** The live config-fold state, or an empty view if the fold isn't registered. */
  private state(): ConfigFoldState {
    try {
      return this.ctx.engine.get<ConfigFoldState>(CONFIG_FOLD)
    } catch {
      return new Map()
    }
  }

  /** Owner `!config …`; set/reset admits an owner-role config.set, get/help reply.
   *  Caller has gated this to senderKind==='owner'. */
  async handleCommand(scopeId: ChannelId, text: string): Promise<void> {
    const roomId = this.ctx.roomForScope(scopeId)
    if (!roomId) {
      await this.ctx.discordSend(scopeId, 'No agent serves this channel.')
      return
    }
    // Inside a thread writes the thread overlay by default; top level (or a `room`
    // modifier) writes the room.
    const isThread = scopeId !== roomId

    const parsed = parseConfigCommand(text)
    if (!parsed || parsed.action === 'help') {
      await this.ctx.discordSend(scopeId, renderConfigHelp())
      return
    }
    if (parsed.action === 'error') {
      await this.ctx.discordSend(scopeId, parsed.message)
      return
    }
    if (parsed.action === 'get') {
      // `get room` → room layer only; bare `get` in a thread → resolved thread ⊕ room.
      if (parsed.target === 'room') {
        await this.ctx.discordSend(scopeId, renderConfig(configFor(this.state(), roomId), parsed.key))
      } else {
        await this.ctx.discordSend(
          scopeId,
          renderResolvedConfig(configFor(this.state(), roomId), configFor(this.state(), scopeId), isThread),
        )
      }
      return
    }

    const ownerId = this.ctx.getAccess().agents[this.ctx.key]?.ownerUserId
    if (!ownerId) {
      await this.ctx.discordSend(scopeId, 'No owner configured for this agent.')
      return
    }

    // Route the write to the resolved layer (room when targeted or top-level, else thread).
    const writeScope = parsed.target === 'room' || !isThread ? roomId : scopeId
    const where: 'thread' | 'room' | undefined = !isThread ? undefined : writeScope === roomId ? 'room' : 'thread'

    // Chain caused_by onto the latest config so re-affirming a value isn't hash-deduped.
    const latest = latestConfigHash(this.state(), writeScope)
    const delta = parsed.action === 'reset' ? { _clear: parsed.keys } : parsed.delta
    await admit(this.ctx.store, buildConfigSet(ownerId, writeScope, delta, latest))

    if (parsed.action === 'reset') {
      await this.ctx.discordSend(scopeId, renderConfigReset(parsed.keys))
    } else {
      const field = Object.keys(parsed.delta).find(k => k !== '_clear') ?? 'role'
      await this.ctx.discordSend(
        scopeId,
        renderConfigSet(field, (parsed.delta as Record<string, unknown>)[field], where),
      )
    }
    this.ctx.refreshConfigCard(scopeId)
  }
}
