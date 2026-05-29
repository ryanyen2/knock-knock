/**
 * AcpAdapter — the universal adapter. The ONLY module that imports
 * @agentclientprotocol/sdk or spawns an ACP agent subprocess.
 *
 * One adapter, every runtime: ACP (Agent Client Protocol) standardizes
 * session/prompt/permission over JSON-RPC on stdio, so a single client drives
 * Claude Code, OpenCode, Codex, Gemini, Cursor… — the agent is chosen by which
 * command we spawn (see adapters/index.ts), not by code here.
 *
 * Permission model — IMPORTANT (the deny floor):
 *  ACP has no policy array you hand the agent up front; every gated tool call
 *  arrives as a `requestPermission` the client answers. So the allow/ask/deny
 *  profile is enforced *here*, in `onRequestPermission`, via classifyTool():
 *    deny  → auto-reject; the owner never sees it (hard floor).
 *    allow → auto-approve; no owner prompt.
 *    ask   → routed to the relay's Approvals service (owner taps Allow/Deny).
 *  This makes the floor adapter-enforced. It holds only while the agent runs in
 *  a mode that *asks* before tools (its default) — we never put it in a
 *  bypass/yolo mode, and we advertise no fs/terminal capability, so file and
 *  shell actions surface as permission requests rather than silent callbacks.
 */

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
import type { AgentAdapter, AgentEvent, PermissionProfile, Verdict } from '../agent-adapter.ts'
import { classifyTool, type ToolDescriptor } from '../lib.ts'

const DEBUG = process.env.KNOCK_KNOCK_DEBUG === '1'
function dbg(msg: string): void {
  if (DEBUG) process.stderr.write(`[acp] ${msg}\n`)
}

// Kill every spawned agent on process exit so we don't orphan subprocesses.
// A single 'exit' hook (relay.ts's SIGINT/SIGTERM handlers call process.exit,
// which fires 'exit'), so the relay stays untouched.
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

/** Pull the primary argument (shell command / path / url) out of a tool's raw
 *  input so deny/ask patterns can match it. Shapes vary across agents, so we
 *  probe the common field names and fall back to the title. */
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

/** A tool's subject (command / path / url / query) is what deny patterns match
 *  and what the operator wants to see. Different agents put it in different
 *  places: rawInput for most, but the ACP `content` blocks (a text command, a
 *  diff path) or `locations` (the file being edited) for others — e.g. a
 *  "Terminal" tool whose rawInput stays `{}`. Probe all three. */
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
/** What we track per tool call across updates: descriptor fields plus the ACP
 *  content/locations the subject may hide in. */
type ToolTrack = ToolDescriptorInput & { content?: unknown; locations?: unknown }

/** True if an array-ish field actually carries entries. */
function hasItems(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

/** Is a rawInput payload actually populated? ACP often sends an empty `{}` on
 *  the initial tool_call and again on the permission request; the real command
 *  arrives in a later tool_call_update. We must not let the empty one win. */
function isPopulated(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0
  if (v && typeof v === 'object') return Object.keys(v as object).length > 0
  return false
}

// ─── Permission option selection ────────────────────────────────────────────

/** Choose an option of the wanted disposition, preferring the one-shot variant
 *  (allow_once / reject_once) over the sticky one so policy stays per-call. */
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

/** A reject/cancel response. If the agent offered no reject option, `cancelled`
 *  still prevents the tool from running — the safe answer for a denial. */
function denyResponse(options: PermissionOption[]): RequestPermissionResponse {
  const o = pickOption(options, 'reject')
  return o ? selected(o) : { outcome: { outcome: 'cancelled' } }
}

function allowResponse(options: PermissionOption[]): RequestPermissionResponse {
  const o = pickOption(options, 'allow')
  if (!o) {
    // We decided to allow but the agent offered no allow option. Cancelling is
    // the only safe answer; surface it so the dropped tool call isn't a mystery.
    dbg('allow decision but agent offered no allow option — cancelling')
    return { outcome: { outcome: 'cancelled' } }
  }
  return selected(o)
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class AcpAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void
  private conn?: ClientSideConnection
  private initPromise?: Promise<void>
  /** Accumulates assistant text for the in-flight turn. Safe because the Driver
   *  serializes turns per session, so only one prompt() is ever in flight. */
  private turnText = ''
  /** toolCallId → latest known kind/title/rawInput, rebuilt each turn. The
   *  command needed to match deny/ask patterns arrives in a tool_call_update,
   *  not in the request_permission payload, so we correlate by id. */
  private toolCalls = new Map<string, ToolTrack>()
  /** toolCallIds for which a tool_call event has already been emitted this turn. */
  private emittedToolCalls = new Set<string>()
  /** Was the session_init event already fired for this sessionId? */
  private sessionAnnouncedFor: string | undefined

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

  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    await this.init()
    const conn = this.conn!

    let sid = input.sessionId
    const isNewSession = !sid
    if (!sid) {
      const res = await conn.newSession({ cwd: this.directory, mcpServers: [] })
      sid = res.sessionId
      dbg(`session created: ${sid}`)
    }
    if (isNewSession && this.sessionAnnouncedFor !== sid) {
      this.sessionAnnouncedFor = sid
      this.emit({ type: 'session_init', sessionId: sid, cwd: this.directory })
    }

    dbg(`prompt → ${sid}: ${input.text.slice(0, 80)}`)
    this.turnText = ''
    this.toolCalls.clear()
    this.emittedToolCalls.clear()
    const startedAt = Date.now()
    const res = await conn.prompt({ sessionId: sid, prompt: [{ type: 'text', text: input.text }] })
    dbg(`turn stopped: ${res.stopReason}`)
    this.emit({ type: 'turn_done', durationMs: Date.now() - startedAt })

    return { sessionId: sid, text: this.turnText.trim() || '(no response)' }
  }

  // The spawned subprocess is killed on process exit via the trackChild hook
  // above, so there is no explicit shutdown path to wire through the seam.

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
    dbg(`initialized: agent=${init.agentInfo?.name ?? '?'} protocol=v${init.protocolVersion}`)
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

      // Emit one tool_call per id, but DEFER until we actually have the
      // subject (command / path / …) to show — it may arrive a beat after the
      // title in rawInput, content, or locations. Emitting on the bare title
      // alone is what produced `Terminal {}`. Terminal status forces the emit
      // so no tool is dropped even if its subject never materializes.
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
            // Show the real input when present; otherwise surface the derived
            // subject so the operator (and the Workbench) see the command/path.
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
    // The permission payload's rawInput is often empty; merge in the command we
    // saw on the correlated tool_call update so deny/ask patterns can match it.
    // The subject may live in content/locations, not rawInput — fold those in
    // too so the deny floor matches regardless of where the agent put it.
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
    // Routine tool — auto-approve, no prompt.
    if (decision === 'allow') return allowResponse(params.options)

    // 'ask' — route to the relay's Approvals service (owner decides).
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
