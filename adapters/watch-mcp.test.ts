/**
 * watch MCP tool: the pure flat-args → WatchArmPartial translation, plus a
 * smoke test that the SDK server builds. The arming itself is exercised through
 * the host (armWatch) and the supervisor; here we only pin the tool surface.
 */

import { test, expect } from 'bun:test'
import {
  armArgsToPartial,
  makeWatchMcpServer,
  WATCH_TOOL_NAMES,
} from './watch-mcp.ts'

test('armArgsToPartial: each-line / change pass through fireOn', () => {
  expect(armArgsToPartial({ name: 'w', command: 'c', fire_on: 'each-line' }).spec).toMatchObject({
    name: 'w',
    command: 'c',
    fireOn: { kind: 'each-line' },
  })
  expect(armArgsToPartial({ name: 'w', command: 'c', fire_on: 'change' }).spec?.fireOn).toEqual({
    kind: 'change',
  })
})

test('armArgsToPartial: match requires a pattern', () => {
  expect(armArgsToPartial({ name: 'w', command: 'c', fire_on: 'match' }).error).toMatch(/pattern/)
  expect(
    armArgsToPartial({ name: 'w', command: 'c', fire_on: 'match', pattern: 'done' }).spec?.fireOn,
  ).toEqual({ kind: 'match', pattern: 'done' })
})

test('armArgsToPartial: exit implies oneShot; flags map to spec', () => {
  const r = armArgsToPartial({
    name: 'job',
    command: './train.sh',
    fire_on: 'exit',
    ttl_seconds: 90,
    max_fires: 2,
    prompt_template: '[{name}] {line}',
  })
  expect(r.spec).toMatchObject({
    fireOn: { kind: 'exit' },
    oneShot: true,
    ttlMs: 90_000,
    maxFires: 2,
    promptTemplate: '[{name}] {line}',
  })
})

test('armArgsToPartial: once flag sets oneShot for non-exit modes', () => {
  expect(armArgsToPartial({ name: 'w', command: 'c', fire_on: 'change', once: true }).spec?.oneShot).toBe(
    true,
  )
})

test('makeWatchMcpServer: builds an SDK server instance; tool names are stable', () => {
  let armed: unknown
  const server = makeWatchMcpServer({
    arm: async spec => {
      armed = spec
      return { ok: true, message: 'ok' }
    },
    disarm: async () => ({ ok: true, message: 'ok' }),
    list: async () => 'none',
  })
  expect(server.type).toBe('sdk')
  expect(server.instance).toBeDefined()
  expect(WATCH_TOOL_NAMES).toEqual([
    'mcp__knock-knock__watch',
    'mcp__knock-knock__unwatch',
    'mcp__knock-knock__watch_list',
  ])
  expect(armed).toBeUndefined() // not invoked just by constructing
})
