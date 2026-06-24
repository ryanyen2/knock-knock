/** classify-on-tool-request — journal every tool's policy classification.
 *  Audit-only (the adapter enforces via applyPolicy); records tool.classified,
 *  and a tool.denied for deny-tier (owner-authored policy IS an owner denial). */

import type { PermissionProfile } from '../../state.ts'
import { classifyTool, resolveRoomProfile, type ToolDescriptor } from '../../lib.ts'
import type { Synchronization } from '../sync.ts'

export type ReadPolicy = (agentKey: string, channelId: string) => PermissionProfile

/** Relay injects a scope→room `readPolicy`; the no-arg default fails restrictive
 *  (deny-floor-only) so an unwired audit can never read as permissive. */
export function classifyOnToolRequest(opts?: { readPolicy?: ReadPolicy }): Synchronization {
  const readPolicy = opts?.readPolicy ?? (() => resolveRoomProfile(undefined))
  return {
    name: 'classify-on-tool-request',
    matches: i =>
      i.verb === 'tool.requested' &&
      (i.lifecycle === 'admitted' || i.lifecycle === 'applied'),
    fire: async (i, ctx) => {
    if (i.patch.kind !== 'external') return
    const toolName = i.patch.intent.op
    const subject = extractSubject(i.patch.intent.args)

    // For tool.requested, actor IS the agentKey.
    const profile = readPolicy(i.actor, i.channel)
    const descriptor: ToolDescriptor = { toolName, subject }
    const verdict = classifyTool(profile, descriptor)

    const policyActor = `policy:${i.actor}/${i.channel}`

    // anchor=none so it never conflicts.
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
      // Pre-deny by policy; caused_by ties it to the original request.
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
    // allow/ask: no further admit (allow runs; ask flows through the Approvals UX).
    },
  }
}

/** Best-effort subject string from a tool's input (matches classifyTool's deny fields). */
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
