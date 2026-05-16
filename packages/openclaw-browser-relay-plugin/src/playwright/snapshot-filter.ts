/**
 * Snapshot filter — keyword/role-based filtering for ARIA snapshots.
 *
 * Given a parsed snapshot (with lineMeta), filters elements by keywords and/or roles,
 * preserving ancestor context lines and sibling context.
 */

import type { RoleSnapshotLineMeta } from './role-refs.js'

export type SnapshotFilterOptions = {
  keywords?: string[]
  roles?: string[]
  contextLines?: number
  maxMatches?: number
}

export type FilterResult = {
  prunedSnapshot: string
  matchedCount: number
  returnedCount: number
  truncated: boolean
  sparse: boolean
  refRange?: { min: string; max: string }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = value ?? fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Walk upward from `index` to include ancestor lines (lower indent). */
function includeAncestors(lineMeta: RoleSnapshotLineMeta[], index: number, included: Set<number>): void {
  let currentIndent = lineMeta[index].indent
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = lineMeta[i]
    if (entry.indent < currentIndent) {
      included.add(i)
      currentIndent = entry.indent
      if (currentIndent === 0) break
    }
  }
}

/** Walk upward to include named structural containers (group/generic with name). */
function includeStructuralContext(lineMeta: RoleSnapshotLineMeta[], index: number, included: Set<number>): void {
  const entry = lineMeta[index]
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = lineMeta[i]
    if (candidate.indent >= entry.indent) continue
    if (candidate.role && candidate.name) {
      included.add(i)
    }
    if (candidate.indent === 0) break
  }
}

/** Include sibling lines (same indent, same parent) around the matched index. */
function includeSiblings(lineMeta: RoleSnapshotLineMeta[], index: number, count: number, included: Set<number>): void {
  if (count <= 0) return
  const entry = lineMeta[index]
  let added = 0
  for (let i = index - 1; i >= 0 && added < count; i -= 1) {
    if (lineMeta[i].indent < entry.indent) break
    if (lineMeta[i].indent === entry.indent) {
      included.add(i)
      added += 1
    }
  }
  added = 0
  for (let i = index + 1; i < lineMeta.length && added < count; i += 1) {
    if (lineMeta[i].indent < entry.indent) break
    if (lineMeta[i].indent === entry.indent) {
      included.add(i)
      added += 1
    }
  }
}

/** Compute ref range (min/max ref numbers) from included lines. */
function computeRefRange(lineMeta: RoleSnapshotLineMeta[], included: Set<number>): { min: string; max: string } | undefined {
  let min = Infinity
  let max = -Infinity
  for (const i of included) {
    const ref = lineMeta[i].ref
    if (!ref) continue
    const n = parseInt(ref.slice(1), 10)
    if (Number.isFinite(n)) {
      if (n < min) min = n
      if (n > max) max = n
    }
  }
  if (min !== Infinity && max !== -Infinity) {
    return { min: `e${min}`, max: `e${max}` }
  }
  return undefined
}

/**
 * Filter a snapshot's lineMeta by keywords and/or roles.
 * Returns null if no elements match (caller should fall back to full snapshot).
 */
export function filterSnapshot(lineMeta: RoleSnapshotLineMeta[], options: SnapshotFilterOptions): FilterResult | null {
  const hasKeywords = Array.isArray(options.keywords) && options.keywords.length > 0
  const hasRoles = Array.isArray(options.roles) && options.roles.length > 0

  if (!hasKeywords && !hasRoles) {
    // No filter — return everything
    const refCount = lineMeta.filter((l) => l.ref).length
    return {
      prunedSnapshot: lineMeta.map((l) => l.text).join('\n') || '(empty)',
      matchedCount: refCount,
      returnedCount: refCount,
      truncated: false,
      sparse: false,
      refRange: computeRefRange(lineMeta, new Set(lineMeta.map((_, i) => i))),
    }
  }

  const normalizedKeywords = hasKeywords ? options.keywords!.map((k) => k.toLowerCase()).filter(Boolean) : []
  const roleSet = hasRoles ? new Set(options.roles!.map((r) => r.toLowerCase())) : null
  const contextLines = clamp(options.contextLines, 0, 5, 2)
  const maxMatches = clamp(options.maxMatches, 1, 100, 20)

  // Find matching line indices
  const matchedIndices: number[] = []
  for (let i = 0; i < lineMeta.length; i += 1) {
    const entry = lineMeta[i]
    if (!entry.ref) continue
    if (roleSet && !(entry.role && roleSet.has(entry.role))) continue
    if (normalizedKeywords.length > 0) {
      const name = (entry.name ?? '').toLowerCase()
      if (!name) continue
      let found = false
      for (const kw of normalizedKeywords) {
        if (name.includes(kw)) { found = true; break }
      }
      if (!found) continue
    }
    matchedIndices.push(i)
  }

  if (matchedIndices.length === 0) return null

  const truncated = matchedIndices.length > maxMatches
  const effectiveMatches = truncated ? matchedIndices.slice(0, maxMatches) : matchedIndices

  // Build included set
  const included = new Set<number>()
  for (const idx of effectiveMatches) {
    included.add(idx)
    includeAncestors(lineMeta, idx, included)
    includeStructuralContext(lineMeta, idx, included)
    includeSiblings(lineMeta, idx, contextLines, included)
  }

  // Build output
  const sortedIndices = Array.from(included).sort((a, b) => a - b)
  const outputLines: string[] = []
  for (const i of sortedIndices) {
    outputLines.push(lineMeta[i].text)
  }

  let returnedCount = 0
  for (const i of sortedIndices) {
    if (lineMeta[i].ref) returnedCount += 1
  }

  const totalRefs = lineMeta.filter((l) => l.ref).length
  const sparse = returnedCount < totalRefs

  return {
    prunedSnapshot: outputLines.length > 0 ? outputLines.join('\n') : '(empty)',
    matchedCount: effectiveMatches.length,
    returnedCount,
    truncated,
    sparse,
    refRange: computeRefRange(lineMeta, included),
  }
}
