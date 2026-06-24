/**
 * Session distiller — pure, no I/O. Turns a NormalizedTranscript into a compact
 * context brief (inner text only; `wrapSharedContext` adds the envelope).
 */

import type { NormalizedTranscript, TranscriptEvent } from './session-store.ts'

export type DistilledBrief = { brief: string; tags: string[] }

const SECTION_CAP = 1200 // per-section char budget
const TOTAL_CAP = 4000 // whole-brief char budget

/** Cues that mark an assistant line as a decision worth carrying forward. */
const DECISION_CUES =
  /\b(decid|chose|choose|chosen|approach|instead|because|trade-?off|rather than|we'll|we will|going with|opt(ed|ing)? for|the plan is)\b/i

/** Cues that mark a dead-end / pitfall worth warning the next agent about. */
const PITFALL_CUES =
  /\b(turned out|doesn't work|didn't work|does not work|failed|broke|revert|gotcha|pitfall|caveat|the issue (is|was)|problem (is|was)|blocked)\b/i

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

function cap(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Checklist marker for a todo status. */
function todoMark(status: unknown): string {
  if (status === 'completed') return 'x'
  if (status === 'in_progress') return '~'
  return ' '
}

/** Latest ExitPlanMode plan text, if any. */
function latestPlan(events: TranscriptEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.role === 'tool' && e.tool?.name === 'ExitPlanMode') {
      const input = e.tool.input as { plan?: unknown } | undefined
      const plan = asString(input?.plan)
      if (plan) return plan
    }
  }
  return undefined
}

/** Latest TodoWrite list rendered as a status checklist, if any. */
function latestTodos(events: TranscriptEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.role === 'tool' && e.tool?.name === 'TodoWrite') {
      const input = e.tool.input as { todos?: unknown } | undefined
      const todos = input?.todos
      if (!Array.isArray(todos)) continue
      const lines = todos
        .map(t => {
          if (!t || typeof t !== 'object') return undefined
          const todo = t as { content?: unknown; status?: unknown }
          const content = asString(todo.content)
          if (!content) return undefined
          return `- [${todoMark(todo.status)}] ${content}`
        })
        .filter((x): x is string => !!x)
      if (lines.length) return lines.join('\n')
    }
  }
  return undefined
}

/** Decision-bearing assistant lines; falls back to the last assistant prose. */
function decisions(events: TranscriptEvent[]): string[] {
  const assistantTexts = events
    .filter(e => e.role === 'assistant' && e.text)
    .map(e => e.text!.trim())
  const flagged: string[] = []
  for (const text of assistantTexts) {
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (l.length >= 20 && DECISION_CUES.test(l)) flagged.push(l.replace(/^[-*\d.\s]+/, ''))
    }
  }
  if (flagged.length) return dedupe(flagged).slice(-8)
  // No explicit cues — carry the most recent substantial assistant paragraph.
  const last = assistantTexts.filter(t => t.length >= 40).slice(-1)[0]
  return last ? [cap(last, 400)] : []
}

/** File paths touched, in first-seen order. */
function filesTouched(events: TranscriptEvent[]): string[] {
  const seen: string[] = []
  for (const e of events) {
    if (e.role !== 'tool' || !e.tool) continue
    if (!FILE_TOOLS.has(e.tool.name)) continue
    const input = e.tool.input as { file_path?: unknown; path?: unknown; notebook_path?: unknown } | undefined
    const path = asString(input?.file_path) ?? asString(input?.path) ?? asString(input?.notebook_path)
    if (path && !seen.includes(path)) seen.push(path)
  }
  return seen
}

/** Pitfall/dead-end lines from assistant prose. */
function pitfalls(events: TranscriptEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.role !== 'assistant' || !e.text) continue
    for (const line of e.text.split('\n')) {
      const l = line.trim()
      if (l.length >= 20 && PITFALL_CUES.test(l)) out.push(l.replace(/^[-*\d.\s]+/, ''))
    }
  }
  return dedupe(out).slice(-6)
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}

function bullets(xs: string[]): string {
  return xs.map(x => `- ${x}`).join('\n')
}

/**
 * Distill a normalized transcript into a context brief + tags. Empty sections
 * are omitted; if nothing structured is found, the most recent prose is used so
 * the brief is never empty for a non-trivial session.
 */
export function distill(transcript: NormalizedTranscript): DistilledBrief {
  const { events } = transcript
  const sections: string[] = []
  const tags: string[] = ['session-import', transcript.runtime]

  const plan = latestPlan(events)
  if (plan) {
    sections.push(`## Plan\n${cap(plan, SECTION_CAP)}`)
    tags.push('plan')
  }

  const todos = latestTodos(events)
  if (todos) {
    sections.push(`## Todos\n${cap(todos, SECTION_CAP)}`)
    tags.push('todos')
  }

  const decs = decisions(events)
  if (decs.length) {
    sections.push(`## Key decisions\n${cap(bullets(decs), SECTION_CAP)}`)
    tags.push('decisions')
  }

  const files = filesTouched(events)
  if (files.length) {
    sections.push(`## Files touched\n${cap(bullets(files.slice(0, 20)), SECTION_CAP)}`)
  }

  const pit = pitfalls(events)
  if (pit.length) {
    sections.push(`## Pitfalls / dead-ends\n${cap(bullets(pit), SECTION_CAP)}`)
    tags.push('pitfalls')
  }

  const brief = sections.length
    ? cap(sections.join('\n\n'), TOTAL_CAP)
    : 'No structured plan/decisions found in this session.'

  return { brief, tags: dedupe(tags) }
}
