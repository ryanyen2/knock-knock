/**
 * AcpAdapter — the universal adapter. The ONLY module that imports
 * @agentclientprotocol/sdk or spawns an ACP agent subprocess.
 *
 * One adapter, every runtime: ACP (Agent Client Protocol) standardizes
 * session/prompt/permission over JSON-RPC on stdio, so a single client drives
 * Claude Code, OpenCode, Codex, Gemini, Cursor… — the agent is chosen by which
 * command we spawn (see adapters/index.ts), not by code here.
 *
 * Shape vs the in-process ClaudeSdkAdapter (the seam's stress test):
 *  - ClaudeSdk: in-process, pull async-iterator, canUseTool callback.
 *  - ACP:       out-of-process subprocess, push notifications over stdio,
 *               permission surfaced as a session/request_permission request.
 * If the AgentAdapter contract survives this inversion it survives anything.
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
import type { AgentAdapter, PermissionProfile, Verdict } from '../agent-adapter.ts'
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

function describeToolCall(tc: ToolDescriptorInput): ToolDescriptor {
  return {
    kind: tc.kind ?? undefined,
    title: tc.title ?? undefined,
    subject: extractSubject(tc.rawInput),
  }
}

type ToolDescriptorInput = { kind?: string | null; title?: string | null; rawInput?: unknown }

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
  return o ? selected(o) : { outcome: { outcome: 'cancelled' } }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class AcpAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private child?: ChildProcess
  private conn?: ClientSideConnection
  private initPromise?: Promise<void>
  /** Accumulates assistant text for the in-flight turn. Safe because the Driver
   *  serializes turns per session, so only one prompt() is ever in flight. */
  private turnText = ''
  /** toolCallId → latest known kind/title/rawInput, rebuilt each turn. The
   *  command needed to match deny/ask patterns arrives in a tool_call_update,
   *  not in the request_permission payload, so we correlate by id. */
  private toolCalls = new Map<string, ToolDescriptorInput>()

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

  async prompt(input: { text: string; sessionId?: string }): Promise<{ sessionId: string; text: string }> {
    await this.init()
    const conn = this.conn!

    let sid = input.sessionId
    if (!sid) {
      const res = await conn.newSession({ cwd: this.directory, mcpServers: [] })
      sid = res.sessionId
      dbg(`session created: ${sid}`)
    }

    dbg(`prompt → ${sid}: ${input.text.slice(0, 80)}`)
    this.turnText = ''
    this.toolCalls.clear()
    const res = await conn.prompt({ sessionId: sid, prompt: [{ type: 'text', text: input.text }] })
    dbg(`turn stopped: ${res.stopReason}`)

    return { sessionId: sid, text: this.turnText.trim() || '(no response)' }
  }

  /** Kill the agent subprocess. Called on relay shutdown. */
  shutdown(): void {
    this.child?.kill()
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
    this.child = child
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
      return
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const tc = u as { toolCallId: string } & ToolDescriptorInput
      const prev = this.toolCalls.get(tc.toolCallId) ?? {}
      this.toolCalls.set(tc.toolCallId, {
        kind: tc.kind ?? prev.kind,
        title: tc.title ?? prev.title,
        rawInput: isPopulated(tc.rawInput) ? tc.rawInput : prev.rawInput,
      })
    }
  }

  private async onRequestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    // The permission payload's rawInput is often empty; merge in the command we
    // saw on the correlated tool_call update so deny/ask patterns can match it.
    const tracked = this.toolCalls.get(params.toolCall.toolCallId)
    const descriptor = describeToolCall({
      kind: params.toolCall.kind ?? tracked?.kind,
      title: params.toolCall.title ?? tracked?.title,
      rawInput: isPopulated(params.toolCall.rawInput) ? params.toolCall.rawInput : tracked?.rawInput,
    })
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
      input: params.toolCall.rawInput ?? { title: params.toolCall.title },
    })
    return verdict.behavior === 'allow' ? allowResponse(params.options) : denyResponse(params.options)
  }
}
