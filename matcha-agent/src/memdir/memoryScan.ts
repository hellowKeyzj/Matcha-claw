/**
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import { join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readSourceDirectory } from '../utils/fsOperations.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import {
  currentInvestigationScope,
  requireInvestigationEffects,
  rethrowInvestigationAdmission,
} from '../world/investigation.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * Single-pass: readFileInRange stats internally and returns mtimeMs, so we
 * read-then-sort rather than stat-sort-read. For the common case (N ≤ 200)
 * this halves syscalls vs a separate stat round; for large N we read a few
 * extra small files but still avoid the double-stat on the surviving 200.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const mdFiles: string[] = []
    const directories = ['']
    for (const relativeDir of directories) {
      if (currentInvestigationScope()) signal.throwIfAborted()
      requireInvestigationEffects([])
      const entries = await readSourceDirectory(join(memoryDir, relativeDir), signal)
      for (const entry of entries) {
        const relativePath = join(relativeDir, entry.name)
        if (entry.isDirectory()) {
          directories.push(relativePath)
        }
        if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
          mdFiles.push(relativePath)
        }
      }
    }

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    if (currentInvestigationScope()) signal.throwIfAborted()
    requireInvestigationEffects([])
    for (const result of headerResults) {
      if (result.status === 'rejected') {
        rethrowInvestigationAdmission(result.reason)
        if (currentInvestigationScope() && result.reason instanceof Error && result.reason.cause !== undefined) {
          throw result.reason
        }
      }
    }

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch (error) {
    rethrowInvestigationAdmission(error)
    if (currentInvestigationScope()) {
      if (error instanceof Error && error.cause !== undefined) throw error
      signal.throwIfAborted()
    }
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
