/**
 * Questions routing: AskUserQuestion options post as owner-gated choice cards, the
 * approver's pick resolves to the chosen label (keyed by question text), a non-approver
 * is warned and the question stays pending, and an unanswered question times out.
 */

import { test, expect } from 'bun:test'
import { Questions } from '../../src/host/questions.ts'
import type { MessagingAdapter, IncomingAction, Choice } from '../../src/messaging-adapter.ts'
import type { AgentConfig } from '../../src/lib.ts'

const agent = { ownerUserId: 'U_owner', rooms: {} } as unknown as AgentConfig

const INPUT = {
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'SQLite', description: 'embedded' },
      ],
      multiSelect: false,
    },
  ],
}

function harness() {
  const sends: { scope: string; text: string; opts?: { choices?: Choice[]; mentionUser?: string; mentionOnly?: string } }[] = []
  let n = 0
  const messaging = {
    send: async (scope: string, text: string, opts?: unknown) => {
      sends.push({ scope, text, opts: opts as never })
      return { id: `msg${n++}`, scope }
    },
    edit: async () => true,
  } as unknown as MessagingAdapter
  const questions = new Questions(messaging, () => agent)
  return { questions, sends }
}

function action(actionId: string, userId: string): IncomingAction {
  return {
    actionId,
    userId,
    ref: { id: 'msg0', scope: 'C1' },
    scope: 'C1',
    message: '',
    respond: async () => {},
    update: async () => {},
  }
}

test('ask: posts options as choices pinging the approver; owner pick yields the answer', async () => {
  const h = harness()
  const asking = h.questions.ask('C1', INPUT, 5000)

  await Promise.resolve() // let the async send + pending registration settle
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]!.scope).toBe('C1')
  expect(h.sends[0]!.opts).toMatchObject({ mentionUser: 'U_owner', mentionOnly: 'U_owner' })
  const choices = h.sends[0]!.opts!.choices!
  expect(choices.map(c => c.label)).toEqual(['Postgres', 'SQLite'])

  // Owner taps "SQLite" (the second option).
  await h.questions.resolve(action(choices[1]!.id, 'U_owner'))

  const answers = await asking
  expect(answers).toEqual({ 'Which database should we use?': 'SQLite' })
})

test('resolve: a non-approver is warned and the question stays pending', async () => {
  const h = harness()
  let answered = false
  const asking = h.questions.ask('C1', INPUT, 5000).then(a => {
    answered = true
    return a
  })
  await Promise.resolve()
  const choices = h.sends[0]!.opts!.choices!

  let responded = ''
  const a = action(choices[0]!.id, 'U_intruder')
  a.respond = async t => {
    responded = t
  }
  await h.questions.resolve(a)
  expect(responded).toContain('owner')
  await Promise.resolve()
  expect(answered).toBe(false) // still pending — no pick recorded

  // Owner can still answer afterwards.
  await h.questions.resolve(action(choices[0]!.id, 'U_owner'))
  expect(await asking).toEqual({ 'Which database should we use?': 'Postgres' })
})

test('ask: an unanswered question times out to undefined (turn ends, no hang)', async () => {
  const h = harness()
  const answers = await h.questions.ask('C1', INPUT, 20)
  expect(answers).toBeUndefined()
})
