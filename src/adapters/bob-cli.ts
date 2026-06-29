/** BobShellCliAdapter — the ONLY module that spawns IBM Bob Shell (`bob`).
 *
 *  Bob has no ACP and no per-tool approval callback, so this is a custom adapter
 *  (not an ACP preset). It drives `bob -o stream-json` non-interactively, parses the
 *  real v1.0.5 event stream, and maps knock-knock's allow/ask/deny onto the only
 *  controls Bob exposes — coarse approval modes, a per-turn owner gate, an OS
 *  `--sandbox` floor, and `.bobignore`. The ask tier is honored at TURN granularity,
 *  not per tool: Bob cannot surface an individual tool call for approval. See
 *  docs/solutions/integration-issues/bob-shell-automation-surface.md. */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentAdapter,
  AgentEvent,
  PermissionProfile,
  TurnOptions,
  Verdict,
} from '../agent-adapter.ts'

const DEBUG = process.env.KNOCK_KNOCK_DEBUG === '1'
function dbg(msg: string): void {
  if (DEBUG) process.stderr.write(`[bob] ${msg}\n`)
}

/** The `bob` binary; overridable for tests / nonstandard installs. */
const BOB_COMMAND = process.env.KNOCK_KNOCK_BOB_COMMAND || 'bob'

// Kill every spawned bob on process exit so we don't orphan subprocesses.
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

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Bob's `--approval-mode` values (from `bob --help`, v1.0.5). */
export type BobApprovalMode = 'default' | 'auto_edit' | 'yolo'

/** What policy mapping produces for a launch. `needsWriteGate` means the profile
 *  has ask-tier rules, so the owner must approve once per turn before writes run. */
export type BobLaunchPlan = {
  approvalMode: BobApprovalMode
  needsWriteGate: boolean
  denyGlobs: string[]
}

/** Pull a path-like literal out of a knock-knock permission pattern, e.g.
 *  `Write(~/.ssh/**)` → `~/.ssh/**`, `Read(src/secrets.json)` → `src/secrets.json`.
 *  Command patterns like `Bash(rm -rf *)` yield nothing — they aren't .bobignore paths. */
export function denyGlobFromPattern(pattern: string): string | null {
  const m = pattern.match(/^([A-Za-z_]+)\(([^)]*)\)$/)
  const arg = (m ? m[2] : pattern).trim()
  if (!arg) return null
  if (m) {
    // Explicit Tool(arg): a file tool's arg IS a path (spaces are valid — e.g.
    // `Read(/My Keys/.env)`), so accept it whole. Command tiers contribute nothing.
    const fileTool = ['read', 'write', 'edit', 'fileshare', 'glob', 'grep'].includes(m[1].toLowerCase())
    return fileTool ? arg : null
  }
  // Bare pattern: accept only if it looks like a path (slash or dotted name), not a
  // bare command word. The space guard here distinguishes `**/.env` from `rm -rf *`.
  if (!/[/.]/.test(arg) || /\s/.test(arg)) return null
  return arg
}

/** Map a knock-knock profile onto the controls Bob actually exposes.
 *  - any ask rule → gate writes once per turn; on approve use `auto_edit`, on deny read-only
 *  - allow-only (no ask) → `auto_edit` (writes auto-approved; commands NOT blanket-approved)
 *  - locked down (no allow, no ask) → `default` (read-only)
 *  - deny path globs → fed into a managed `.bobignore` block
 *
 *  We deliberately NEVER emit `yolo`. Bob has no per-command approval hook, so `yolo`
 *  (auto-approve ALL tools) would run a command-tier deny like `Bash(rm -rf *)` — which
 *  every preset carries in its floor — unchecked, silently voiding knock-knock's "deny
 *  never runs" guarantee. `auto_edit` + `--sandbox` + `.bobignore` is the strongest floor
 *  Bob can actually honor. See the solution doc for why. */
export function bobPolicyToLaunch(profile: PermissionProfile): BobLaunchPlan {
  const denyGlobs = unique(
    profile.deny.map(denyGlobFromPattern).filter((g): g is string => g !== null),
  )
  if (profile.ask.length > 0) {
    return { approvalMode: 'default', needsWriteGate: true, denyGlobs }
  }
  const approvalMode: BobApprovalMode = profile.allow.length > 0 ? 'auto_edit' : 'default'
  return { approvalMode, needsWriteGate: false, denyGlobs }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)]
}

const BOBIGNORE_BEGIN = '# >>> knock-knock managed deny floor (do not edit) >>>'
const BOBIGNORE_END = '# <<< knock-knock managed deny floor <<<'

/** Merge knock-knock's deny path globs into a `.bobignore`, preserving any
 *  user content outside the managed markers. Returns the full file body. */
export function mergeBobignore(existing: string, denyGlobs: string[]): string {
  // Strip a prior managed block, keep the rest verbatim.
  const stripped = existing
    .replace(new RegExp(`\\n?${escapeRe(BOBIGNORE_BEGIN)}[\\s\\S]*?${escapeRe(BOBIGNORE_END)}\\n?`), '\n')
    .replace(/^\n+/, '')
  if (denyGlobs.length === 0) return stripped
  const block = [BOBIGNORE_BEGIN, ...denyGlobs, BOBIGNORE_END].join('\n')
  const base = stripped.trim()
  return base ? `${base}\n\n${block}\n` : `${block}\n`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the `bob` argv for one non-interactive turn. Prompt is passed as the
 *  positional query (spawn arg array → no shell, no injection). */
export function buildBobArgs(input: {
  prompt: string
  approvalMode: BobApprovalMode
  sandbox: boolean
  resume?: string
  model?: string
}): string[] {
  const args = [input.prompt, '-o', 'stream-json', '--accept-license']
  args.push('--approval-mode', input.approvalMode)
  if (input.sandbox) args.push('--sandbox')
  if (input.model) args.push('--model', input.model)
  if (input.resume) args.push('--resume', input.resume)
  return args
}

/** A parsed Bob stream-json event (the v1.0.5 schema — see the solution doc). */
export type BobStreamEvent =
  | { type: 'init'; session_id?: string; model?: string }
  | { type: 'message'; role?: string; content?: unknown; delta?: boolean }
  | { type: 'tool_use'; tool_name?: string; tool_id?: string; parameters?: unknown }
  | { type: 'tool_result'; tool_id?: string; status?: string; output?: unknown; error?: unknown }
  | { type: 'error'; error?: unknown; message?: unknown }
  | { type: 'result'; status?: string; error?: unknown; stats?: unknown }

const BOB_EVENT_TYPES = new Set(['init', 'message', 'tool_use', 'tool_result', 'error', 'result'])

/** Parse one stdout line into a Bob event, or null for blank/non-JSON/foreign lines. */
export function parseBobStreamLine(line: string): BobStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') return null
  try {
    const obj = JSON.parse(trimmed) as { type?: unknown }
    if (typeof obj.type === 'string' && BOB_EVENT_TYPES.has(obj.type)) {
      return obj as BobStreamEvent
    }
  } catch {
    // Partial or non-JSON line — ignore.
  }
  return null
}

/** Extract a number from Bob's free-form `stats` object by trying a few likely keys. */
function statNum(stats: unknown, keys: string[]): number | undefined {
  if (!stats || typeof stats !== 'object') return undefined
  const s = stats as Record<string, unknown>
  for (const k of keys) {
    const v = s[k]
    if (typeof v === 'number') return v
  }
  return undefined
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/** Bob's terminal "answer" tool — its `result` is the real final reply, not the
 *  assistant `message` chunks (which carry "[using tool …]" status lines). */
export const BOB_COMPLETION_TOOL = 'attempt_completion'

/** Pull the final answer out of an attempt_completion tool's payload. Accepts both
 *  the tool_use `parameters` object (`{result: "…"}`) and the tool_result `output`
 *  which arrives as a bare string. */
export function completionText(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload.trim() ? payload : undefined
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  const r = p.result ?? p.output
  return typeof r === 'string' && r.trim() ? r : undefined
}

export class BobShellCliAdapter implements AgentAdapter {
  private profile: PermissionProfile = { allow: [], ask: [], deny: [] }
  private permHandler?: (req: { toolName: string; input: unknown }) => Promise<Verdict>
  private eventHandler?: (event: AgentEvent) => void
  private completionToolIds = new Set<string>()

  constructor(private readonly cwd: string) {}

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
    options?: TurnOptions
  }): Promise<{ sessionId: string; text: string }> {
    const plan = bobPolicyToLaunch(this.profile)
    // Fail CLOSED: if the deny floor can't be written, secrets in the workspace would be
    // readable. Refuse the turn rather than run Bob without the floor in place.
    if (!this.ensureBobignore(plan.denyGlobs)) {
      this.emit({ type: 'turn_done', durationMs: 0 })
      return {
        sessionId: input.sessionId ?? '',
        text: '(bob runtime: could not write the .bobignore deny floor — refusing the turn to avoid exposing files)',
      }
    }

    // Turn-level ask gate: Bob can't surface individual tool calls, so when the
    // profile has ask-tier rules we ask the owner ONCE before allowing writes.
    // Approve → auto-approve edits (sandboxed). Deny / no handler → read-only.
    let approvalMode = plan.approvalMode
    if (plan.needsWriteGate) {
      const verdict = await this.askTurnGate(input.text)
      approvalMode = verdict.behavior === 'allow' ? 'auto_edit' : 'default'
    }

    const startedAt = Date.now()
    const run = (resume?: string) =>
      this.runOnce(input, approvalMode, resume, startedAt)

    let res = await run(input.sessionId)
    // A resume that produced nothing (e.g. Bob rejected an index-only --resume value)
    // falls back to a fresh session — mirrors the SDK adapter.
    if (input.sessionId && !res.aborted && !res.sessionId && !res.text) {
      dbg(`resume ${input.sessionId.slice(0, 8)} produced nothing; starting fresh`)
      res = await run(undefined)
    }
    return { sessionId: res.sessionId || input.sessionId || '', text: res.text.trim() || '(no response)' }
  }

  /** Write knock-knock's deny path globs into `.bobignore` as the in-workspace
   *  read floor (the OS `--sandbox` is the command/network floor). User content
   *  outside the managed markers is preserved. Returns false only when there ARE
   *  deny globs but the file could not be written — the caller fails closed. */
  private ensureBobignore(denyGlobs: string[]): boolean {
    if (denyGlobs.length === 0) return true
    const path = join(this.cwd, '.bobignore')
    let existing = ''
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      // No existing .bobignore — start fresh.
    }
    const next = mergeBobignore(existing, denyGlobs)
    if (next === existing) return true
    try {
      writeFileSync(path, next)
      return true
    } catch (err) {
      process.stderr.write(`[bob] could not write .bobignore deny floor: ${err}\n`)
      return false
    }
  }

  /** Ask the owner once whether Bob may modify files / run commands this turn. */
  private async askTurnGate(promptText: string): Promise<Verdict> {
    const handler = this.permHandler
    if (!handler) return { behavior: 'deny', message: 'No approval handler; running read-only.' }
    try {
      return await handler({
        toolName: 'bob:write-actions',
        input: {
          subject: 'Bob Shell may edit files or run commands this turn',
          prompt: promptText.slice(0, 400),
        },
      })
    } catch {
      return { behavior: 'deny', message: 'Approval failed; running read-only.' }
    }
  }

  /** One `bob` invocation; resolves with the accumulated text, session id, and abort flag. */
  private runOnce(
    input: { text: string; signal?: AbortSignal; options?: TurnOptions },
    approvalMode: BobApprovalMode,
    resume: string | undefined,
    startedAt: number,
  ): Promise<{ sessionId: string; text: string; aborted: boolean }> {
    const args = buildBobArgs({
      prompt: input.text,
      approvalMode,
      sandbox: true,
      resume,
      model: input.options?.model,
    })
    dbg(`spawning: ${BOB_COMMAND} ${args.slice(1).join(' ')} (cwd=${this.cwd}, mode=${approvalMode})`)
    // Tool ids (`tool-1`, `tool-2`, …) restart each turn, so completion-id tracking
    // MUST be per-spawn or a later turn's reused id is misread as the answer.
    this.completionToolIds.clear()

    return new Promise(resolve => {
      const child = spawn(BOB_COMMAND, args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env },
      })
      trackChild(child)

      let sessionId = ''
      let streamed = ''
      let final = ''
      let aborted = false
      let buf = ''

      const onAbort = () => {
        aborted = true
        child.kill()
      }
      const cleanup = () => {
        if (input.signal) input.signal.removeEventListener('abort', onAbort)
      }
      if (input.signal) {
        if (input.signal.aborted) onAbort()
        else input.signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('error', err => {
        cleanup()
        process.stderr.write(`[bob] spawn error: ${err}\n`)
        this.emit({ type: 'turn_done', durationMs: Date.now() - startedAt })
        resolve({ sessionId, text: final || streamed, aborted })
      })

      child.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const ev = parseBobStreamLine(line)
          if (ev) {
            const acc = this.translate(ev, startedAt)
            if (acc.sessionId) sessionId = acc.sessionId
            if (acc.streamText) streamed += acc.streamText
            if (acc.finalText) final = acc.finalText
          }
        }
      })

      child.on('close', () => {
        cleanup()
        // Flush any trailing line without a newline.
        const ev = parseBobStreamLine(buf)
        if (ev) {
          const acc = this.translate(ev, startedAt)
          if (acc.sessionId) sessionId = acc.sessionId
          if (acc.streamText) streamed += acc.streamText
          if (acc.finalText) final = acc.finalText
        }
        // The attempt_completion result IS the answer; assistant chunks are status fallback.
        resolve({ sessionId, text: final || streamed, aborted })
      })
    })
  }

  /** Translate one Bob stream event into AgentEvent(s).
   *  `streamText` = assistant chunks (status fallback); `finalText` = the real answer
   *  carried by the attempt_completion tool. The caller prefers finalText. */
  private translate(
    ev: BobStreamEvent,
    startedAt: number,
  ): { sessionId?: string; streamText?: string; finalText?: string } {
    switch (ev.type) {
      case 'init':
        this.emit({ type: 'session_init', sessionId: ev.session_id ?? '', model: ev.model })
        return { sessionId: ev.session_id }
      case 'message': {
        if (ev.role !== 'assistant') return {}
        const text = typeof ev.content === 'string' ? ev.content : ''
        if (text) this.emit({ type: 'assistant_text', text })
        return { streamText: text }
      }
      case 'tool_use': {
        // attempt_completion is Bob's answer, not a real tool call — surface its result as text.
        if (ev.tool_name === BOB_COMPLETION_TOOL) {
          if (ev.tool_id) this.completionToolIds.add(ev.tool_id)
          const answer = completionText(ev.parameters)
          if (answer) this.emit({ type: 'assistant_text', text: answer })
          return answer ? { finalText: answer } : {}
        }
        this.emit({
          type: 'tool_call',
          toolCallId: ev.tool_id,
          name: ev.tool_name ?? 'tool',
          input: ev.parameters ?? {},
        })
        return {}
      }
      case 'tool_result': {
        // The completion tool's result already became the answer; don't double-emit it as a tool.
        if (ev.tool_id && this.completionToolIds.has(ev.tool_id)) {
          return { finalText: completionText(ev.output) }
        }
        this.emit({
          type: 'tool_result',
          toolCallId: ev.tool_id,
          status: ev.status === 'error' ? 'failed' : 'completed',
        })
        return {}
      }
      case 'result':
        this.emit({
          type: 'turn_done',
          tokensIn: statNum(ev.stats, ['input_tokens', 'inputTokens', 'promptTokens']),
          tokensOut: statNum(ev.stats, ['output_tokens', 'outputTokens', 'completionTokens']),
          turns: statNum(ev.stats, ['num_turns', 'numTurns', 'turns']),
          durationMs: Date.now() - startedAt,
        })
        return {}
      case 'error':
        return {}
    }
  }
}
