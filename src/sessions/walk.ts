/**
 * Shared recursive directory walk for the session readers.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Recursively collect files ending in `ext` under `root` (depth ≤ 5).
 *  An unreadable directory degrades to fewer results, never throws. */
export async function walkFiles(root: string, ext: string, depth = 0): Promise<string[]> {
  if (depth > 5) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const path = join(root, e.name)
    if (e.isDirectory()) out.push(...(await walkFiles(path, ext, depth + 1)))
    else if (e.isFile() && e.name.endsWith(ext)) out.push(path)
  }
  return out
}
