/**
 * OpenCode session reader. Layout under `<data>/storage` (`OPENCODE_DATA_DIR`
 * or `~/.local/share/opencode`): session/, message/, part/ — schemas vary, so
 * probe inline + split part files and tolerate misses.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type NormalizedTranscript,
  type SessionStore,
  type SessionSummary,
  type TranscriptEvent,
  countMessages,
  cwdMatchesWorkspace,
  deriveTitle,
} from './session-store.ts'
import { walkFiles } from './walk.ts'

function storageDir(): string {
  const data = process.env.OPENCODE_DATA_DIR ?? join(homedir(), '.local', 'share', 'opencode')
  return join(data, 'storage')
}

/** Normalize a time value (epoch ms number, or ISO string) to ISO. */
function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v === 'string' && v) return v
  return undefined
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function metaCwd(meta: Record<string, unknown>): string {
  for (const k of ['directory', 'cwd', 'path', 'worktree']) {
    const v = meta[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function metaUpdatedAt(meta: Record<string, unknown>): string | undefined {
  const time = meta.time as Record<string, unknown> | undefined
  return toIso(time?.updated) ?? toIso(time?.created) ?? toIso(meta.updated) ?? toIso(meta.created)
}

/** Turn a message's parts (inline or from part files) into events. */
function partsToEvents(role: 'user' | 'assistant', parts: unknown[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string' && p.text) {
      events.push({ role, text: p.text })
    } else if (p.type === 'tool') {
      const name = (p.tool ?? p.name) as string | undefined
      const state = p.state as Record<string, unknown> | undefined
      if (typeof name === 'string') {
        events.push({ role: 'tool', tool: { name, input: state?.input ?? p.input } })
      }
    }
  }
  return events
}

export class OpenCodeSessionStore implements SessionStore {
  readonly runtime = 'opencode' as const

  /** Map sessionID → its meta file path, by walking session/. */
  private async sessionMetaFiles(): Promise<Map<string, string>> {
    const files = await walkFiles(join(storageDir(), 'session'), '.json')
    const map = new Map<string, string>()
    for (const f of files) map.set(f.split('/').pop()!.replace(/\.json$/, ''), f)
    return map
  }

  async list(opts: { workspace: string; limit?: number }): Promise<SessionSummary[]> {
    const metas = await this.sessionMetaFiles()
    const out: SessionSummary[] = []
    for (const [id, path] of metas) {
      const meta = await readJson(path)
      if (!meta) continue
      const cwd = metaCwd(meta)
      // A cwd-less session is skipped — listing it everywhere is a cross-project leak.
      if (!cwd || !cwdMatchesWorkspace(cwd, opts.workspace)) continue
      let messageCount = 0
      try {
        messageCount = (await readdir(join(storageDir(), 'message', id))).filter(f =>
          f.endsWith('.json'),
        ).length
      } catch {
        /* no message dir */
      }
      const st = await stat(path).catch(() => undefined)
      out.push({
        id,
        runtime: this.runtime,
        cwd,
        updatedAt: metaUpdatedAt(meta) ?? st?.mtime.toISOString() ?? new Date(0).toISOString(),
        title: typeof meta.title === 'string' ? meta.title : undefined,
        messageCount,
      })
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
  }

  async read(id: string): Promise<NormalizedTranscript | undefined> {
    const metaPath = (await this.sessionMetaFiles()).get(id)
    const meta = metaPath ? await readJson(metaPath) : undefined

    const msgDir = join(storageDir(), 'message', id)
    let msgFiles: string[]
    try {
      msgFiles = (await readdir(msgDir)).filter(f => f.endsWith('.json')).sort()
    } catch {
      // No message dir: a known session with no turns yet, else truly absent.
      if (!meta) return undefined
      return { id, runtime: this.runtime, cwd: metaCwd(meta), events: [] }
    }

    const events: TranscriptEvent[] = []
    for (const file of msgFiles) {
      const msg = await readJson(join(msgDir, file))
      if (!msg) continue
      const role = msg.role === 'assistant' ? 'assistant' : 'user'
      let parts = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : []
      if (parts.length === 0) {
        const messageId = (msg.id as string | undefined) ?? file.replace(/\.json$/, '')
        for (const base of [join(storageDir(), 'part', id, messageId), join(storageDir(), 'part', messageId)]) {
          const partFiles = await walkFiles(base, '.json')
          for (const pf of partFiles.sort()) {
            const p = await readJson(pf)
            if (p) parts.push(p)
          }
          if (parts.length) break
        }
      }
      events.push(...partsToEvents(role, parts))
    }
    return {
      id,
      runtime: this.runtime,
      cwd: meta ? metaCwd(meta) : '',
      title: (meta?.title as string | undefined) ?? deriveTitle(events),
      events,
    }
  }
}
