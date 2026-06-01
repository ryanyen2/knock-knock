/**
 * importSession — the headless session-import core. The happy path (read +
 * distill + admit a shared-context note) is exercised through the Discord
 * handler and the delivery tests; here we pin the failure contract: an
 * unreadable session admits nothing and reports ok:false, so the caller can
 * surface "couldn't read that session" without a half-written ledger.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../ledger/store-sqlite.ts'
import { importSession } from './import.ts'

test('importSession: an unreadable session is a no-op {ok:false}, nothing admitted', async () => {
  const store = new SqliteStore(':memory:')
  const r = await importSession(store, {
    runtime: 'claude-code',
    sessionId: 'no-such-session-0000000000000000000000',
    scopeId: 'chan-1',
    ownerId: 'owner-1',
  })
  expect(r.ok).toBe(false)
  expect((await store.listByVerb('knowledge.append')).length).toBe(0)
})
