/** Turn concept — one record per turn, keyed by the turn.prompted hash, with
 *  tool calls + statuses + final reply text. */

import type { Fold } from '../fold.ts'
import type { Hash, Interaction } from '../interaction.ts'
import { stableJson } from '../util.ts'

export type TurnToolCall = {
  hash: Hash
  name: string
  inputJson: string
  status: 'requested' | 'approved' | 'denied' | 'executed' | 'failed'
}

export type TurnState = {
  promptHash: Hash
  channel: string
  agentKey: string
  /** Hash of the channel.message that caused this turn. */
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

/** Resolve the turn (promptHash) an interaction belongs to: itself if it IS the
 *  turn.prompted, else its prompt ancestor; undefined if no known turn owns it. */
export function findTurnForInteraction(state: TurnFoldState, i: Interaction): Hash | undefined {
  if (i.verb === 'turn.prompted') return i.hash
  return findPromptAncestor(state, i)
}

/** Find the turn.prompted ancestor for a child interaction (one-hop lookup). */
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
