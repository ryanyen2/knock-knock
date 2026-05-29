/**
 * Turn concept — one record per turn, keyed by the turn.prompted hash, with
 * tool calls + result statuses + final reply text + duration/cost from
 * tool_done if available.
 *
 * Replaces the volatile `LiveTurn.events[]` buffer in dm-courier.ts. The
 * DmCourier subscribes to this fold; on every change, it renders the turn's
 * projection into the owner's DM. Survives restart, replayable from any
 * frontier (rubric #1).
 */

import type { Fold } from '../fold.ts'
import type { Hash, Interaction } from '../interaction.ts'
import { stableJson } from '../util.ts'

export type TurnToolCall = {
  hash: Hash
  name: string
  /** Stable JSON of the tool input — used for stable rendering. */
  inputJson: string
  status: 'requested' | 'approved' | 'denied' | 'executed' | 'failed'
}

export type TurnState = {
  promptHash: Hash
  channel: string
  agentKey: string
  /** Hash of the channel.message that caused this turn (caused_by of the prompt). */
  inboundHash?: Hash
  toolCalls: TurnToolCall[]
  reply?: { hash: Hash; text: string; ts: string }
  startedAt: string
  endedAt?: string
}

export type TurnFoldState = ReadonlyMap<Hash, TurnState>

export const TURN_FOLD = 'turn:lifecycle'

export const turnFold: Fold<TurnFoldState> = {
  name: TURN_FOLD,
  init: () => new Map(),
  key: i =>
    (i.lifecycle === 'admitted' || i.lifecycle === 'applied') &&
    (i.verb === 'turn.prompted' ||
      i.verb === 'turn.replied' ||
      i.verb === 'tool.requested' ||
      i.verb === 'tool.approved' ||
      i.verb === 'tool.denied' ||
      i.verb === 'tool.executed'),
  step: (state, i) => {
    if (i.verb === 'turn.prompted') {
      const next = new Map(state)
      next.set(i.hash, {
        promptHash: i.hash,
        channel: i.channel,
        agentKey: i.actor,
        inboundHash: i.caused_by[0],
        toolCalls: [],
        startedAt: i.createdAt,
      })
      return next
    }

    // Find the prompt this child belongs to by walking caused_by transitively.
    // For Phase 1 we settle for one-hop lookup: every tool.* and turn.replied
    // we record points (directly or via a tool.requested) at the prompt.
    const promptHash = findPromptAncestor(state, i)
    if (!promptHash) return state
    const turn = state.get(promptHash)
    if (!turn) return state

    const next = new Map(state)
    if (i.verb === 'tool.requested' && i.patch.kind === 'external') {
      const tc: TurnToolCall = {
        hash: i.hash,
        name: i.patch.intent.op,
        inputJson: stableJson(i.patch.intent.args),
        status: 'requested',
      }
      next.set(promptHash, { ...turn, toolCalls: [...turn.toolCalls, tc] })
    } else if (i.verb === 'tool.approved' || i.verb === 'tool.denied') {
      const target = i.caused_by[0]
      next.set(promptHash, {
        ...turn,
        toolCalls: turn.toolCalls.map(tc =>
          tc.hash === target
            ? { ...tc, status: i.verb === 'tool.approved' ? 'approved' : 'denied' }
            : tc,
        ),
      })
    } else if (i.verb === 'tool.executed') {
      const target = i.caused_by[0]
      const ok = i.patch.kind === 'external' && i.patch.result?.ok === true
      next.set(promptHash, {
        ...turn,
        toolCalls: turn.toolCalls.map(tc =>
          tc.hash === target ? { ...tc, status: ok ? 'executed' : 'failed' } : tc,
        ),
      })
    } else if (i.verb === 'turn.replied' && i.patch.kind === 'external') {
      const text = (i.patch.intent.args as { text?: string } | undefined)?.text ?? ''
      next.set(promptHash, {
        ...turn,
        reply: { hash: i.hash, text, ts: i.createdAt },
        endedAt: i.createdAt,
      })
    }
    return next
  },
}

/**
 * Find the turn.prompted ancestor for a child interaction. Phase 1 best-effort
 * lookup: check this interaction's caused_by parents, see if any are a known
 * promptHash; if not, look up the parent and check its caused_by. Bounded at
 * depth 4 (turn.replied has prompt + tool.executeds; tool.executed has
 * tool.requested has prompt — 2 hops max).
 */
function findPromptAncestor(state: TurnFoldState, i: Interaction): Hash | undefined {
  for (const parent of i.caused_by) {
    if (state.has(parent)) return parent
    // Walk one more hop — handles tool.executed → tool.requested → turn.prompted.
    for (const turn of state.values()) {
      if (turn.toolCalls.some(tc => tc.hash === parent)) return turn.promptHash
    }
  }
  return undefined
}
