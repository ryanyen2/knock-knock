/**
 * ChannelConfig — the owner `!config` command surface, bound to a scope.
 *
 * The OWNER tunes a channel's behavioral overlay (today: the persona/role brief)
 * in-chat. handleCommand parses the command, and for a set/reset admits an
 * OWNER-ROLE `config.set` to `cfg:channel/<roomId>` (anchor:none → the merge
 * gate is a no-op; the config fold projects it). It NEVER writes access.json or a
 * room settings file — identity, the allowlist, and permissions stay terminal-
 * managed. The owner gate is the agent-host short-circuit that only routes a
 * `!config` here when senderKind==='owner', BEFORE any channel.message admit, so
 * a peer/human (or a prompt injection) can never reach this path.
 *
 * Modeled on WatchControl: thin adapter over a ledger admit, command-only.
 */

import type { HostContext } from './context.ts'
import { admit } from '../ledger/admit.ts'
import type { ChannelId } from '../ledger/interaction.ts'
import {
  CONFIG_FOLD,
  configArtifact,
  configFor,
  latestConfigHash,
  type ConfigFoldState,
} from '../ledger/concepts/config.ts'
import { parseConfigCommand } from '../lib.ts'
import {
  renderConfig,
  renderConfigHelp,
  renderConfigReset,
  renderConfigSet,
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

  /** Owner `!config …`. Validates, and for set/reset admits an owner-role
   *  config.set; get/help just reply. The caller (agent-host) has already gated
   *  this to senderKind==='owner'. */
  async handleCommand(scopeId: ChannelId, text: string): Promise<void> {
    const roomId = this.ctx.roomForScope(scopeId)
    if (!roomId) {
      await this.ctx.discordSend(scopeId, 'No agent serves this channel.')
      return
    }

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
      await this.ctx.discordSend(scopeId, renderConfig(configFor(this.state(), roomId), parsed.key))
      return
    }

    const ownerId = this.ctx.getAccess().agents[this.ctx.key]?.ownerUserId
    if (!ownerId) {
      await this.ctx.discordSend(scopeId, 'No owner configured for this agent.')
      return
    }

    // Chain caused_by onto the artifact's latest config so re-affirming a prior
    // value isn't deduped to the older (earlier) interaction by content hash.
    const latest = latestConfigHash(this.state(), roomId)
    const delta = parsed.action === 'reset' ? { _clear: parsed.keys } : parsed.delta
    await admit(this.ctx.store, {
      actor: ownerId, // the OWNER is the author of the config change
      role: 'owner', // owner-role merge precedence + audit attribution
      channel: roomId, // room-keyed overlay
      target: { artifactId: configArtifact(roomId), anchor: { kind: 'none' } },
      verb: 'config.set',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'config.set', args: delta } },
      effect: 'pure',
      caused_by: latest ? [latest] : [],
    })

    if (parsed.action === 'reset') {
      await this.ctx.discordSend(scopeId, renderConfigReset(parsed.keys))
    } else {
      const field = Object.keys(parsed.delta).find(k => k !== '_clear') ?? 'role'
      await this.ctx.discordSend(
        scopeId,
        renderConfigSet(field, (parsed.delta as Record<string, unknown>)[field]),
      )
    }
  }
}
