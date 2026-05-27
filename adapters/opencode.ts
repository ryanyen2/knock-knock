/**
 * OpenCodeAdapter — the ONLY module that imports or calls @opencode-ai/sdk.
 * Drives OpenCode via opencode serve (HTTP + SSE).
 *
 * Shape differences vs ClaudeSdkAdapter (the §4 pressure points):
 *  - ClaudeSdk: in-process pull iterator, canUseTool callback
 *  - OpenCode: out-of-process HTTP server, shared SSE stream, permission.updated events
 *
 * Permission translation (§4.2):
 *  CC patterns like "Bash(*)", "Read(**)" map onto OpenCode's named categories
 *  (bash, edit, webfetch). The mapping is best-effort:
 *    Bash(*)       → bash: "ask" | "allow" | "deny"
 *    Bash(pattern) → bash: { pattern: action }  (pattern map)
 *    Read / Edit / Write / LS → edit: action
 *    WebFetch      → webfetch: action
 *  Tools not in these categories are ignored (OpenCode has no equivalent).
 *  Deny entries win over ask over allow when the same category appears in multiple tiers.
 *
 * Concurrency model:
 *  session.prompt() is a blocking HTTP call that waits for the full agent turn.
 *  permission.updated SSE events fire while that call is in flight; the event
 *  loop handles them concurrently in Bun's single-threaded async scheduler.
 */

import type { AgentAdapter, PermissionProfile, Verdict } from '../agent-adapter.ts'
import type { Permission, Event as OCEvent } from '@opencode-ai/sdk'
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk'

const DEBUG = process.env.KNOCK_KNOCK_DEBUG === '1'

function dbg(msg: string): void {
  if (DEBUG) process.stderr.write(`[opencode] ${msg}\n`)
}

// ─── Permission translation ───────────────────────────────────────────────────

type BashAction = 'ask' | 'allow' | 'deny'
type OCPermConfig = {
  edit?: BashAction
  bash?: BashAction | Record<string, BashAction>
  webfetch?: BashAction
}

function parseCCEntry(entry: string): { tool: string; arg: string | null } {
  const m = entry.match(/^(\w+)(?:\((.+)\))?$/)
  if (!m) return { tool: entry, arg: null }
  return { tool: m[1]!, arg: m[2] ?? null }
}

function ccToolCategory(tool: string): 'bash' | 'edit' | 'webfetch' | null {
  switch (tool.toLowerCase()) {
    case 'bash': return 'bash'
    case 'edit': case 'read': case 'write': case 'ls': return 'edit'
    case 'webfetch': case 'fetch': return 'webfetch'
    default: return null
  }
}

/** Translate a PermissionProfile into OpenCode's permission config object.
 *  Deny wins over ask wins over allow for the same category. */
function buildOCPermission(profile: PermissionProfile): OCPermConfig {
  const result: OCPermConfig = {}
  const bashPatterns: Record<string, BashAction> = {}
  let bashDefault: BashAction | null = null

  for (const [action, entries] of [
    ['allow', profile.allow],
    ['ask', profile.ask],
    ['deny', profile.deny],
  ] as const) {
    for (const entry of entries) {
      const { tool, arg } = parseCCEntry(entry)
      const cat = ccToolCategory(tool)
      if (!cat) continue

      if (cat === 'bash') {
        if (arg && arg !== '*') {
          bashPatterns[arg] = action
        } else {
          bashDefault = action
        }
      } else if (cat === 'edit') {
        result.edit = action
      } else if (cat === 'webfetch') {
        result.webfetch = action
      }
    }
  }

  if (Object.keys(bashPatterns).length > 0) {
    const map: Record<string, BashAction> = { ...bashPatterns }
    if (bashDefault) map['*'] = bashDefault
    result.bash = map
  } else if (bashDefault) {
    result.bash = bashDefault
  }

  return result
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class OpenCodeAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private client?: Awaited<ReturnType<typeof createOpencode>>['client']
  private server?: { url: string; close(): void }
  private initPromise?: Promise<void>

  constructor(private readonly directory: string) {}

  applyPolicy(profile: PermissionProfile): void {
    this.profile = profile
  }

  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void {
    this.permHandler = handler
  }

  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    await this.init()
    const c = this.client!

    let sid = input.sessionId
    if (!sid) {
      const r = await c.session.create({ query: { directory: this.directory } })
      if (!r.data) throw new Error('OpenCode: session.create returned no data')
      sid = r.data.id
      dbg(`session created: ${sid}`)
    }

    dbg(`prompt → session ${sid}: ${input.text.slice(0, 80)}`)

    // POST /session/{id}/message — blocks until the full agent turn is done
    const r = await c.session.prompt({
      path: { id: sid },
      body: { parts: [{ type: 'text', text: input.text }] },
      query: { directory: this.directory },
    })

    if (!r.data) throw new Error('OpenCode: session.prompt returned no data')

    const text = r.data.parts
      .filter((p): p is { type: 'text'; text: string; id: string; sessionID: string; messageID: string } =>
        p.type === 'text')
      .map(p => p.text)
      .join('')

    dbg(`result: ${text.slice(0, 80)}`)
    return { sessionId: sid, text: text.trim() || '(no response)' }
  }

  shutdown(): void {
    this.server?.close()
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    const permission = buildOCPermission(this.profile)
    dbg(`permission config: ${JSON.stringify(permission)}`)

    const baseUrl = process.env.OPENCODE_BASE_URL
    if (baseUrl) {
      this.client = createOpencodeClient({ baseUrl, directory: this.directory })
      dbg(`attached to existing server at ${baseUrl}`)
    } else {
      const { client, server } = await createOpencode({
        config: { permission } as Record<string, unknown>,
      })
      this.client = client
      this.server = server
      dbg(`spawned server at ${server.url}`)
    }

    this.runEventLoop().catch(err => {
      process.stderr.write(`[opencode] event loop error: ${err}\n`)
    })
  }

  private async runEventLoop(): Promise<void> {
    const sse = await this.client!.event.subscribe()
    dbg('event loop started')

    for await (const raw of sse.stream) {
      const ev = raw as OCEvent
      dbg(`event: ${ev.type}`)

      if (ev.type === 'permission.updated') {
        const perm = (ev as { type: 'permission.updated'; properties: Permission }).properties
        this.handlePermission(perm).catch(err => {
          process.stderr.write(`[opencode] permission handler error: ${err}\n`)
        })
      }
    }
  }

  private async handlePermission(perm: Permission): Promise<void> {
    dbg(`permission.updated: id=${perm.id} type=${perm.type} title=${perm.title}`)

    const handler = this.permHandler
    if (!handler) {
      await this.replyPermission(perm.sessionID, perm.id, 'reject')
      return
    }

    const verdict = await handler({ toolName: perm.type, input: perm.metadata })
    const response: 'once' | 'reject' = verdict.behavior === 'allow' ? 'once' : 'reject'
    dbg(`permission reply → ${response}`)
    await this.replyPermission(perm.sessionID, perm.id, response)
  }

  private async replyPermission(
    sessionId: string,
    permId: string,
    response: 'once' | 'always' | 'reject',
  ): Promise<void> {
    await this.client!.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permId },
      body: { response },
      query: { directory: this.directory },
    })
  }
}
