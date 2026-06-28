/**
 * Approvals routing: the Allow/Deny prompt posts in the task channel (never the owner's
 * DM), pinging only the approver, and only the approver can resolve it.
 */

import { test, expect } from 'bun:test'
import { Approvals } from '../src/approvals.ts'
import type { MessagingAdapter, IncomingAction } from '../src/messaging-adapter.ts'
import type { AgentConfig } from '../src/lib.ts'
import type { Store } from '../src/ledger/store.ts'

const HASH = 'a'.repeat(64)
const agent = { ownerUserId: 'U_owner', rooms: {} } as unknown as AgentConfig

function harness() {
  const sends: { scope: string; text: string; opts?: unknown }[] = []
  let dmCalls = 0
  const messaging = {
    dm: async () => {
      dmCalls++
      return undefined
    },
    send: async (scope: string, text: string, opts?: unknown) => {
      sends.push({ scope, text, opts })
      return { id: 'msg1', scope }
    },
  } as unknown as MessagingAdapter
  const approvals = new Approvals(messaging, () => agent, {} as Store)
  return { approvals, sends, dmCalls: () => dmCalls }
}

test('postDiscord: posts in the channel with mentionOnly the approver, never DMs', async () => {
  const h = harness()
  await h.approvals.postDiscord({ channelId: 'C1', toolRequestedHash: HASH, toolName: 'Bash', input: { cmd: 'ls' } })
  expect(h.dmCalls()).toBe(0)
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]!.scope).toBe('C1')
  expect(h.sends[0]!.opts).toMatchObject({ mentionOnly: 'U_owner' })
})

test('resolve: a non-approver is rejected and no verdict is emitted', async () => {
  const h = harness()
  await h.approvals.postDiscord({ channelId: 'C1', toolRequestedHash: HASH, toolName: 'Bash', input: {} })

  let responded: string | undefined
  const action: IncomingAction = {
    actionId: `appr:allow:${HASH.slice(0, 10)}`,
    userId: 'U_someone_else',
    ref: { id: 'msg1', scope: 'C1' },
    scope: 'C1',
    message: '',
    respond: async text => {
      responded = text
    },
    update: async () => {},
  }
  await h.approvals.resolve(action)
  expect(responded).toBe('Not authorized.')
})
