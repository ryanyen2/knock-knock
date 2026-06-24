// WatchControl — watch surface shared by owner `!watch` and the agent's MCP
// tool. A watched command is classified like a Bash call against the room profile.

import type { HostContext } from './context.ts'
import type { Approvals } from '../approvals.ts'
import { discordArtifact, type ChannelId } from '../ledger/interaction.ts'
import { admit } from '../ledger/admit.ts'
import { awaitVerdict, DEFAULT_VERDICT_TIMEOUT_MS } from '../ledger/await-verdict.ts'
import { WATCH_FOLD, liveWatches, type WatchFoldState } from '../ledger/concepts/watch.ts'
import { GLYPHS } from '../ledger/render/surface.ts'
import { classifyTool, parseWatchCommand, resolveRoomProfile, type WatchSpec } from '../lib.ts'
import type { WatchToolHandlers, WatchArmPartial } from '../agent-adapter.ts'
import type { WatchRunEnv } from '../watch-supervisor.ts'

export class WatchControl {
  constructor(
    private readonly ctx: HostContext,
    private readonly approvals: Approvals,
  ) {}

  /** Resolve workspace + permission for a watch. Scope→room resolved first so the
   *  command is classified against the room profile. Undefined if not served here. */
  resolveWatch(spec: WatchSpec): WatchRunEnv | undefined {
    const roomId = this.ctx.roomForScope(spec.channel)
    if (!roomId) return undefined
    const agent = this.ctx.getAccess().agents[this.ctx.key]
    const workspace = agent?.workspace ?? ''
    const decision = classifyTool(resolveRoomProfile(agent?.rooms[roomId]?.profile), {
      toolName: 'Bash',
      subject: spec.command,
    })
    return { workspace, decision }
  }

  /** The watch tool handlers bound to a scope (the agent's MCP tool / owner cmd). */
  toolsFor(scopeId: ChannelId): WatchToolHandlers {
    return {
      // Agent is a proposer: an `ask`-tier command is held for owner approval.
      arm: spec => this.arm(scopeId, spec, { preApproved: false }),
      disarm: name => this.disarm(scopeId, name),
      list: async () => this.listText(scopeId),
    }
  }

  /** Owner `!watch` / `!unwatch` / `!watch list` — the same core as the agent tool. */
  async handleCommand(scopeId: ChannelId, text: string): Promise<void> {
    const parsed = parseWatchCommand(text)
    if (!parsed) {
      await this.ctx.discordSend(
        scopeId,
        'Usage: `!watch <name> on-change|each-line|on-exit|match:<regex> [every=10s ttl=10m max=5 once] <command>`, `!watch list`, or `!unwatch <name>`',
      )
      return
    }
    if (parsed.action === 'list') {
      await this.ctx.discordSend(scopeId, this.listText(scopeId))
      return
    }
    const result =
      parsed.action === 'disarm'
        ? await this.disarm(scopeId, parsed.name)
        : // Owner typed it — that IS the approval; skip the prompt.
          await this.arm(scopeId, parsed.spec, { preApproved: true })
    await this.ctx.discordSend(scopeId, result.message)
  }

  /** Arm a watch, classifying the command like a Bash call: deny → refused,
   *  allow → armed, ask → held for owner ✅/❌ (preApproved skips the prompt). */
  private async arm(
    scopeId: ChannelId,
    partial: WatchArmPartial,
    opts: { preApproved: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    const roomId = this.ctx.roomForScope(scopeId)
    if (!roomId) return { ok: false, message: 'No agent serves this channel.' }
    const spec: WatchSpec = { ...partial, channel: scopeId, agentKey: this.ctx.key }
    const profile = resolveRoomProfile(this.ctx.getAccess().agents[this.ctx.key]?.rooms[roomId]?.profile)
    const decision = classifyTool(profile, {
      toolName: 'Bash',
      subject: spec.command,
    })

    if (decision === 'deny') {
      return {
        ok: false,
        message: `⛔ refused to arm «${spec.name}» — command \`${spec.command}\` hits the deny floor. Not armed.`,
      }
    }

    if (decision === 'ask' && !opts.preApproved) {
      const approved = await this.requestApproval(scopeId, spec)
      if (!approved.ok) return approved // denied or timed out
    }

    await this.admitArmed(scopeId, spec)
    return {
      ok: true,
      message: `⏳ watching «${spec.name}» — ${spec.fireOn.kind} on \`${spec.command}\``,
    }
  }

  /** Post the exact watch command to the owner and block on one ✅/❌. */
  private async requestApproval(
    scopeId: ChannelId,
    spec: WatchSpec,
  ): Promise<{ ok: boolean; message: string }> {
    // Anchor on a `watch.requested` interaction; the owner's verdict caused_by its hash.
    const requested = await admit(this.ctx.store, {
      actor: this.ctx.key,
      role: 'agent',
      channel: scopeId,
      target: { artifactId: discordArtifact(scopeId), anchor: { kind: 'none' } },
      verb: 'watch.requested',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.request', args: spec } },
      effect: 'pure',
      caused_by: [],
    })
    const anchor = requested.interaction.hash

    await this.approvals.postDiscord({
      channelId: scopeId,
      toolRequestedHash: anchor,
      toolName: `watch «${spec.name}» (${spec.fireOn.kind})`,
      input: { command: spec.command },
    })
    const verdict = await awaitVerdict(this.ctx.store, anchor, DEFAULT_VERDICT_TIMEOUT_MS)
    if (verdict.behavior === 'allow') return { ok: true, message: 'approved' }
    return {
      ok: false,
      message: `⛔ watch «${spec.name}» not armed — ${verdict.message ?? 'denied'}.`,
    }
  }

  private async admitArmed(scopeId: ChannelId, spec: WatchSpec): Promise<void> {
    await admit(this.ctx.store, {
      actor: this.ctx.key,
      role: 'agent',
      channel: scopeId,
      target: { artifactId: discordArtifact(scopeId), anchor: { kind: 'none' } },
      verb: 'watch.armed',
      patch: { kind: 'external', intent: { channel: 'tool', op: 'watch.arm', args: spec } },
      effect: 'pure',
      caused_by: [],
    })
  }

  private async disarm(scopeId: ChannelId, name: string): Promise<{ ok: boolean; message: string }> {
    await admit(this.ctx.store, {
      actor: this.ctx.key,
      role: 'agent',
      channel: scopeId,
      target: { artifactId: discordArtifact(scopeId), anchor: { kind: 'none' } },
      verb: 'watch.disarmed',
      patch: {
        kind: 'external',
        intent: { channel: 'tool', op: 'watch.disarm', args: { name, reason: 'requested' } },
      },
      effect: 'pure',
      caused_by: [],
    })
    return { ok: true, message: `${GLYPHS.checkpoint} unwatched «${name}»` }
  }

  private listText(scopeId: ChannelId): string {
    const state = this.ctx.engine.get<WatchFoldState>(WATCH_FOLD)
    const mine = liveWatches(state).filter(w => w.channel === scopeId)
    return mine.length
      ? mine.map(w => `• \`${w.name}\` — ${w.fireOn.kind} — \`${w.command}\``).join('\n')
      : 'No active watches in this channel.'
  }
}
