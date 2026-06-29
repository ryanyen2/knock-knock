/**
 * Questions — messaging UX for the agent's AskUserQuestion tool: posts each question's
 * options as owner-gated choice buttons and feeds the picked label back to the model
 * (the host returns it as `{behavior:'allow', updatedInput:{...input, answers}}`, the
 * verified headless injection path). Sibling to `approvals.ts`, but the await is an
 * in-memory promise, NOT a ledger verdict: a question only lives inside an in-flight
 * turn, so if the turn aborts the question dies with it — ledger durability buys nothing.
 *
 * v1 is single-pick per question. A `multiSelect` question still renders its options as
 * buttons and the first tap answers it (one label is a valid answer); full multi-pick +
 * confirm is a follow-up.
 */

import type { Choice, IncomingAction, MessagingAdapter } from '../messaging-adapter.ts'
import type { AgentConfig } from '../lib.ts'
import { approverForAgent } from '../lib.ts'
import type { ChannelId } from '../ledger/interaction.ts'

/** One question as it crosses the adapter seam (input is `unknown`; parsed defensively). */
type ParsedQuestion = { question: string; header: string; labels: string[] }

type Pending = {
  resolve: (label: string | undefined) => void
  /** Option labels by index, so a button's optIdx maps back to the full label. */
  labels: string[]
  originChannelId: ChannelId
  promptChannelId: string
  messageId: string
  body: string
}

const LABEL_MAX = 72 // Discord button labels cap at 80; leave headroom.

function parseQuestions(input: unknown): ParsedQuestion[] {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs)) return []
  const out: ParsedQuestion[] = []
  for (const q of qs) {
    if (!q || typeof q !== 'object') continue
    const r = q as { question?: unknown; header?: unknown; options?: unknown }
    const question = typeof r.question === 'string' ? r.question : ''
    const header = typeof r.header === 'string' ? r.header : 'Question'
    const labels = Array.isArray(r.options)
      ? r.options
          .map(o => (o && typeof o === 'object' ? (o as { label?: unknown }).label : undefined))
          .filter((l): l is string => typeof l === 'string' && l.length > 0)
      : []
    if (question && labels.length > 0) out.push({ question, header, labels })
  }
  return out
}

export class Questions {
  /** promptId → pending question awaiting a pick. */
  private readonly pending = new Map<string, Pending>()
  private seq = 0

  constructor(
    private readonly messaging: MessagingAdapter,
    /** Re-read per resolution so owner changes take effect without restart. */
    private readonly getAgent: () => AgentConfig,
    /** Register the posted prompt so a TEXT reply can resolve it where buttons are absent. */
    private readonly onPrompt?: (scope: string, messageId: string, choices: Choice[]) => void,
    private readonly onPromptDone?: (scope: string, messageId: string) => void,
  ) {}

  handles(action: IncomingAction): boolean {
    return action.actionId.startsWith('qstn:')
  }

  /**
   * Surface an AskUserQuestion tool call as choice cards and collect the answers.
   * Returns a `{questionText: pickedLabel}` map, or `undefined` if any question went
   * unanswered (timed out / unreachable) so the host can deny and let the turn end.
   */
  async ask(channelId: ChannelId, input: unknown, timeoutMs: number): Promise<Record<string, string> | undefined> {
    const questions = parseQuestions(input)
    if (questions.length === 0) return undefined

    const approverId = approverForAgent(this.getAgent(), channelId)
    const answers: Record<string, string> = {}

    // Sequential: one card per question. Most AskUserQuestion calls ask 1–2.
    for (const q of questions) {
      const picked = await this.askOne(channelId, q, approverId, timeoutMs)
      if (picked === undefined) return undefined // unanswered → host denies the whole tool call
      answers[q.question] = picked
    }
    return answers
  }

  async resolve(action: IncomingAction): Promise<void> {
    const m = /^qstn:(\d+):(\d+)$/.exec(action.actionId)
    if (!m) return
    const [, promptId, optIdxRaw] = m
    const p = this.pending.get(promptId!)
    if (!p) {
      await action.respond('Question no longer pending.', { ephemeral: true })
      return
    }

    const approverId = approverForAgent(this.getAgent(), p.originChannelId)
    if (!approverId || action.userId !== approverId) {
      await action.respond('⚠️ Only this bot’s owner can answer this question.', { ephemeral: true })
      return
    }

    const label = p.labels[Number(optIdxRaw)]
    if (label === undefined) return
    await action.update(`${p.body}\n\n✅ ${label}`)
    this.finish(promptId!, label)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private askOne(
    channelId: ChannelId,
    q: ParsedQuestion,
    approverId: string | undefined,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const promptId = String(this.seq++)
    const choices: Choice[] = q.labels.map((label, i) => ({
      id: `qstn:${promptId}:${i}`,
      label: label.length > LABEL_MAX ? label.slice(0, LABEL_MAX - 1) + '…' : label,
    }))
    const body = `❓ **${q.header}**\n${q.question}`

    return new Promise<string | undefined>(resolve => {
      let settled = false
      const settle = (label: string | undefined) => {
        if (settled) return
        settled = true
        const p = this.pending.get(promptId)
        if (p) {
          this.pending.delete(promptId)
          this.onPromptDone?.(p.promptChannelId, p.messageId)
        }
        resolve(label)
      }

      const timer = setTimeout(() => settle(undefined), timeoutMs)

      void this.messaging
        .send(channelId, body, {
          choices,
          ...(approverId ? { mentionUser: approverId, mentionOnly: approverId } : {}),
        })
        .then(ref => {
          if (!ref) {
            clearTimeout(timer)
            settle(undefined) // can't reach the channel — leave the question unanswered
            return
          }
          this.pending.set(promptId, {
            // wrap so the timer is cleared on a button/text resolution
            resolve: label => {
              clearTimeout(timer)
              settle(label)
            },
            labels: q.labels,
            originChannelId: channelId,
            promptChannelId: ref.scope,
            messageId: ref.id,
            body,
          })
          this.onPrompt?.(ref.scope, ref.id, choices)
        })
        .catch(() => {
          clearTimeout(timer)
          settle(undefined)
        })
    })
  }

  private finish(promptId: string, label: string): void {
    this.pending.get(promptId)?.resolve(label)
  }
}
