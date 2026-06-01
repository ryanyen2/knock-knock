/**
 * classify-on-tool-request — journal every tool's policy classification.
 *
 * Fires whenever a `tool.requested` admits. Reads the room's permission
 * profile (allow/ask/deny) via state.ts and runs the pure `classifyTool`
 * function from lib.ts to compute the verdict. Records the verdict as a
 * `tool.classified` Interaction. For `deny`, additionally records a
 * `tool.denied` Interaction — the policy is owner-authored, so a deny-tier
 * match IS an owner denial.
 *
 * The synchronization is purely additive: it does NOT change what the
 * adapter does (the adapter has its own copy of the policy via
 * applyPolicy). It journals the decision so the dual-audience audit trail
 * answers "why was this tool blocked" with no external lookup.
 *
 * The SDK runtime suppresses deny-tier tool calls at the runtime boundary
 * (disallowedTools); those never produce a `tool_call` event and therefore
 * never produce a tool.requested. So for SDK agents, this synchronization
 * sees ask/allow only. For ACP agents, every tool surfaces here — the
 * AcpAdapter routes denies through its own deny path inside the adapter,
 * but the ledger captures the full intent regardless. Both are honest;
 * each runtime's blind spots are documented.
 */

import { readRoomSettings, type PermissionProfile } from '../../state.ts'
import { classifyTool, type ToolDescriptor } from '../../lib.ts'
import type { Synchronization } from '../sync.ts'

export type ReadPolicy = (agentKey: string, channelId: string) => PermissionProfile

/**
 * Factory so tests can inject a stub `readPolicy` rather than touching the
 * real STATE_DIR. Production wiring uses `classifyOnToolRequest()` (no args)
 * which defaults to `readRoomSettings` from state.ts.
 */
export function classifyOnToolRequest(opts?: { readPolicy?: ReadPolicy }): Synchronization {
  const readPolicy = opts?.readPolicy ?? readRoomSettings
  return {
    name: 'classify-on-tool-request',
    matches: i =>
      i.verb === 'tool.requested' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
    if (i.patch.kind !== 'external') return
    const toolName = i.patch.intent.op
    const subject = extractSubject(i.patch.intent.args)

    // Policy is per (agentKey, channelId). For tool.requested, actor IS the
    // agentKey (TurnRecorder records tool calls with actor = the agent).
    const profile = readPolicy(i.actor, i.channel)
    const descriptor: ToolDescriptor = { toolName, subject }
    const verdict = classifyTool(profile, descriptor)

    const policyActor = `policy:${i.actor}/${i.channel}`

    // Journal the classification verdict. Anchor=none so it never conflicts.
    await ctx.admit({
      actor: policyActor,
      role: 'owner',
      channel: i.channel,
      target: { artifactId: i.target.artifactId, anchor: { kind: 'none' } },
      verb: 'tool.classified',
      patch: {
        kind: 'external',
        intent: {
          channel: 'tool',
          op: 'classified',
          args: { verdict, toolName, subject },
        },
      },
      effect: 'pure',
      caused_by: [i.hash],
    })

    if (verdict === 'deny') {
      // Pre-deny by policy. caused_by chain ties this to the original request
      // so the audit trace is "tool.requested → tool.classified(deny) →
      // tool.denied(policy)".
      await ctx.admit({
        actor: policyActor,
        role: 'owner',
        channel: i.channel,
        target: { artifactId: i.target.artifactId, anchor: { kind: 'none' } },
        verb: 'tool.denied',
        patch: {
          kind: 'external',
          intent: {
            channel: 'tool',
            op: 'verdict',
            args: { behavior: 'deny', reason: 'policy:deny-tier' },
          },
        },
        effect: 'external',
        caused_by: [i.hash],
      })
    }
    // For 'allow' and 'ask': no further admit here. allow flows through to
    // adapter execution naturally; ask flows through the live Approvals UX
    // (which produces tool.approved or tool.denied with the owner as actor).
    },
  }
}

/** Best-effort string extraction from a tool's input — matches the same
 *  fields classifyTool's deny tier inspects (command, file_path, url, etc.). */
function extractSubject(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return String(input ?? '')
  const r = input as Record<string, unknown>
  for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern']) {
    const v = r[k]
    if (typeof v === 'string' && v) return v
  }
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}
