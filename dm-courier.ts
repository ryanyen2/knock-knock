/**
 * DmCourier — live transcript of an agent's work in the owner's Discord DM.
 *
 * One DmCourier per AgentHost. On each inbound mention the host calls
 * beginTurn(ctx) to get a TurnHandle; the host forwards adapter events into
 * handle.onEvent and finally handle.finalize(finalText). The handle posts ONE
 * DM message and edits it in place as events arrive — so the owner sees a
 * compact, live transcript without their DM inbox getting spammed.
 *
 * Failure mode: if the owner has closed DMs (or the bot otherwise can't reach
 * them), the courier disables itself for that owner for the rest of the
 * process. The agent keeps working; the operator sees a one-line note in the
 * terminal renderer. No retries per turn — Discord's "cannot DM this user"
 * error is sticky.
 */

import type { Client, Message, DMChannel } from 'discord.js'
import type { AgentEvent } from './agent-adapter.ts'

const EDIT_DEBOUNCE_MS = 500
const MAX_EVENT_LINES = 14
const MAX_MESSAGE_CHARS = 1900 // leave headroom under Discord's 2000 cap
const MAX_FINAL_TEXT_CHARS = 800

export type DmTurnContext = {
  senderLabel: string
  channelLabel: string
  userPrompt: string
}

export interface TurnHandle {
  onEvent(e: AgentEvent): void
  finalize(finalText?: string, error?: string): Promise<void>
}

export class DmCourier {
  private dmCache = new Map<string, DMChannel>()
  private disabled = new Set<string>()

  constructor(
    private readonly client: Client,
    /** Re-read on each turn so owner changes take effect without a restart. */
    private readonly getOwnerId: () => string | undefined,
    /** Called when DM delivery is impossible so the operator sees one note. */
    private readonly onDeliveryFailure?: (reason: string) => void,
  ) {}

  /** Begin a turn. Returns a no-op handle if DMs are unavailable. */
  async beginTurn(ctx: DmTurnContext): Promise<TurnHandle> {
    const ownerId = this.getOwnerId()
    if (!ownerId || this.disabled.has(ownerId)) return noopHandle

    const dm = await this.openDm(ownerId).catch(err => {
      this.disabled.add(ownerId)
      this.onDeliveryFailure?.(`DM unavailable: ${err}`)
      return undefined
    })
    if (!dm) return noopHandle

    return new LiveTurn(dm, ctx, () => {
      this.disabled.add(ownerId)
      this.onDeliveryFailure?.('DM send failed mid-turn; disabling for this owner.')
    })
  }

  /** Fetch (and cache) the owner's DM channel. */
  private async openDm(ownerId: string): Promise<DMChannel> {
    const cached = this.dmCache.get(ownerId)
    if (cached) return cached
    const user = await this.client.users.fetch(ownerId)
    const dm = await user.createDM()
    this.dmCache.set(ownerId, dm)
    return dm
  }
}

class LiveTurn implements TurnHandle {
  private events: AgentEvent[] = []
  private message?: Message
  private debounceTimer?: ReturnType<typeof setTimeout>
  private pendingRender = false
  private rendering: Promise<void> = Promise.resolve()
  private finalText?: string
  private errorText?: string
  private done = false

  constructor(
    private readonly dm: DMChannel,
    private readonly ctx: DmTurnContext,
    private readonly onSendFailure: () => void,
  ) {}

  onEvent(e: AgentEvent): void {
    if (this.done) return
    this.events.push(e)
    this.scheduleRender()
  }

  async finalize(finalText?: string, error?: string): Promise<void> {
    if (this.done) return
    this.done = true
    this.finalText = finalText
    this.errorText = error
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    // Wait for any in-flight render, then post the final state.
    await this.rendering
    await this.flush()
  }

  private scheduleRender(): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.flush()
    }, EDIT_DEBOUNCE_MS)
  }

  private flush(): Promise<void> {
    this.rendering = this.rendering.then(() => this.doRender())
    return this.rendering
  }

  private async doRender(): Promise<void> {
    const body = this.render()
    try {
      if (!this.message) {
        this.message = await this.dm.send(body)
      } else {
        await this.message.edit(body)
      }
    } catch {
      this.onSendFailure()
    }
  }

  private render(): string {
    const lines: string[] = []
    lines.push(`▸ **${escapeMd(this.ctx.senderLabel)}** in **${escapeMd(this.ctx.channelLabel)}**`)
    const prompt = squish(this.ctx.userPrompt, 220)
    if (prompt) lines.push(`> ${prompt}`)
    lines.push('')

    const eventLines = renderEventLines(this.events)
    lines.push(...eventLines)

    if (this.finalText) {
      lines.push('')
      lines.push('───')
      lines.push(squish(this.finalText, MAX_FINAL_TEXT_CHARS))
    }
    if (this.errorText) {
      lines.push('')
      lines.push(`⚠️ ${squish(this.errorText, 200)}`)
    }

    const footer = renderFooter(this.events, this.done)
    if (footer) {
      lines.push('')
      lines.push(footer)
    }

    let body = lines.join('\n').trimEnd()
    if (body.length > MAX_MESSAGE_CHARS) {
      body = body.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
    }
    return body || '(working…)'
  }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function renderEventLines(events: AgentEvent[]): string[] {
  const lines: string[] = []
  for (const e of events) {
    const line = renderEvent(e)
    if (line) lines.push(line)
  }
  if (lines.length <= MAX_EVENT_LINES) return lines
  const head = lines.slice(0, 3)
  const tailCount = MAX_EVENT_LINES - 4
  const tail = lines.slice(lines.length - tailCount)
  const hidden = lines.length - head.length - tail.length
  return [...head, `-# … ${hidden} more step${hidden === 1 ? '' : 's'} …`, ...tail]
}

function renderEvent(e: AgentEvent): string | undefined {
  switch (e.type) {
    case 'session_init': {
      const bits = [`\`session ${e.sessionId.slice(0, 8)}\``]
      if (e.model) bits.push(`\`${e.model}\``)
      if (e.tools !== undefined) bits.push(`${e.tools} tools`)
      return `-# • ${bits.join(' · ')}`
    }
    case 'assistant_text': {
      const t = squish(e.text, 220)
      return t ? `◆ ${t}` : undefined
    }
    case 'tool_call': {
      const subject = squish(stringifyInput(e.input), 140)
      const name = `**${escapeMd(e.name)}**`
      return subject ? `• ${name} \`${subject}\`` : `• ${name}`
    }
    case 'tool_result':
      return e.status === 'failed' ? `  ↳ ⚠️ failed` : undefined
    case 'turn_done':
      return undefined // handled in renderFooter
  }
}

function renderFooter(events: AgentEvent[], done: boolean): string | undefined {
  const last = [...events].reverse().find(e => e.type === 'turn_done') as
    | Extract<AgentEvent, { type: 'turn_done' }>
    | undefined
  if (!last && !done) return undefined
  const bits: string[] = []
  if (last?.durationMs !== undefined) bits.push(fmtDuration(last.durationMs))
  if (last?.tokensIn !== undefined || last?.tokensOut !== undefined) {
    bits.push(`${fmtTokens(last?.tokensIn)} in / ${fmtTokens(last?.tokensOut)} out`)
  }
  if (last?.costUsd !== undefined) bits.push(fmtCost(last.costUsd))
  if (!bits.length && done) bits.push('done')
  return bits.length ? `-# ${bits.join(' · ')}` : undefined
}

function stringifyInput(input: unknown): string {
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
    return '[unserializable]'
  }
}

function squish(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

function fmtCost(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Escape Discord markdown control characters in user-supplied strings. */
function escapeMd(s: string): string {
  return s.replace(/([*_`~|>])/g, '\\$1')
}

const noopHandle: TurnHandle = {
  onEvent: () => {},
  finalize: async () => {},
}
