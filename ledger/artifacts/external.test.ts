/**
 * External-proxy Claim primitive: acquire, renew, conflict, expire, release.
 *
 * The Claim is the floor that serializes side effects. The merge gate
 * bypasses role-ordered merge for external effects precisely because this
 * primitive provides serialization — without it the bypass would be unsafe.
 */

import { test, expect } from 'bun:test'
import { SqliteStore } from '../store-sqlite.ts'
import { withClaim } from './external.ts'

test('claim: acquire returns acquired=true when no current holder', async () => {
  const store = new SqliteStore(':memory:')
  const r = await store.acquireClaim('extp:discord/m-1', 'hash-A', 5000)
  expect(r.acquired).toBe(true)
  store.close()
})

test('claim: a second different holder cannot acquire while live', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/m-1', 'hash-A', 5000)
  const r = await store.acquireClaim('extp:discord/m-1', 'hash-B', 5000)
  expect(r.acquired).toBe(false)
  expect(r.currentHolder).toBe('hash-A')
  store.close()
})

test('claim: the same holder renews (TTL refreshed)', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/m-1', 'hash-A', 5000)
  const r = await store.acquireClaim('extp:discord/m-1', 'hash-A', 5000)
  expect(r.acquired).toBe(true)
  store.close()
})

test('claim: an expired claim is replaceable by a different holder', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/m-1', 'hash-A', 1) // 1ms TTL
  await new Promise(r => setTimeout(r, 10))
  const r = await store.acquireClaim('extp:discord/m-1', 'hash-B', 5000)
  expect(r.acquired).toBe(true)
  const claim = await store.getClaim('extp:discord/m-1')
  expect(claim?.holder).toBe('hash-B')
  store.close()
})

test('claim: getClaim returns undefined when the claim has expired', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/m-1', 'hash-A', 1)
  await new Promise(r => setTimeout(r, 10))
  const claim = await store.getClaim('extp:discord/m-1')
  expect(claim).toBeUndefined()
  store.close()
})

test('claim: release only succeeds for the current holder', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/m-1', 'hash-A', 5000)
  const wrong = await store.releaseClaim('extp:discord/m-1', 'hash-B')
  expect(wrong.released).toBe(false)
  const right = await store.releaseClaim('extp:discord/m-1', 'hash-A')
  expect(right.released).toBe(true)
  expect(await store.getClaim('extp:discord/m-1')).toBeUndefined()
  store.close()
})

test('withClaim: runs the fn under the lock and releases on success', async () => {
  const store = new SqliteStore(':memory:')
  let ran = false
  const r = await withClaim(store, 'extp:discord/x', 'hA', async () => {
    ran = true
    // Mid-fn the claim is held.
    const claim = await store.getClaim('extp:discord/x')
    expect(claim?.holder).toBe('hA')
    return 'ok'
  })
  expect(r.acquired).toBe(true)
  if (r.acquired) expect(r.result).toBe('ok')
  expect(ran).toBe(true)
  // After return, the claim is released.
  expect(await store.getClaim('extp:discord/x')).toBeUndefined()
  store.close()
})

test('withClaim: releases the claim even when the fn throws', async () => {
  const store = new SqliteStore(':memory:')
  await expect(
    withClaim(store, 'extp:discord/x', 'hA', async () => {
      throw new Error('side effect failed')
    }),
  ).rejects.toThrow('side effect failed')
  expect(await store.getClaim('extp:discord/x')).toBeUndefined()
  store.close()
})

test('withClaim: returns acquired=false without calling fn when locked', async () => {
  const store = new SqliteStore(':memory:')
  await store.acquireClaim('extp:discord/x', 'hOther', 5000)
  let ran = false
  const r = await withClaim(store, 'extp:discord/x', 'hMine', async () => {
    ran = true
    return 'should not run'
  })
  expect(r.acquired).toBe(false)
  expect(ran).toBe(false)
  if (!r.acquired) expect(r.currentHolder).toBe('hOther')
  store.close()
})
