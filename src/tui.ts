/**
 * PaneTUI — a hand-rolled, dependency-free split-pane renderer for the relay.
 * Implements the same `RelayUI` seam as `ConsoleUI`, so the relay/hosts are unchanged;
 * the difference is purely presentation: one stacked, full-width pane per active bot
 * (header + scroll-back tail), a title bar, and a footer for global notes + the idle
 * strip. Renders on the alternate screen with ANSI, throttled, resize-aware, and
 * restores the terminal on `stop()`.
 *
 * Panes are created lazily (on banner/connect/turn/event for a key), so a bot that
 * "wakes" mid-run (Phase 4) gets a pane the moment it first acts — no special wiring.
 */

import pc from 'picocolors'
import type { AgentEvent } from './agent-adapter.ts'
import type { BannerAgent, RelayUI, TurnContext } from './console-ui.ts'

type Tone = 'plain' | 'dim' | 'red' | 'bold' | 'accent'
type Line = { text: string; tone: Tone }
type PaneStatus = 'idle' | 'connected' | 'working' | 'done' | 'failed'

const ACCENTS = ['cyan', 'green', 'yellow', 'blue', 'magenta'] as const
type Accent = (typeof ACCENTS)[number]

const SCROLLBACK = 500 // lines retained per pane (only the visible tail is drawn)
const FOOTER_ROWS = 4 // title-bar is 1 row; footer holds global notes + idle strip
const REDRAW_MS = 80 // coalesce bursts of events into one repaint

function accentFor(key: string): Accent {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ACCENTS[h % ACCENTS.length]!
}

function paintAccent(accent: Accent, s: string): string {
  switch (accent) {
    case 'cyan': return pc.cyan(s)
    case 'green': return pc.green(s)
    case 'yellow': return pc.yellow(s)
    case 'blue': return pc.blue(s)
    case 'magenta': return pc.magenta(s)
  }
}

function flatten(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, Math.max(0, n - 1)) + '…' : flat
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return String(input ?? '')
  const r = input as Record<string, unknown>
  for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'subject']) {
    const v = r[k]
    if (typeof v === 'string' && v) return v
  }
  try { return JSON.stringify(input) } catch { return '[unserializable]' }
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const STATUS_GLYPH: Record<PaneStatus, string> = {
  idle: '·', connected: '●', working: '▸', done: '✓', failed: '✗',
}

type Pane = {
  key: string
  accent: Accent
  displayName?: string
  runtime?: string
  status: PaneStatus
  lines: Line[]
  /** Collapse a streamed reply to one preview line per turn. */
  assistantShown: boolean
  toolLabels: Map<string, string>
}

export class PaneTUI implements RelayUI {
  private readonly panes = new Map<string, Pane>()
  /** Stable display order (insertion order of first appearance). */
  private readonly order: string[] = []
  private readonly footer: Line[] = []
  /** agentKey → "idle (listening)" strip; cleared when the bot activates. */
  private readonly idle = new Map<string, string>()
  private started = false
  private redrawTimer: ReturnType<typeof setTimeout> | undefined
  private readonly onResize = () => this.draw()

  // ─── RelayUI surface ────────────────────────────────────────────────────────

  banner(agents: BannerAgent[]): void {
    this.start()
    for (const a of agents) {
      const pane = this.ensure(a.key)
      pane.runtime = a.runtime
      if (pane.status === 'idle') pane.status = 'connected'
    }
    this.schedule()
  }

  connected(agentKey: string, displayName: string): void {
    const pane = this.ensure(agentKey)
    pane.displayName = displayName
    if (pane.status === 'idle') pane.status = 'connected'
    this.push(pane, `connected as ${displayName}`, 'dim')
  }

  turnStart(agentKey: string, ctx: TurnContext): void {
    const pane = this.ensure(agentKey)
    pane.status = 'working'
    pane.assistantShown = false
    this.push(pane, `▸ ${ctx.sender.label} in ${ctx.channel.label}`, 'bold')
    this.push(pane, `  » ${flatten(ctx.text, 200)}`, 'dim')
  }

  event(agentKey: string, e: AgentEvent): void {
    const pane = this.ensure(agentKey)
    switch (e.type) {
      case 'session_init': {
        const bits = [`session ${e.sessionId.slice(0, 8)}`]
        if (e.model) bits.push(e.model)
        if (e.tools !== undefined) bits.push(`${e.tools} tools`)
        this.push(pane, `  • ${bits.join(' · ')}`, 'dim')
        return
      }
      case 'assistant_text': {
        if (pane.assistantShown) return
        const snippet = flatten(e.text, 200)
        if (!snippet) return
        pane.assistantShown = true
        this.push(pane, `  ◆ ${snippet}`, 'plain')
        return
      }
      case 'tool_call': {
        const label = e.title?.trim() || e.name
        if (e.toolCallId) {
          pane.toolLabels.set(e.toolCallId, label)
          if (pane.toolLabels.size > 256) {
            const first = pane.toolLabels.keys().next().value
            if (first) pane.toolLabels.delete(first)
          }
        }
        const subject = flatten(stringifyInput(e.input), 120)
        const tail = subject && subject !== label ? ` ${subject}` : ''
        this.push(pane, `  → ${label}${tail}`, 'accent')
        return
      }
      case 'tool_result': {
        if (e.status === 'failed') {
          const named = e.toolCallId ? pane.toolLabels.get(e.toolCallId) : undefined
          this.push(pane, `  ✗ ${named ? `${named} failed` : 'tool failed'}`, 'red')
        }
        return
      }
      case 'turn_done': {
        pane.status = 'done'
        const bits: string[] = []
        const dur = fmtDuration(e.durationMs)
        if (dur) bits.push(dur)
        if (e.tokensIn !== undefined || e.tokensOut !== undefined) {
          bits.push(`${fmtTokens(e.tokensIn)} in / ${fmtTokens(e.tokensOut)} out`)
        }
        if (e.costUsd !== undefined) bits.push(`$${e.costUsd < 0.01 ? e.costUsd.toFixed(4) : e.costUsd.toFixed(3)}`)
        this.push(pane, `  ── ${bits.join(' · ')}`, 'dim')
        return
      }
    }
  }

  note(agentKey: string, text: string): void {
    const pane = this.panes.get(agentKey)
    if (pane) this.push(pane, text, 'dim')
    else this.pushFooter(`${agentKey}: ${text}`, 'dim')
  }

  error(agentKey: string, text: string): void {
    const pane = this.panes.get(agentKey)
    if (pane) { pane.status = 'failed'; this.push(pane, `! ${text}`, 'red') }
    else this.pushFooter(`${agentKey}: ${text}`, 'red')
  }

  // ─── Extra surface used by the relay (beyond RelayUI) ─────────────────────────

  /** Show bots that are connected-but-idle in the footer strip (Phase 4). */
  setIdle(entries: Array<{ key: string; rooms: number }>): void {
    this.idle.clear()
    for (const e of entries) this.idle.set(e.key, `${e.key} (${e.rooms} ch)`)
    this.schedule()
  }

  /** Promote an idle bot to an active pane (on wake). */
  activate(key: string, runtime?: string): void {
    this.idle.delete(key)
    const pane = this.ensure(key)
    if (runtime) pane.runtime = runtime
    pane.status = 'connected'
    this.push(pane, '⏰ woke on message', 'bold')
  }

  /** Restore the terminal. Idempotent; safe to call from the relay shutdown path. */
  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.redrawTimer) { clearTimeout(this.redrawTimer); this.redrawTimer = undefined }
    process.stdout.off?.('resize', this.onResize)
    // Show cursor, leave the alternate screen (restores the prior scrollback).
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }

  // ─── internals ────────────────────────────────────────────────────────────────

  private start(): void {
    if (this.started) return
    this.started = true
    // Enter the alternate screen + hide the cursor.
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    process.stdout.on?.('resize', this.onResize)
  }

  private ensure(key: string): Pane {
    let pane = this.panes.get(key)
    if (!pane) {
      pane = {
        key,
        accent: accentFor(key),
        status: 'idle',
        lines: [],
        assistantShown: false,
        toolLabels: new Map(),
      }
      this.panes.set(key, pane)
      this.order.push(key)
      this.idle.delete(key)
    }
    return pane
  }

  private push(pane: Pane, text: string, tone: Tone): void {
    pane.lines.push({ text, tone })
    if (pane.lines.length > SCROLLBACK) pane.lines.splice(0, pane.lines.length - SCROLLBACK)
    this.schedule()
  }

  private pushFooter(text: string, tone: Tone): void {
    this.footer.push({ text, tone })
    if (this.footer.length > FOOTER_ROWS) this.footer.splice(0, this.footer.length - FOOTER_ROWS)
    this.schedule()
  }

  private schedule(): void {
    if (!this.started || this.redrawTimer) return
    this.redrawTimer = setTimeout(() => { this.redrawTimer = undefined; this.draw() }, REDRAW_MS)
  }

  private tonePaint(tone: Tone, accent: Accent, s: string): string {
    switch (tone) {
      case 'plain': return s
      case 'dim': return pc.dim(s)
      case 'red': return pc.red(s)
      case 'bold': return pc.bold(s)
      case 'accent': return paintAccent(accent, s)
    }
  }

  private draw(): void {
    if (!this.started) return
    const cols = Math.max(40, process.stdout.columns || 80)
    const rows = Math.max(10, process.stdout.rows || 24)
    const out: string[] = []

    // Title bar (padded to full width so the inverse bar spans the terminal).
    const active = this.order.length
    const title = ` knock-knock · ${active} active${this.idle.size ? ` · ${this.idle.size} idle` : ''} `
    out.push(pc.inverse(pc.bold(title.slice(0, cols).padEnd(cols))))

    const footerRows = FOOTER_ROWS
    const bodyRows = Math.max(1, rows - 1 - footerRows)

    if (active === 0) {
      out.push(pc.dim('  (no active bots — waiting…)'))
      for (let i = 1; i < bodyRows; i++) out.push('')
    } else {
      const per = Math.max(2, Math.floor(bodyRows / active))
      let used = 0
      for (let pi = 0; pi < active; pi++) {
        const key = this.order[pi]!
        const pane = this.panes.get(key)!
        // The last pane soaks up any remainder rows.
        const h = pi === active - 1 ? bodyRows - used : per
        used += h
        // Header.
        const glyph = STATUS_GLYPH[pane.status]
        const head = `${glyph} ${pane.key}${pane.displayName ? ` (${pane.displayName})` : ''} · ${pane.runtime ?? '?'} · ${pane.status}`
        out.push(paintAccent(pane.accent, pc.bold(clip(head, cols))))
        // Body: the last (h-1) lines.
        const bodyH = Math.max(0, h - 1)
        const tail = pane.lines.slice(-bodyH)
        for (let i = 0; i < bodyH; i++) {
          const line = tail[i]
          out.push(line ? this.tonePaint(line.tone, pane.accent, clip(line.text, cols)) : '')
        }
      }
    }

    // Footer: separator, idle strip, recent global notes.
    out.push(pc.dim('─'.repeat(cols)))
    const idleLine = this.idle.size
      ? pc.dim('idle: ') + [...this.idle.values()].join(pc.dim(' · '))
      : pc.dim('idle: (none)')
    out.push(clip(idleLine, cols))
    const notes = this.footer.slice(-(footerRows - 2))
    for (let i = 0; i < footerRows - 2; i++) {
      const n = notes[i]
      out.push(n ? this.tonePaint(n.tone, 'cyan', clip(n.text, cols)) : '')
    }

    // Paint: home, then each row cleared to EOL; clear below at the end.
    let frame = '\x1b[H'
    for (let i = 0; i < rows; i++) {
      frame += (out[i] ?? '') + '\x1b[K'
      if (i < rows - 1) frame += '\n'
    }
    frame += '\x1b[J'
    process.stdout.write(frame)
  }
}

// ─── width helpers (ANSI-aware) ─────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

function visibleLen(s: string): number {
  return s.replace(ANSI, '').length
}

/** Truncate to `width` visible columns. Inputs here are plain (uncolored) text, so a
 *  plain slice is correct; the ellipsis marks a cut. */
function clip(s: string, width: number): string {
  if (width <= 0) return ''
  const v = visibleLen(s)
  if (v <= width) return s
  // Plain text path (no embedded ANSI in pane/footer text): simple slice.
  if (!s.includes('\x1b[')) return s.slice(0, Math.max(0, width - 1)) + '…'
  // Defensive: strip codes then cut (rare — only the pre-colored idle strip reaches here).
  return s.replace(ANSI, '').slice(0, Math.max(0, width - 1)) + '…'
}
