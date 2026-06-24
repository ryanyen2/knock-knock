/**
 * WatchControl — the watch tool surface, bound to a scope. Shared by the owner
 * `!watch` command and the agent's `mcp__knock-knock__watch` tool, so both arm
 * through one permission-gated path. A watched command is classified exactly
 * like a Bash call against the room's profile (deny floor included); the
 * WatchSupervisor owns the OS process and the watch.fired admit.
 *
 * See docs/knock-knock-watches.md.
 */

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

  /**
   * Resolve workspace + permission for a watch the WatchSupervisor wants to run.
   * spec.channel is the task scope (a thread); the permission floor is the
   * room's — resolve scope→room so a watched command is classified against the
   * same profile as any Bash call in that room. Undefined if this host doesn't
   * serve the watch's room.
   */
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
      // The agent (via the MCP tool) is a proposer: an `ask`-tier command is
      // held for the owner's one-time approval, not auto-armed.
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
        : // The owner typed the command — that IS the approval; skip the prompt.
          await this.arm(scopeId, parsed.spec, { preApproved: true })
    await this.ctx.discordSend(scopeId, result.message)
  }

  /**
   * Arm a watch. The command is classified exactly like a Bash call:
   *   - `deny`  → refused (the hard floor — never armed, never run).
   *   - `allow` → armed immediately.
   *   - `ask`   → held: the owner gets one ✅/❌ for the exact command, and the
   *               watch arms only on approve. `preApproved` (the owner's own
   *               `!watch`) skips the prompt — typing the command IS the
   *               approval. See docs/knock-knock-watches.md §5.
   */
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
      if (!approved.ok) return approved // denied or timed out — surface the reason
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
    // Anchor the approval on a `watch.requested` interaction (inert to the watch
    // fold). The owner's verdict admits tool.approved/denied caused_by its hash.
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
