/**
 * ingest-attachment — turn a human's inbound file attachment into a safe,
 * materialized workspace file plus a `file.received` ledger event, so the agent
 * can read it with its own tools (Claude reads PDFs/images natively).
 *
 * Fires on an admitted `channel.message` whose (URL-free) intent args list
 * attachments. The real attachment handles — including the signed/expiring CDN
 * URL — live in the host's in-process side table and are pulled via the injected
 * `loadAttachments` dep, never from the ledger (KTD2): the URL would expire and
 * leak its signature if persisted. On a peer relay that didn't receive the
 * message `loadAttachments` is empty, so only the receiving machine ingests.
 *
 * Per attachment the pipeline is: budget (declared, then actual size) → download
 * → magic-byte sniff (never the declared MIME) → v1-type allowlist → secret
 * content scan → traversal-safe name → materialize inside the workspace
 * (containment) → admit `file.received`. Any rejection posts a short note and
 * skips that file; nothing partial is recorded. All policy decisions are the
 * pure helpers in lib.ts, so the orchestration is testable with stub deps.
 *
 * v1 scope: text/code/image/gif/pdf (audio/video deferred — see plan). Capture
 * is reliable for the Discord surface; other platforms opt in via their
 * `Capabilities.files` + `downloadAttachment`.
 */

import { createHash } from 'node:crypto'
import type { Synchronization } from '../sync.ts'
import { discordArtifact } from '../interaction.ts'
import {
  sniffFileKind,
  isSupportedForV1,
  sanitizeAttachmentName,
  withinBudget,
  looksLikeSecret,
  FILE_INGEST_LIMITS,
} from '../../lib.ts'

/** The minimal attachment shape the sync needs — a structural subset of the
 *  messaging seam's IncomingAttachment, kept local so the ledger core doesn't
 *  depend on the messaging layer. */
export type IngestAttachment = {
  name: string
  url: string
  contentType?: string
  sizeBytes?: number
  ref?: string
}

export type IngestAttachmentDeps = {
  /** Inbound file support + per-file byte cap for `scope`, or undefined when the
   *  scope is unserved here or the platform delivers no files (→ skip). */
  filesInbound: (scope: string) => { maxBytes: number } | undefined
  /** Full inbound attachments for this channel.message hash (host side table). */
  loadAttachments: (scope: string, messageHash: string) => IngestAttachment[]
  /** Fetch the bytes at ingest time. Undefined on failure. */
  download: (scope: string, att: IngestAttachment) => Promise<Uint8Array | undefined>
  /** Write bytes into the workspace under `safeName`; return the workspace-
   *  relative path, or undefined when unserved / the path escapes the workspace. */
  materialize: (scope: string, safeName: string, bytes: Uint8Array) => Promise<string | undefined>
  /** Post a short rejection/fetch-failure note back to the scope. Best-effort. */
  note?: (scope: string, text: string) => void
}

/** Decode the head of a buffer as UTF-8 for the secret content scan. */
function decodeHead(bytes: Uint8Array, max = 8192): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, max))
}

export function ingestAttachment(deps: IngestAttachmentDeps): Synchronization {
  const limits = {
    maxFilesPerMessage: FILE_INGEST_LIMITS.maxFilesPerMessage,
    maxTotalBytes: FILE_INGEST_LIMITS.maxTotalBytes,
  }
  return {
    name: 'ingest-attachment',
    matches: i => {
      if (i.verb !== 'channel.message') return false
      if (i.lifecycle !== 'admitted' && i.lifecycle !== 'applied') return false
      if (i.patch.kind !== 'external') return false
      const atts = (i.patch.intent.args as { attachments?: unknown[] } | undefined)?.attachments
      return Array.isArray(atts) && atts.length > 0
    },
    fire: async (i, ctx) => {
      const cap = deps.filesInbound(i.channel)
      if (!cap) return // platform delivers no files, or scope not served here
      const list = deps.loadAttachments(i.channel, i.hash)
      if (list.length === 0) return // peer relay (no side table) — only the receiver ingests
      const perFile = { ...limits, maxBytesPerFile: cap.maxBytes }
      const platform = i.patch.kind === 'external' ? i.patch.intent.channel : 'unknown'

      let runningTotal = 0
      for (let idx = 0; idx < list.length; idx++) {
        const att = list[idx]!
        const label = att.name || `attachment ${idx + 1}`

        // Early budget by the declared size — reject before spending a download.
        const declared = withinBudget(
          { sizeBytes: att.sizeBytes ?? 0, indexInMessage: idx, runningTotalBytes: runningTotal },
          perFile,
        )
        if (!declared.ok) {
          deps.note?.(i.channel, rejectNote(label, declared.reason))
          continue
        }

        const bytes = await deps.download(i.channel, att)
        if (!bytes || bytes.length === 0) {
          deps.note?.(i.channel, `couldn't fetch "${label}" — skipped`)
          continue
        }

        // Re-check budget against the actual byte length.
        const actual = withinBudget(
          { sizeBytes: bytes.length, indexInMessage: idx, runningTotalBytes: runningTotal },
          perFile,
        )
        if (!actual.ok) {
          deps.note?.(i.channel, rejectNote(label, actual.reason))
          continue
        }

        const kind = sniffFileKind(bytes)
        if (!isSupportedForV1(kind)) {
          deps.note?.(i.channel, `"${label}" is an unsupported file type — not ingested (v1: text/code/image/gif/pdf)`)
          continue
        }

        // Secret scan: path (declared name) + decoded content head. Catches a
        // credential file renamed to look innocuous.
        if (looksLikeSecret(att.name, decodeHead(bytes))) {
          deps.note?.(i.channel, `"${label}" looks like it contains credentials — refused for safety`)
          continue
        }

        const hash = createHash('sha256').update(bytes).digest('hex')
        const safeName = sanitizeAttachmentName(att.name, kind, hash)
        const relpath = await deps.materialize(i.channel, safeName, bytes)
        if (!relpath) {
          deps.note?.(i.channel, `couldn't store "${label}" in the workspace — skipped`)
          continue
        }

        runningTotal += bytes.length
        await ctx.admit({
          actor: i.actor,
          role: i.role,
          channel: i.channel,
          target: { artifactId: discordArtifact(i.channel), anchor: { kind: 'none' } },
          verb: 'file.received',
          patch: {
            kind: 'external',
            intent: {
              channel: platform,
              op: 'ingested',
              args: { relpath, kind, hash, originalName: att.name, sizeBytes: bytes.length },
            },
          },
          effect: 'external',
          caused_by: [i.hash],
        })
      }
    },
  }
}

function rejectNote(label: string, reason?: string): string {
  switch (reason) {
    case 'too-large':
      return `"${label}" is too large to ingest — skipped`
    case 'too-many':
      return `too many attachments on one message — "${label}" skipped`
    case 'over-total':
      return `attachment budget exceeded — "${label}" skipped`
    default:
      return `"${label}" could not be ingested — skipped`
  }
}
