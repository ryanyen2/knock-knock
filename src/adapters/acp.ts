/** AcpAdapter — universal adapter; the ONLY module that imports the ACP SDK or
 *  spawns an ACP subprocess. The deny floor is enforced here in onRequestPermission
 *  via classifyTool (deny→reject / allow→approve / ask→Approvals); holds only while
 *  the agent asks before tools (we never use bypass mode, advertise no fs/terminal). */

import { spawn, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type PermissionOption,
} from '@agentclientprotocol/sdk'
import type { AgentAdapter, AgentEvent, PermissionProfile, TurnOptions, Verdict } from '../agent-adapter.ts'
import { classifyTool, type ToolDescriptor } from '../lib.ts'

const DEBUG = process.env.KNOCK_KNOCK_DEBUG === '1'
function dbg(msg: string): void {
  if (DEBUG) process.stderr.write(`[acp] ${msg}\n`)
}

// Kill every spawned agent on process exit so we don't orphan subprocesses.
const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false
function trackChild(child: ChildProcess): void {
  liveChildren.add(child)
  child.on('exit', () => liveChildren.delete(child))
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const c of liveChildren) c.kill()
    })
  }
}

/** How to launch an ACP agent. The factory builds these per agent name. */
export type AcpLaunch = {
  command: string
  args?: string[]
  /** Extra env merged over process.env for the spawned agent. */
  env?: Record<string, string>
}

// ─── Tool-call → policy descriptor ──────────────────────────────────────────

/** Pull the primary argument (command / path / url) out of a tool's raw input so deny/ask patterns can match. */
function extractSubject(rawInput: unknown): string | undefined {
  if (typeof rawInput === 'string') return rawInput || undefined
  if (!rawInput || typeof rawInput !== 'object') return undefined
  const r = rawInput as Record<string, unknown>
  for (const k of ['command', 'cmd', 'script', 'shellCommand', 'file_path', 'filePath', 'path', 'url']) {
    const v = r[k]
    if (typeof v === 'string' && v) return v
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return (v as string[]).join(' ')
  }
  return undefined
}

/** A tool's subject — what deny patterns match. May live in rawInput, content, or locations; probe all three. */
function deriveSubject(tc: ToolTrack): string | undefined {
  return (
    extractSubject(tc.rawInput) ?? subjectFromContent(tc.content) ?? subjectFromLocations(tc.locations)
  )
}

function subjectFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    if (it.type === 'content') {
      const inner = it.content as Record<string, unknown> | undefined
      if (inner && inner.type === 'text' && typeof inner.text === 'string' && inner.text.trim()) {
        return inner.text.trim()
      }
    }
    if (it.type === 'diff' && typeof it.path === 'string' && it.path) return it.path
  }
  return undefined
}

function subjectFromLocations(locations: unknown): string | undefined {
  if (!Array.isArray(locations)) return undefined
  for (const loc of locations) {
    if (loc && typeof loc === 'object' && typeof (loc as { path?: unknown }).path === 'string') {
      const p = (loc as { path: string }).path
      if (p) return p
    }
  }
  return undefined
}

function describeToolCall(tc: ToolTrack): ToolDescriptor {
  return {
    kind: tc.kind ?? undefined,
    title: tc.title ?? undefined,
    subject: deriveSubject(tc),
  }
}

type ToolDescriptorInput = { kind?: string | null; title?: string | null; rawInput?: unknown }
/** Per-tool-call tracking across updates: descriptor fields plus content/locations. */
type ToolTrack = ToolDescriptorInput & { content?: unknown; locations?: unknown }

/** True if an array-ish field actually carries entries. */
function hasItems(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

/** Is a rawInput payload populated? ACP often sends empty `{}` first; the real command arrives later. */
function isPopulated(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0
  if (v && typeof v === 'object') return Object.keys(v as object).length > 0
  return false
}

// ─── Permission option selection ────────────────────────────────────────────

/** Choose an option of the wanted disposition, preferring the one-shot variant so policy stays per-call. */
function pickOption(options: PermissionOption[], want: 'allow' | 'reject'): PermissionOption | undefined {
  return (
    options.find(o => o.kind === `${want}_once`) ??
    options.find(o => o.kind === `${want}_always`) ??
    options.find(o => o.kind.startsWith(want))
  )
}

function selected(option: PermissionOption): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

/** A reject/cancel response; `cancelled` still prevents the tool from running — safe for a denial. */
function denyResponse(options: PermissionOption[]): RequestPermissionResponse {
  const o = pickOption(options, 'reject')
  return o ? selected(o) : { outcome: { outcome: 'cancelled' } }
}

function allowResponse(options: PermissionOption[]): RequestPermissionResponse {
  const o = pickOption(options, 'allow')
  if (!o) {
    // Allow decided but no allow option offered — cancel is the only safe answer.
    dbg('allow decision but agent offered no allow option — cancelling')
    return { outcome: { outcome: 'cancelled' } }
  }
  return selected(o)
}

// ─── Session acquisition ─────────────────────────────────────────────────────

/** Decide how to obtain a session for a prompt (pure): no id → create; known id →
 *  reuse; foreign id → load if session/load is supported, else create. */
export function planSessionAcquire(
  sessionId: string | undefined,
  known: ReadonlySet<string>,
  canLoad: boolean,
): 'create' | 'reuse' | 'load' {
  if (!sessionId) return 'create'
  if (known.has(sessionId)) return 'reuse'
  return canLoad ? 'load' : 'create'
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class AcpAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void
  private conn?: ClientSideConnection
  private initPromise?: Promise<void>
  /** Assistant text for the in-flight turn (Driver serializes turns per session). */
  private turnText = ''
  /** toolCallId → latest kind/title/rawInput; correlated by id since the command arrives in a later update. */
  private toolCalls = new Map<string, ToolTrack>()
  /** toolCallIds already emitted this turn. */
  private emittedToolCalls = new Set<string>()
  /** sessionId the session_init event already fired for. */
  private sessionAnnouncedFor: string | undefined
  /** Session ids created or loaded this process — acquire each once. */
  private knownSessions = new Set<string>()
  /** Whether the agent advertised `session/load` (captured at init). */
  private canLoadSession = false

  constructor(
    private readonly launch: AcpLaunch,
    private readonly directory: string,
  ) {}

  applyPolicy(profile: PermissionProfile): void {
    this.profile = profile
  }

  onPermissionRequest(
    handler: (req: { toolName: string; input: unknown }) => Promise<Verdict>,
  ): void {
    this.permHandler = handler
  }

  onEvent(handler: (event: AgentEvent) => void): void {
    this.eventHandler = handler
  }

  private emit(event: AgentEvent): void {
    try {
      this.eventHandler?.(event)
    } catch {
      // A bad subscriber must never break the turn.
    }
  }

  async prompt(input: {
    text: string
    sessionId?: string
    signal?: AbortSignal
    /** Ignored: ACP runtimes self-manage model/thinking/effort (no protocol field). */
    options?: TurnOptions
  }): Promise<{ sessionId: string; text: string }> {
    if (input.options && (input.options.model || input.options.thinking || input.options.effort)) {
      dbg('per-turn model/thinking/effort ignored — ACP runtimes self-manage these')
    }
    await this.init()
    const conn = this.conn!

    let sid = input.sessionId
    let acquired = false // created or loaded this call (vs. reusing)
    switch (planSessionAcquire(sid, this.knownSessions, this.canLoadSession)) {
      case 'reuse':
        break
      case 'load':
        try {
          await conn.loadSession({ sessionId: sid!, cwd: this.directory, mcpServers: [] })
          this.knownSessions.add(sid!)
          acquired = true
          dbg(`session loaded (resumed): ${sid}`)
        } catch (err) {
          dbg(`loadSession failed (${err}); starting a fresh session`)
          sid = (await conn.newSession({ cwd: this.directory, mcpServers: [] })).sessionId
          this.knownSessions.add(sid)
          acquired = true
        }
        break
      case 'create':
        if (sid) dbg(`agent has no session/load; starting fresh instead of resuming ${sid}`)
        sid = (await conn.newSession({ cwd: this.directory, mcpServers: [] })).sessionId
        this.knownSessions.add(sid)
        acquired = true
        dbg(`session created: ${sid}`)
        break
    }
    if (!sid) throw new Error('acp: session acquisition produced no session id')
    if (acquired && this.sessionAnnouncedFor !== sid) {
      this.sessionAnnouncedFor = sid
      this.emit({ type: 'session_init', sessionId: sid, cwd: this.directory })
    }

    // 🛑 stop → ACP `session/cancel`; prompt resolves cancelled, we return partial text.
    const sessionForCancel = sid
    const onAbort = (): void => {
      dbg(`cancel → ${sessionForCancel}`)
      void conn.cancel({ sessionId: sessionForCancel }).catch(() => {})
    }
    if (input.signal) {
      if (input.signal.aborted) onAbort()
      else input.signal.addEventListener('abort', onAbort, { once: true })
    }

    dbg(`prompt → ${sid}: ${input.text.slice(0, 80)}`)
    this.turnText = ''
    this.toolCalls.clear()
    this.emittedToolCalls.clear()
    const startedAt = Date.now()
    try {
      const res = await conn.prompt({ sessionId: sid, prompt: [{ type: 'text', text: input.text }] })
      dbg(`turn stopped: ${res.stopReason}`)
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }
    this.emit({ type: 'turn_done', durationMs: Date.now() - startedAt })

    return { sessionId: sid, text: this.turnText.trim() || '(no response)' }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    const { command, args = [], env } = this.launch
    dbg(`spawning: ${command} ${args.join(' ')} (cwd=${this.directory})`)

    const child = spawn(command, args, {
      cwd: this.directory,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...(env ?? {}) },
    })
    child.on('error', err => process.stderr.write(`[acp] spawn error: ${err}\n`))
    child.on('exit', (code, sig) => dbg(`agent exited code=${code} sig=${sig}`))
    trackChild(child)

    const writable = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>
    const readable = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>
    const stream = ndJsonStream(writable, readable)

    const conn = new ClientSideConnection(() => this.makeClient(), stream)
    this.conn = conn

    const init = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    this.canLoadSession = init.agentCapabilities?.loadSession === true
    dbg(
      `initialized: agent=${init.agentInfo?.name ?? '?'} protocol=v${init.protocolVersion} loadSession=${this.canLoadSession}`,
    )
  }

  private makeClient(): Client {
    return {
      requestPermission: params => this.onRequestPermission(params),
      sessionUpdate: params => this.onSessionUpdate(params),
    }
  }

  private async onSessionUpdate(params: SessionNotification): Promise<void> {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      this.turnText += u.content.text
      this.emit({ type: 'assistant_text', text: u.content.text })
      return
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const tc = u as {
        toolCallId: string
        status?: string
        content?: unknown
        locations?: unknown
      } & ToolDescriptorInput
      const prev = this.toolCalls.get(tc.toolCallId) ?? {}
      const merged: ToolTrack = {
        kind: tc.kind ?? prev.kind,
        title: tc.title ?? prev.title,
        rawInput: isPopulated(tc.rawInput) ? tc.rawInput : prev.rawInput,
        content: hasItems(tc.content) ? tc.content : prev.content,
        locations: hasItems(tc.locations) ? tc.locations : prev.locations,
      }
      this.toolCalls.set(tc.toolCallId, merged)

      const terminal = tc.status === 'completed' || tc.status === 'failed'

      // Emit one tool_call per id, deferred until the subject is available; terminal status forces it.
      if (!this.emittedToolCalls.has(tc.toolCallId)) {
        const subject = deriveSubject(merged)
        if (subject || isPopulated(merged.rawInput) || terminal) {
          this.emittedToolCalls.add(tc.toolCallId)
          this.emit({
            type: 'tool_call',
            toolCallId: tc.toolCallId,
            name: merged.title ?? merged.kind ?? 'tool',
            kind: merged.kind ?? undefined,
            title: merged.title ?? undefined,
            // Real input when present, else the derived subject.
            input: isPopulated(merged.rawInput) ? merged.rawInput : subject ? { subject } : {},
          })
        }
      }

      // Emit a result when the agent reports a terminal status.
      if (terminal) {
        this.emit({
          type: 'tool_result',
          toolCallId: tc.toolCallId,
          status: tc.status as 'completed' | 'failed',
        })
      }
    }
  }

  private async onRequestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    // Merge the correlated tool_call update (rawInput/content/locations) so the deny floor matches.
    const p = params.toolCall as {
      toolCallId: string
      content?: unknown
      locations?: unknown
    } & ToolDescriptorInput
    const tracked = this.toolCalls.get(p.toolCallId)
    const merged: ToolTrack = {
      kind: p.kind ?? tracked?.kind,
      title: p.title ?? tracked?.title,
      rawInput: isPopulated(p.rawInput) ? p.rawInput : tracked?.rawInput,
      content: hasItems(p.content) ? p.content : tracked?.content,
      locations: hasItems(p.locations) ? p.locations : tracked?.locations,
    }
    const descriptor = describeToolCall(merged)
    const decision = classifyTool(this.profile, descriptor)
    dbg(
      `permission: kind=${descriptor.kind ?? '?'} "${descriptor.subject ?? descriptor.title ?? ''}" → ${decision}`,
    )

    // Hard deny floor — adapter-enforced, the owner never sees it.
    if (decision === 'deny') return denyResponse(params.options)
    if (decision === 'allow') return allowResponse(params.options)

    // 'ask' — route to Approvals (owner decides).
    const handler = this.permHandler
    if (!handler) return denyResponse(params.options)

    const verdict = await handler({
      toolName: descriptor.toolName ?? descriptor.kind ?? 'tool',
      input: isPopulated(merged.rawInput)
        ? merged.rawInput
        : descriptor.subject
          ? { subject: descriptor.subject }
          : { title: merged.title },
    })
    return verdict.behavior === 'allow' ? allowResponse(params.options) : denyResponse(params.options)
  }
}
