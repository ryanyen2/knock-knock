/**
 * DmCourier — live transcript of an agent's work in the owner's Discord DM.
 *
 * Phase 1: the per-turn state lives in the Turn fold over the ledger, not in
 * a local `events[]` buffer. DmCourier subscribes to the fold for the active
 * turn's promptHash; every fold delta re-renders the DM message in place.
 * Result: the DM transcript is now a pure projection — replayable from any
 * frontier, survives a restart, and is exactly the same data the auditor sees.
 *
 * Failure mode: if the owner has closed DMs (or the bot otherwise can't reach
 * them), the courier disables itself for that owner for the rest of the
 * process. The agent keeps working; the operator sees a one-line note in the
 * terminal renderer. No retries per turn — Discord's "cannot DM this user"
 * error is sticky.
 */

import type { MessagingAdapter, MessageRef } from './messaging-adapter.ts'
import type { FoldEngine } from './ledger/fold.ts'
import {
  TURN_FOLD,
  type TurnFoldState,
  type TurnState,
  type TurnToolCall,
} from './ledger/concepts/turn.ts'
import type { Hash } from './ledger/interaction.ts'

const EDIT_DEBOUNCE_MS = 500
const MAX_TOOL_LINES = 14
const MAX_MESSAGE_CHARS = 1900 // leave headroom under Discord's 2000 cap
const MAX_FINAL_TEXT_CHARS = 800

export type DmTurnContext = {
  senderLabel: string
  channelLabel: string
  userPrompt: string
  /** Hash of the turn.prompted record — the fold key for this turn. */
  promptHash: Hash
}

export interface TurnHandle {
  /** Mark the turn done. Renders one final time with the optional error. */
  finalize(error?: string): Promise<void>
}

export class DmCourier {
  private disabled = new Set<string>()

  constructor(
    private readonly messaging: MessagingAdapter,
    private readonly engine: FoldEngine,
    /** Re-read on each turn so owner changes take effect without a restart. */
    private readonly getOwnerId: () => string | undefined,
    /** Called when DM delivery is impossible so the operator sees one note. */
    private readonly onDeliveryFailure?: (reason: string) => void,
  ) {}

  /** Begin a turn. Returns a no-op handle if DMs are unavailable. */
  async beginTurn(ctx: DmTurnContext): Promise<TurnHandle> {
    const ownerId = this.getOwnerId()
    if (!ownerId || this.disabled.has(ownerId)) return noopHandle

    return new LiveTurn(this.messaging, ownerId, ctx, this.engine, () => {
      this.disabled.add(ownerId)
      this.onDeliveryFailure?.('DM send failed mid-turn; disabling for this owner.')
    })
  }
}

class LiveTurn implements TurnHandle {
  private ref?: MessageRef
  private debounceTimer?: ReturnType<typeof setTimeout>
  private rendering: Promise<void> = Promise.resolve()
  private errorText?: string
  private done = false
  private readonly unsubscribe: () => void
  private latestState?: TurnState

  constructor(
    private readonly messaging: MessagingAdapter,
    private readonly ownerId: string,
    private readonly ctx: DmTurnContext,
    private readonly engine: FoldEngine,
    private readonly onSendFailure: () => void,
  ) {
    // Subscribe to the Turn fold; render on every change for this turn's
    // promptHash. The initial state is delivered eagerly by the engine.
    this.unsubscribe = this.engine.subscribe<TurnFoldState>(TURN_FOLD, state => {
      const turn = state.get(this.ctx.promptHash)
      if (turn) {
        this.latestState = turn
        this.scheduleRender()
      }
    })
  }

  async finalize(error?: string): Promise<void> {
    if (this.done) return
    this.done = true
    this.errorText = error
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.unsubscribe()
    await this.rendering
    await this.flush()
  }

  private scheduleRender(): void {
    if (this.debounceTimer || this.done) return
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
    if (!this.ref) {
      // First render opens the DM. A missing ref means the owner can't be DM'd
      // (closed DMs) — disable for this owner, exactly as the old openDm failure
      // path did, just deferred to the first actual send.
      const ref = await this.messaging.dm(this.ownerId, body)
      if (ref) this.ref = ref
      else this.onSendFailure()
      return
    }
    const ok = await this.messaging.edit(this.ref, body)
    if (!ok) this.onSendFailure()
  }

  private render(): string {
    const lines: string[] = []
    lines.push(`▸ **${escapeMd(this.ctx.senderLabel)}** in **${escapeMd(this.ctx.channelLabel)}**`)
    const prompt = squish(this.ctx.userPrompt, 220)
    if (prompt) lines.push(`> ${prompt}`)
    lines.push('')

    const turn = this.latestState
    if (turn) {
      const toolLines = renderToolCalls(turn.toolCalls)
      lines.push(...toolLines)

      if (turn.reply) {
        lines.push('')
        lines.push('───')
        lines.push(squish(turn.reply.text, MAX_FINAL_TEXT_CHARS))
      }
    }

    if (this.errorText) {
      lines.push('')
      lines.push(`⚠️ ${squish(this.errorText, 200)}`)
    }

    if (this.done && !this.errorText && !turn?.reply) {
      lines.push('')
      lines.push('-# done')
    }

    let body = lines.join('\n').trimEnd()
    if (body.length > MAX_MESSAGE_CHARS) {
      body = body.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
    }
    return body || '(working…)'
  }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function renderToolCalls(tools: TurnToolCall[]): string[] {
  const lines = tools.map(t => {
    const subject = squish(extractSubject(t.inputJson), 140)
    const name = `**${escapeMd(t.name)}**`
    const head = subject ? `• ${name} \`${subject}\`` : `• ${name}`
    if (t.status === 'failed') return `${head}\n  ↳ ⚠️ failed`
    if (t.status === 'denied') return `${head}\n  ↳ ❌ denied`
    if (t.status === 'requested') return `${head}\n  ↳ … pending`
    return head
  })
  if (lines.length <= MAX_TOOL_LINES) return lines
  const head = lines.slice(0, 3)
  const tailCount = MAX_TOOL_LINES - 4
  const tail = lines.slice(lines.length - tailCount)
  const hidden = lines.length - head.length - tail.length
  return [...head, `-# … ${hidden} more step${hidden === 1 ? '' : 's'} …`, ...tail]
}

function extractSubject(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson) as unknown
    if (typeof parsed === 'string') return parsed
    if (!parsed || typeof parsed !== 'object') return String(parsed ?? '')
    const r = parsed as Record<string, unknown>
    for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern']) {
      const v = r[k]
      if (typeof v === 'string' && v) return v
    }
    return inputJson
  } catch {
    return inputJson
  }
}

function squish(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

/** Escape Discord markdown control characters in user-supplied strings. */
function escapeMd(s: string): string {
  return s.replace(/([*_`~|>])/g, '\\$1')
}

const noopHandle: TurnHandle = {
  finalize: async () => {},
}
