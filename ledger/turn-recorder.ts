/**
 * Per-turn capture state — Phase 0.
 *
 * Owns all the bookkeeping (which tool_call we're awaiting permission for,
 * which executed tools become caused_by parents of the turn.replied, etc) so
 * AgentHost stays a thin Discord ↔ ledger router. Testable without any
 * Discord or adapter mocks: drive the methods directly from a unit test.
 */

import type { AgentEvent } from '../agent-adapter.ts'
import type { Ledger } from './capture.ts'
import type { ChannelId, Hash, Interaction, Role } from './interaction.ts'

export type TurnRecorderCtx = {
  agentKey: string
  approverUserId: string
  channelId: ChannelId
  channelArtifactId: string
}

export type InboundMessage = {
  senderId: string
  senderKind: 'owner' | 'human' | 'agent' | 'unknown'
  messageId: string
  text: string
}

export class TurnRecorder {
  private readonly toolReqByCallId = new Map<string, Hash>()
  private readonly pendingToolCalls: Array<{
    name: string
    inputJson: string
    hash: Hash
  }> = []
  private readonly toolExecutedHashes: Hash[] = []

  private constructor(
    private readonly ledger: Ledger,
    private readonly ctx: TurnRecorderCtx,
    readonly inboundHash: Hash,
    readonly promptHash: Hash,
  ) {}

  /**
   * Record the inbound message + the turn.prompted causal pin. Returns a
   * recorder ready to receive adapter events and verdicts.
   *
   * Phase 3 note: this path is now used only by tests and by legacy callers.
   * In production, `channel.message` is admitted by AgentHost.handleInbound
   * and `turn.prompted` by the prompt-on-message synchronization;
   * drive-turn uses `restore()` below to wrap a recorder around the
   * already-admitted hashes.
   */
  static async beginTurn(
    ledger: Ledger,
    ctx: TurnRecorderCtx,
    msg: InboundMessage,
  ): Promise<TurnRecorder> {
    const prior = await ledger.latestInChannel(ctx.channelId)
    const inbound = await ledger.record({
      actor: msg.senderId,
      role: roleFromKind(msg.senderKind),
      channel: ctx.channelId,
      target: { artifactId: ctx.channelArtifactId, anchor: { kind: 'none' } },
      verb: 'channel.message',
      patch: {
        kind: 'external',
        intent: {
          channel: 'discord',
          op: 'received',
          args: { text: msg.text, messageId: msg.messageId },
        },
      },
      effect: 'external',
      caused_by: prior ? [prior.hash] : [],
    })

    const prompted = await ledger.record({
      actor: ctx.agentKey,
      role: 'agent',
      channel: ctx.channelId,
      target: { artifactId: ctx.channelArtifactId, anchor: { kind: 'none' } },
      verb: 'turn.prompted',
      patch: { kind: 'none' },
      effect: 'pure',
      caused_by: [inbound.hash],
    })

    return new TurnRecorder(ledger, ctx, inbound.hash, prompted.hash)
  }

  /**
   * Construct a recorder around an already-admitted (channel.message,
   * turn.prompted) pair. Used by drive-turn: prompt-on-message has already
   * journaled the prompt; the recorder just needs to track tool.* during
   * the adapter call and journal turn.replied at the end.
   */
  static restore(
    ledger: Ledger,
    ctx: TurnRecorderCtx,
    inboundHash: Hash,
    promptHash: Hash,
  ): TurnRecorder {
    return new TurnRecorder(ledger, ctx, inboundHash, promptHash)
  }

  async onAdapterEvent(event: AgentEvent): Promise<Interaction | undefined> {
    if (event.type === 'tool_call') {
      const inputJson = stableJson(event.input)
      const proxyId = event.toolCallId ?? `local-${this.pendingToolCalls.length}-${event.name}`
      const rec = await this.ledger.record({
        actor: this.ctx.agentKey,
        role: 'agent',
        channel: this.ctx.channelId,
        target: {
          artifactId: `extp:tool/${proxyId}`,
          anchor: { kind: 'proxy', proxyId },
        },
        verb: 'tool.requested',
        patch: {
          kind: 'external',
          intent: { channel: 'tool', op: event.name, args: event.input },
        },
        effect: 'external',
        caused_by: [this.promptHash],
      })
      this.pendingToolCalls.push({ name: event.name, inputJson, hash: rec.hash })
      if (event.toolCallId) this.toolReqByCallId.set(event.toolCallId, rec.hash)
      return rec
    }
    if (event.type === 'tool_result') {
      const parent = event.toolCallId
        ? this.toolReqByCallId.get(event.toolCallId)
        : undefined
      const rec = await this.ledger.record({
        actor: this.ctx.agentKey,
        role: 'agent',
        channel: this.ctx.channelId,
        target: {
          artifactId: `extp:tool/${event.toolCallId ?? 'unknown'}`,
          anchor: event.toolCallId
            ? { kind: 'proxy', proxyId: event.toolCallId }
            : { kind: 'none' },
        },
        verb: 'tool.executed',
        patch: {
          kind: 'external',
          intent: { channel: 'tool', op: 'result', args: {} },
          result:
            event.status === 'completed'
              ? { ok: true, ref: event.toolCallId ?? '' }
              : { ok: false, error: event.status },
        },
        effect: 'external',
        caused_by: parent ? [parent] : [this.promptHash],
      })
      this.toolExecutedHashes.push(rec.hash)
      return rec
    }
    return undefined
  }

  /**
   * Pop the tool.requested hash matching a permission-handler call's
   * (name, input) so the caller can use it as `caused_by` for the verdict
   * it admits via Approvals (Phase 3 replaces in-process onVerdict —
   * verdicts now come back through the ledger, not through this recorder).
   * Falls back to promptHash when no tool_call event was seen yet (race).
   */
  popPendingForVerdict(toolName: string, input: unknown): Hash {
    const inputJson = stableJson(input)
    const idx = this.pendingToolCalls.findIndex(
      p => p.name === toolName && p.inputJson === inputJson,
    )
    return idx >= 0 ? this.pendingToolCalls.splice(idx, 1)[0]!.hash : this.promptHash
  }

  /**
   * Close the turn. caused_by = the prompt + every tool the agent ran, so the
   * reply's causal slice is one fold from a single hash.
   */
  async finishTurn(replyText: string | undefined): Promise<Interaction | undefined> {
    if (!replyText) return undefined
    return this.ledger.record({
      actor: this.ctx.agentKey,
      role: 'agent',
      channel: this.ctx.channelId,
      target: { artifactId: this.ctx.channelArtifactId, anchor: { kind: 'none' } },
      verb: 'turn.replied',
      patch: {
        kind: 'external',
        intent: { channel: 'discord', op: 'reply', args: { text: replyText } },
      },
      effect: 'external',
      caused_by: [this.promptHash, ...this.toolExecutedHashes],
    })
  }
}

function roleFromKind(kind: 'owner' | 'human' | 'agent' | 'unknown'): Role {
  return kind === 'unknown' ? 'agent' : kind
}

function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
