#!/usr/bin/env bun
/**
 * `kk doctor` — run the resolver in REPORT-ONLY mode plus trust-integrity assertions. Per channel
 * it checks token validity, channel membership, owner-ID resolution, and workspace existence, each
 * with a specific fix; it surfaces pending discoveries as first-class output and marks any channel
 * with outstanding proposals not-yet-complete (R16/R17). It writes NOTHING (no access.json, no
 * pending.json) and publishes no beacon: connecting a raw adapter resolves self-ID but never calls
 * the host's publishIdentity, so the converged directory is untouched (KTD5). Cross-machine
 * discovery is read from pending.json; when the relay's lastScanAt heartbeat is stale or absent it
 * reports "unavailable (relay offline)" rather than "none".
 */

import { existsSync } from 'fs'
import color from 'picocolors'
import { readAuthoringAccess, readPending, readTrustAnchors, type PendingStore } from './state.ts'
import { connectDiscoveryAdapter, assembleSnapshot, itemsOf } from './discovery.ts'
import {
  resolveGaps,
  detectCollision,
  confirmedIdentitiesFor,
  type AuthoringAccess,
  type Proposal,
  type TrustAnchors,
} from './lib.ts'

/** A single diagnostic line: pass/fail + a fix when it fails. */
export type DoctorCheck = { ok: boolean; label: string; fix?: string }

/** How long without a relay heartbeat before cross-machine discovery is "unavailable". */
export const RELAY_STALE_MS = 120_000
/** A pending proposal older than this is flagged as aging (the owner hasn't acted). */
export const PROPOSAL_STALE_MS = 24 * 60 * 60 * 1000

/** Cross-machine discovery availability, derived from the relay's lastScanAt heartbeat (KTD3): a
 *  stale/absent heartbeat is "relay offline" (ambiguous with "no peers" otherwise); a fresh
 *  heartbeat with no proposals is genuinely "none". Pure. */
export function crossMachineStatus(
  pending: PendingStore,
  nowMs: number,
  staleMs = RELAY_STALE_MS,
): 'unavailable-relay-offline' | 'none' | 'available' {
  const beat = pending.lastScanAt ? Date.parse(pending.lastScanAt) : NaN
  const fresh = Number.isFinite(beat) && nowMs - beat < staleMs
  if (!fresh) return 'unavailable-relay-offline'
  return pending.proposals.some(p => p.status === 'proposed') ? 'available' : 'none'
}

/** A one-line summary + age for a pending proposal. Pure. */
export function pendingSummary(p: Proposal, nowMs: number): { summary: string; stale: boolean } {
  const ageMs = nowMs - (Date.parse(p.discoveredAt) || nowMs)
  const who = p.claimed.label ? `${p.claimed.label} (${p.targetId})` : p.targetId
  const what =
    p.kind === 'peer' ? `peer ${who}`
    : p.kind === 'collaborator' ? `collaborator ${who}`
    : p.kind === 'transport' ? `transport channel on ${p.platform}`
    : `${p.kind} ${who}`
  return { summary: what, stale: ageMs > PROPOSAL_STALE_MS }
}

/** Trust-integrity assertions over what doctor can see — access.json + pending.json + the
 *  terminal-owned trust anchors (R23/R24/R25 + the R11 impersonation guard). All pure. A clean run
 *  returns a single ok=true line. */
export function integrityChecks(authoring: AuthoringAccess, pending: PendingStore, trust: TrustAnchors): DoctorCheck[] {
  const out: DoctorCheck[] = []
  const peerProps = pending.proposals.filter(
    p => p.kind === 'peer' && p.claimed.agentKey && p.claimed.userId,
  )
  const localKeys = new Set(Object.keys(authoring.bots))

  // R25 — a pending peer's claimed id equals the confirmed owner / a confirmed human / a different-key peer.
  for (const p of peerProps) {
    const col = detectCollision(
      { agentKey: p.claimed.agentKey!, userId: p.claimed.userId! },
      confirmedIdentitiesFor(authoring, p.platform),
    )
    if (col) {
      out.push({
        ok: false,
        label: `pending peer ${p.claimed.userId} collides with your confirmed ${col.kind}`,
        fix: 'decline this proposal — it claims an id you already trust as someone else',
      })
    }
  }
  // R24 — a trusted (agent-key, user-id) pair whose live beacon now claims a different user-id.
  for (const tp of trust.trustedPairs) {
    const diverged = peerProps.find(p => p.claimed.agentKey === tp.agentKey && p.claimed.userId !== tp.userId)
    if (diverged) {
      out.push({
        ok: false,
        label: `trusted key ${tp.agentKey} now claims a different user-id (${diverged.claimed.userId} ≠ ${tp.userId})`,
        fix: 're-confirm before trusting — the key may have been taken over',
      })
    }
  }
  // R23 — a pending peer that is ALSO already confirmed in the roster (a stale, not-yet-reconciled entry).
  for (const p of peerProps) {
    const confirmed = Object.values(authoring.roster.peers).some(
      x => x.platform === p.platform && x.userId === p.claimed.userId,
    )
    if (confirmed) {
      out.push({
        ok: false,
        label: `pending peer ${p.claimed.userId} is already confirmed in the roster (stale pending entry)`,
        fix: 'run the relay to reconcile pending.json, or re-run doctor',
      })
    }
  }
  // R11 — a remote beacon impersonating one of this machine's local agent-keys (co-residence is
  // decided ONLY by local hosting, never by a beacon).
  for (const p of peerProps) {
    if (p.claimed.agentKey && localKeys.has(p.claimed.agentKey)) {
      out.push({
        ok: false,
        label: `a remote beacon claims your local agent-key "${p.claimed.agentKey}"`,
        fix: 'do not confirm — co-residence is local-hosting only, never inferred from a beacon',
      })
    }
  }

  if (out.length === 0) {
    out.push({ ok: true, label: 'no trust-integrity issues (collisions, key divergence, impersonation)' })
  }
  return out
}

// ─── live per-channel checks + console rendering (impure) ─────────────────────

const mark = (ok: boolean): string => (ok ? color.green('✓') : color.red('✗'))

function printCheck(c: DoctorCheck): void {
  console.log(`    ${mark(c.ok)} ${c.label}`)
  if (!c.ok && c.fix) console.log(`        ${color.dim('→ ' + c.fix)}`)
}

/** Run the report. Connects each tokened bot to verify token + enumerate (then disconnects),
 *  reports per-channel gaps, the pending surface, cross-machine status, and the integrity checks.
 *  Returns true when everything is healthy and nothing is pending. */
export async function runDoctor(): Promise<boolean> {
  const authoring = readAuthoringAccess()
  const pending = readPending()
  const trust = readTrustAnchors()
  const nowMs = Date.now()
  let healthy = true

  console.log(color.bold('\nknock-knock doctor') + color.dim('  — report only; nothing is written\n'))

  const botKeys = Object.keys(authoring.bots)
  if (botKeys.length === 0) {
    console.log(color.yellow('  No bots configured. Run `knock-knock setup` to add one.\n'))
    return false
  }

  for (const [botKey, bot] of Object.entries(authoring.bots)) {
    const platform = bot.platform
    console.log(color.bold(`  bot ${color.cyan(botKey)}`) + color.dim(`  · ${platform}`))
    const adapter = await connectDiscoveryAdapter(bot, process.env as Record<string, string | undefined>)
    const selfId = adapter?.botUserId
    printCheck({
      ok: !!selfId,
      label: selfId ? `token valid (self-ID ${selfId})` : 'token missing or invalid',
      fix: selfId ? undefined : `set ${bot.tokenEnv} via \`knock-knock setup\` → Manage a bot → token`,
    })
    if (!selfId) { healthy = false; if (adapter) await adapter.disconnect().catch(() => {}); console.log(''); continue }

    try {
      const channels = Object.entries(authoring.channels).filter(
        ([, ch]) => ch.platform === platform && ch.members.some(m => m.bot === botKey),
      )
      if (channels.length === 0) console.log(color.dim('    (not a member of any channel — add one with `knock-knock setup`)'))
      for (const [ck, ch] of channels) {
        const snapshot = await assembleSnapshot({
          platform,
          adapter: adapter!,
          channelId: ch.channelId,
          transportConfigured: Object.values(authoring.channels).some(c => c.platform === platform && c.meshTransport),
        })
        const channelPending = pending.proposals.filter(p => p.status === 'proposed' && p.channelKey === ck).length
        const gaps = resolveGaps({ authoring, botKey, channelKey: ck, snapshot })
        const member = ch.members.find(m => m.bot === botKey)!

        // Channel membership (enumerable platforms only).
        const known = itemsOf(snapshot.channels)
        if (snapshot.capabilities.channelEnumeration && known.length > 0) {
          const inChannel = known.some(c => c.id === ch.channelId)
          printCheck({ ok: inChannel, label: `#${ch.channelId} — bot is a member`, fix: inChannel ? undefined : 'invite the bot to this channel on the platform' })
          if (!inChannel) healthy = false
        }
        // Owner-ID resolution.
        const ownerSet = !!authoring.me?.[platform]
        printCheck({ ok: ownerSet, label: ownerSet ? `owner-ID resolved (${authoring.me![platform]})` : 'owner-ID not set', fix: ownerSet ? undefined : '`knock-knock setup` → Auto-configure a bot (pick yourself, or nonce capture)' })
        if (!ownerSet) healthy = false
        // Workspace existence.
        const wsOk = !!member.workspace && existsSync(member.workspace)
        printCheck({ ok: wsOk, label: `workspace ${member.workspace}`, fix: wsOk ? undefined : 'create the folder, or edit the channel to point at an existing one' })
        if (!wsOk) healthy = false
        // R21 — degraded member enumeration is reported as such, never "0 members".
        if (snapshot.members.kind === 'degraded') {
          console.log(`    ${color.yellow('!')} members: degraded (${snapshot.members.reason}) — owner/collaborator pick unavailable, use nonce/manual`)
        }
        // Outstanding proposals mark the channel not-yet-complete.
        if (channelPending > 0) {
          healthy = false
          console.log(`    ${color.yellow('•')} ${channelPending} pending discover${channelPending === 1 ? 'y' : 'ies'} — channel not yet complete`)
        } else if (gaps.length === 0) {
          console.log(`    ${color.green('•')} complete`)
        } else {
          console.log(`    ${color.yellow('•')} ${gaps.length} unmet need(s): ${gaps.map(g => g.kind).join(', ')} — run \`knock-knock setup\` → Auto-configure`)
        }
      }
    } finally {
      await adapter!.disconnect().catch(() => {})
    }
    console.log('')
  }

  // Pending discoveries surface (R17).
  const open = pending.proposals.filter(p => p.status === 'proposed')
  console.log(color.bold('  pending discoveries'))
  if (open.length === 0) {
    console.log(color.dim('    none'))
  } else {
    healthy = false
    for (const p of open) {
      const { summary, stale } = pendingSummary(p, nowMs)
      console.log(`    ${color.yellow('•')} ${summary}${stale ? color.dim(' (aging)') : ''}`)
    }
    console.log(color.dim('    → confirm with `knock-knock setup` → "Confirm pending discoveries"'))
  }
  console.log('')

  // Cross-machine status (R16/KTD5).
  const cm = crossMachineStatus(pending, nowMs)
  console.log(color.bold('  cross-machine'))
  if (cm === 'unavailable-relay-offline') console.log(color.dim('    unavailable (relay offline — no recent discovery heartbeat)'))
  else if (cm === 'none') console.log(color.dim('    none (relay running, no remote peers seen)'))
  else console.log(color.dim('    discoveries available (see pending above)'))
  console.log('')

  // Trust-integrity assertions (R23/R24/R25).
  console.log(color.bold('  trust integrity'))
  for (const c of integrityChecks(authoring, pending, trust)) {
    printCheck(c)
    if (!c.ok) healthy = false
  }
  console.log('')

  console.log(healthy ? color.green('  ✓ healthy') : color.yellow('  ! attention needed (see above)'))
  console.log('')
  return healthy
}
