/**
 * ConsoleUI — operator-facing terminal renderer: one short line per AgentEvent, prefixed with the agent's name in a stable accent color.
 * Output goes to stderr so it never interleaves with agent stdout.
 */

import pc from 'picocolors'
import type { AgentEvent } from './agent-adapter.ts'

const ACCENTS = ['cyan', 'green', 'yellow', 'blue'] as const
type Accent = (typeof ACCENTS)[number]

function pickAccent(key: string): Accent {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ACCENTS[h % ACCENTS.length]!
}

function paint(accent: Accent, s: string): string {
  switch (accent) {
    case 'cyan':
      return pc.cyan(s)
    case 'green':
      return pc.green(s)
    case 'yellow':
      return pc.yellow(s)
    case 'blue':
      return pc.blue(s)
  }
}

/** Trim s to n chars (single line, newlines → spaces), ellipsis if cut. */
function squish(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return String(input ?? '')
  const r = input as Record<string, unknown>
  for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'subject']) {
    const v = r[k]
    if (typeof v === 'string' && v) return v
  }
  try {
    return JSON.stringify(input)
  } catch {
    return '[unserializable]'
  }
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined) return ''
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export type ChannelRef = { label: string }

export type TurnContext = {
  channel: ChannelRef
  sender: { label: string; kind: 'owner' | 'human' | 'agent' | 'unknown' }
  text: string
}

/** Boot-banner entry — one per started agent. */
export type BannerAgent = { key: string; runtime: string; workspace: string }

/** The operator-facing renderer seam. The relay/host speak only this interface, so the
 *  single-stream `ConsoleUI` and the multi-pane `PaneTUI` (src/tui.ts) are interchangeable.
 *  Per-bot methods are keyed by `agentKey`; `banner` is global. */
export interface RelayUI {
  banner(agents: BannerAgent[]): void
  connected(agentKey: string, displayName: string): void
  turnStart(agentKey: string, ctx: TurnContext): void
  event(agentKey: string, e: AgentEvent): void
  note(agentKey: string, text: string): void
  error(agentKey: string, text: string): void
}

export class ConsoleUI implements RelayUI {
  /** toolCallId → display label, so a failed result can name its tool. */
  private readonly toolLabels = new Map<string, string>()
  /** Agents that already showed an assistant-text preview this turn (collapse a streamed reply to one line). */
  private readonly assistantShown = new Set<string>()

  private write(line: string): void {
    process.stderr.write(line + '\n')
  }

  /** Relay startup banner. Called once at boot. */
  banner(agents: Array<{ key: string; runtime: string; workspace: string }>): void {
    const bar = pc.dim('─'.repeat(60))
    this.write('')
    this.write(
      `${pc.bold('knock-knock')} ${pc.dim(`· ${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`,
    )
    this.write(bar)
    for (const a of agents) {
      const accent = pickAccent(a.key)
      const chip = paint(accent, pc.bold(a.key))
      this.write(`  ${chip} ${pc.dim('·')} ${a.runtime} ${pc.dim('·')} ${pc.dim(a.workspace)}`)
    }
    this.write(bar)
    this.write('')
  }

  /** An agent's Discord login completed. */
  connected(agentKey: string, displayName: string): void {
    this.write(
      `${this.chip(agentKey)} ${pc.dim('·')} ${pc.green('connected')} as ${pc.bold(displayName)}`,
    )
  }

  /** Inbound mention received — print before any adapter events arrive. */
  turnStart(agentKey: string, ctx: TurnContext): void {
    const senderTone =
      ctx.sender.kind === 'owner'
        ? pc.bold
        : ctx.sender.kind === 'agent'
          ? pc.dim
          : (s: string) => s
    this.assistantShown.delete(agentKey)
    this.write('')
    this.write(
      `${this.chip(agentKey)} ${pc.bold('▸')} ${senderTone(ctx.sender.label)} ${pc.dim(`in ${ctx.channel.label}`)}`,
    )
    this.write(`${this.chip(agentKey)}   ${pc.dim('»')} ${squish(ctx.text, 160)}`)
  }

  /** Print one adapter event. */
  event(agentKey: string, e: AgentEvent): void {
    const chip = this.chip(agentKey)
    switch (e.type) {
      case 'session_init': {
        const parts = [pc.dim('•'), pc.dim('session'), pc.dim(e.sessionId.slice(0, 8))]
        if (e.model) parts.push(pc.dim('·'), pc.dim(e.model))
        if (e.tools !== undefined) parts.push(pc.dim('·'), pc.dim(`${e.tools} tools`))
        this.write(`${chip}   ${parts.join(' ')}`)
        return
      }
      case 'assistant_text': {
        // One preview per turn; the full reply goes to Discord.
        if (this.assistantShown.has(agentKey)) return
        const snippet = squish(e.text, 140)
        if (!snippet) return
        this.assistantShown.add(agentKey)
        this.write(`${chip}   ${pc.bold('◆')} ${snippet} ${pc.dim('…')}`)
        return
      }
      case 'tool_call': {
        const label = e.title?.trim() || e.name
        const subject = squish(stringifyInput(e.input), 100)
        const tail = subject && subject !== label ? ` ${pc.dim(subject)}` : ''
        if (e.toolCallId) this.rememberToolLabel(e.toolCallId, label)
        this.write(`${chip}   ${pc.cyan('→')} ${pc.bold(label)}${tail}`)
        return
      }
      case 'tool_result': {
        if (e.status === 'failed') {
          const named = e.toolCallId ? this.toolLabels.get(e.toolCallId) : undefined
          const what = named ? `${pc.bold(named)} ${pc.dim('failed')}` : pc.dim('tool failed')
          this.write(`${chip}   ${pc.red('✗')} ${what}`)
        }
        // 'completed' stays silent.
        return
      }
      case 'turn_done': {
        const bits: string[] = []
        if (e.durationMs !== undefined) bits.push(fmtDuration(e.durationMs))
        if (e.tokensIn !== undefined || e.tokensOut !== undefined) {
          bits.push(`${fmtTokens(e.tokensIn)} in / ${fmtTokens(e.tokensOut)} out`)
        }
        const cost = fmtCost(e.costUsd)
        if (cost) bits.push(cost)
        const tail = bits.length ? ' ' + bits.map(b => pc.dim(b)).join(pc.dim(' · ')) : ''
        this.write(`${chip}   ${pc.dim('──')}${tail}`)
        return
      }
    }
  }

  /** Quiet operator note (e.g. permission decision, fallback warning). */
  note(agentKey: string, text: string): void {
    this.write(`${this.chip(agentKey)}   ${pc.dim(text)}`)
  }

  /** Inline error from somewhere in the host's run loop. */
  error(agentKey: string, text: string): void {
    this.write(`${this.chip(agentKey)}   ${pc.red('!')} ${text}`)
  }

  private rememberToolLabel(toolCallId: string, label: string): void {
    this.toolLabels.set(toolCallId, label)
    if (this.toolLabels.size > 256) {
      const first = this.toolLabels.keys().next().value
      if (first) this.toolLabels.delete(first)
    }
  }

  private chip(agentKey: string): string {
    return paint(pickAccent(agentKey), `[${agentKey}]`)
  }
}
