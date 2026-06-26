/**
 * relay-startup.ts — optional interactive "quick config" gathered at relay launch
 * (alongside `--pick`), then applied to the ledger before the hosts connect.
 *
 * Everything here is opt-in and skippable. The model/thinking/effort/agent choices are
 * seeded as owner-role `config.set` on each of a bot's rooms (the same shape `!config`
 * writes), so the first turn already resolves them. Chosen sessions are imported as
 * shared-context to the room scope (best-effort — see the caveat below).
 *
 * Caveat: shared-context is per task-scope, and task threads spawn later with their own
 * scope, so a startup import lands on the room/channel scope — top-level turns see it,
 * auto-spawned threads do not. (`docs/session-sharing.md`.)
 */

import * as p from '@clack/prompts'
import type { Store } from './ledger/store.ts'
import type { FoldEngine } from './ledger/fold.ts'
import { admit } from './ledger/admit.ts'
import { buildConfigSet, latestConfigHash, CONFIG_FOLD, type ConfigFoldState } from './ledger/concepts/config.ts'
import type { Access, AgentConfig, ChannelConfigDelta } from './lib.ts'
import { RUNTIME_VALUES } from './lib.ts'
import { listAllSessions, type SessionSummary } from './sessions/index.ts'
import { importSession } from './sessions/import.ts'

export type QuickConfig = {
  delta: ChannelConfigDelta // model / thinking / effort / runtime to seed
  sessions: SessionSummary[] // sessions to import as shared-context
}

const KEEP = '' // sentinel select value meaning "leave unset / use default"

/** Interactively gather optional per-bot quick config. Returns a map of botKey → choices
 *  (only bots the operator actually configured). Pure-ish: only reads disk for sessions. */
export async function gatherQuickConfig(
  entries: Array<[string, AgentConfig]>,
): Promise<Map<string, QuickConfig>> {
  const out = new Map<string, QuickConfig>()
  if (!process.stdin.isTTY) return out

  const proceed = await p.confirm({
    message: 'Set quick per-bot config now? (coding agent / model / thinking / effort / sessions)',
    initialValue: false,
  })
  if (p.isCancel(proceed) || !proceed) return out

  for (const [key, agent] of entries) {
    const want = await p.confirm({ message: `Configure ${key}?`, initialValue: false })
    if (p.isCancel(want) || !want) continue

    const delta: ChannelConfigDelta = {}

    const runtime = await p.select({
      message: `${key}: coding agent`,
      options: [
        { value: KEEP, label: `keep default (${agent.runtime})` },
        ...RUNTIME_VALUES.map(r => ({ value: r, label: r })),
      ],
      initialValue: KEEP,
    })
    if (!p.isCancel(runtime) && runtime) delta.runtime = runtime as string

    const model = await p.text({ message: `${key}: model id (blank to skip)`, placeholder: 'claude-opus-4-8' })
    if (!p.isCancel(model) && (model as string).trim()) delta.model = (model as string).trim()

    const thinking = await p.select({
      message: `${key}: thinking`,
      options: [
        { value: KEEP, label: 'skip' },
        { value: 'off', label: 'off' }, { value: 'auto', label: 'auto' }, { value: 'high', label: 'high' },
      ],
      initialValue: KEEP,
    })
    if (!p.isCancel(thinking) && thinking) delta.thinking = thinking as ChannelConfigDelta['thinking']

    const effort = await p.select({
      message: `${key}: effort`,
      options: [
        { value: KEEP, label: 'skip' },
        ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map(e => ({ value: e, label: e })),
      ],
      initialValue: KEEP,
    })
    if (!p.isCancel(effort) && effort) delta.effort = effort as ChannelConfigDelta['effort']

    // Sessions to share — only offered when the workspace has any.
    let sessions: SessionSummary[] = []
    if (agent.workspace) {
      const available = await listAllSessions(agent.workspace, { limit: 10 }).catch(() => [])
      if (available.length > 0) {
        const picked = await p.multiselect({
          message: `${key}: import session context? (best-effort — lands on the channel scope, not future threads)`,
          options: available.map(s => ({
            value: s.id,
            label: `${s.runtime} · ${s.title ?? s.id.slice(0, 8)}`,
            hint: s.updatedAt.slice(0, 10),
          })),
          required: false,
        })
        if (!p.isCancel(picked)) sessions = available.filter(s => (picked as string[]).includes(s.id))
      }
    }

    if (Object.keys(delta).length > 0 || sessions.length > 0) out.set(key, { delta, sessions })
  }
  return out
}

/** Apply gathered quick config to the ledger: seed config.set per room and import chosen
 *  sessions. Runs after the folds are live and before the hosts connect. */
export async function applyQuickConfig(
  store: Store,
  engine: FoldEngine,
  access: Access,
  byBot: Map<string, QuickConfig>,
  log: (msg: string) => void,
): Promise<void> {
  if (byBot.size === 0) return
  const cfgState = (): ConfigFoldState => {
    try { return engine.get<ConfigFoldState>(CONFIG_FOLD) } catch { return new Map() }
  }
  for (const [key, qc] of byBot) {
    const agent = access.agents[key]
    if (!agent) continue
    const ownerId = agent.ownerUserId
    const rooms = Object.keys(agent.rooms)
    if (!ownerId || rooms.length === 0) {
      log(`quick-config: ${key} skipped (no owner id or no rooms)`)
      continue
    }
    // Seed the config delta on every room this bot serves.
    if (Object.keys(qc.delta).length > 0) {
      for (const roomId of rooms) {
        await admit(store, buildConfigSet(ownerId, roomId, qc.delta, latestConfigHash(cfgState(), roomId)))
      }
      log(`quick-config: ${key} ← ${JSON.stringify(qc.delta)} on ${rooms.length} room(s)`)
    }
    // Import chosen sessions as shared-context to each room scope (source runtime is the
    // session's own — importSession reads that runtime's transcript on disk).
    for (const s of qc.sessions) {
      for (const roomId of rooms) {
        const res = await importSession(store, {
          runtime: s.runtime,
          sessionId: s.id,
          scopeId: roomId,
          ownerId,
          workspace: agent.workspace,
          fallbackCwd: agent.workspace,
        })
        if (!res.ok) log(`quick-config: ${key} session ${s.id.slice(0, 8)} not imported (${res.reason})`)
        else log(`quick-config: ${key} imported ${s.runtime} session ${s.id.slice(0, 8)} → ${roomId}`)
      }
    }
  }
}
