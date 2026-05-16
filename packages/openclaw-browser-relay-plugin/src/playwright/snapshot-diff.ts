/**
 * Snapshot Diff — incremental snapshot support.
 *
 * Provides:
 * 1. Ref stability: reuse ref IDs across snapshots for unchanged elements
 * 2. Diff computation: detect kept/new/removed refs and produce compact diff output
 */

import type { RoleRef, RoleSnapshotLineMeta } from './role-refs.js'

// ── Ref fingerprinting ──

function refFingerprint(ref: RoleRef): string {
  return `${ref.role}\0${ref.name ?? ''}\0${ref.nth ?? 0}`
}

// ── Ref stability ──

export type StabilizedResult = {
  refs: Record<string, RoleRef>
  snapshot: string
  lineMeta: RoleSnapshotLineMeta[]
  keptRefs: string[]
  newRefs: string[]
  nextMaxCounter: number
}

/**
 * Stabilize ref IDs: reuse previous ref IDs for elements that still exist,
 * assign new sequential IDs for new elements.
 */
export function stabilizeRefs(input: {
  currentRefs: Record<string, RoleRef>
  currentSnapshot: string
  currentLineMeta: RoleSnapshotLineMeta[]
  prevRefs?: Record<string, RoleRef>
  prevMaxCounter?: number
}): StabilizedResult {
  const { currentRefs, currentSnapshot, currentLineMeta, prevRefs, prevMaxCounter = 0 } = input

  if (!prevRefs || Object.keys(prevRefs).length === 0) {
    // No previous state — use current refs as-is
    const maxCounter = Math.max(0, ...Object.keys(currentRefs).map((r) => parseInt(r.slice(1), 10) || 0))
    return {
      refs: currentRefs,
      snapshot: currentSnapshot,
      lineMeta: currentLineMeta,
      keptRefs: [],
      newRefs: Object.keys(currentRefs),
      nextMaxCounter: maxCounter,
    }
  }

  // Build fingerprint → old ref mapping
  const prevFpToRef = new Map<string, string>()
  for (const [ref, value] of Object.entries(prevRefs)) {
    prevFpToRef.set(refFingerprint(value), ref)
  }

  // Map current refs to stable IDs
  const usedOldRefs = new Set<string>()
  const remapping = new Map<string, string>() // currentRef → stableRef
  const keptRefs: string[] = []
  const newRefs: string[] = []

  // First pass: match existing refs
  const sortedCurrentRefs = Object.keys(currentRefs).sort(
    (a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0),
  )

  for (const curRef of sortedCurrentRefs) {
    const fp = refFingerprint(currentRefs[curRef])
    const oldRef = prevFpToRef.get(fp)
    if (oldRef && !usedOldRefs.has(oldRef)) {
      remapping.set(curRef, oldRef)
      usedOldRefs.add(oldRef)
      keptRefs.push(oldRef)
    }
  }

  // Second pass: assign new IDs for unmatched refs
  let counter = prevMaxCounter
  for (const curRef of sortedCurrentRefs) {
    if (remapping.has(curRef)) continue
    // Generate a new ref that doesn't collide with used old refs
    let newRef: string
    do {
      counter += 1
      newRef = `e${counter}`
    } while (usedOldRefs.has(newRef))
    usedOldRefs.add(newRef)
    remapping.set(curRef, newRef)
    newRefs.push(newRef)
  }

  // Build stabilized refs
  const stableRefs: Record<string, RoleRef> = {}
  for (const curRef of sortedCurrentRefs) {
    stableRefs[remapping.get(curRef)!] = currentRefs[curRef]
  }

  // Rewrite snapshot text and lineMeta
  const refPattern = /\[ref=(e\d+)\]/g
  const rewriteText = (text: string): string =>
    text.replace(refPattern, (_, ref) => `[ref=${remapping.get(ref) ?? ref}]`)

  const stableSnapshot = rewriteText(currentSnapshot)
  const stableLineMeta = currentLineMeta.map((entry) => ({
    ...entry,
    text: rewriteText(entry.text),
    ref: entry.ref ? (remapping.get(entry.ref) ?? entry.ref) : entry.ref,
  }))

  return {
    refs: stableRefs,
    snapshot: stableSnapshot,
    lineMeta: stableLineMeta,
    keptRefs,
    newRefs,
    nextMaxCounter: counter,
  }
}

// ── Diff computation ──

export type DiffResult = {
  kind: 'DIFF'
  keptRefs: string[]
  newRefs: string[]
  removedRefs: string[]
  diffText: string
}

export type DiffBailResult = {
  kind: 'BAIL_FULL'
  reason: string
}

/**
 * Compute a diff between previous and current ref sets.
 * Returns a compact diff representation or bails to full snapshot.
 */
export function computeRefDiff(input: {
  prevRefs: Record<string, RoleRef>
  currentRefs: Record<string, RoleRef>
  currentLineMeta: RoleSnapshotLineMeta[]
  currentSnapshot: string
  maxNewRatio?: number
  maxChangeRatio?: number
  notWorthItRatio?: number
}): DiffResult | DiffBailResult {
  const {
    prevRefs,
    currentRefs,
    currentLineMeta,
    currentSnapshot,
    maxNewRatio = 0.5,
    maxChangeRatio = 0.6,
    notWorthItRatio = 0.85,
  } = input

  const prevKeys = Object.keys(prevRefs)
  const curKeys = Object.keys(currentRefs)

  if (prevKeys.length === 0) {
    return { kind: 'BAIL_FULL', reason: 'no_prev' }
  }
  if (curKeys.length === 0) {
    return { kind: 'BAIL_FULL', reason: 'empty_cur_tree' }
  }

  // Compute kept/new/removed
  const prevSet = new Set(prevKeys)
  const curSet = new Set(curKeys)

  const keptRefs = curKeys.filter((r) => prevSet.has(r)).sort(refSort)
  const newRefs = curKeys.filter((r) => !prevSet.has(r)).sort(refSort)
  const removedRefs = prevKeys.filter((r) => !curSet.has(r)).sort(refSort)

  const totalCurRefs = curKeys.length

  // Bail conditions
  if (totalCurRefs > 0 && newRefs.length / totalCurRefs > maxNewRatio) {
    return { kind: 'BAIL_FULL', reason: 'too_many_new_refs' }
  }
  const totalChanges = keptRefs.length + newRefs.length + removedRefs.length
  if (totalChanges > 0 && (newRefs.length + removedRefs.length) / totalChanges > maxChangeRatio) {
    return { kind: 'BAIL_FULL', reason: 'too_many_changes' }
  }

  // Build new_subtree: lines containing new refs + their ancestors
  const newRefSet = new Set(newRefs)
  const newSubtreeLines: string[] = []
  if (newRefs.length > 0) {
    const ancestorStack: Array<{ indent: number; text: string; emitted: boolean }> = []
    for (const entry of currentLineMeta) {
      // Pop ancestors that are at same or deeper indent
      while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].indent >= entry.indent) {
        ancestorStack.pop()
      }
      if (entry.ref && newRefSet.has(entry.ref)) {
        // Emit un-emitted ancestors
        for (const ancestor of ancestorStack) {
          if (!ancestor.emitted) {
            newSubtreeLines.push(ancestor.text)
            ancestor.emitted = true
          }
        }
        newSubtreeLines.push(entry.text)
      }
      ancestorStack.push({ indent: entry.indent, text: entry.text, emitted: !!(entry.ref && newRefSet.has(entry.ref)) })
    }
  }

  // Build diff text
  const diffLines: string[] = []
  diffLines.push('DIFF v1 (incremental snapshot — see kept_refs/new_refs/removed_refs)')
  diffLines.push(`kept_refs (${keptRefs.length}): ${formatRefRange(keptRefs)}`)
  if (removedRefs.length > 0) {
    diffLines.push(`removed_refs (${removedRefs.length}): ${formatRefRange(removedRefs)}`)
  }
  if (newRefs.length > 0) {
    diffLines.push(`new_refs (${newRefs.length}): ${formatRefRange(newRefs)}`)
    diffLines.push('new_subtree:')
    diffLines.push(newSubtreeLines.join('\n'))
  }

  const diffText = diffLines.join('\n')

  // Not-worth-it check: if diff is almost as large as full, bail
  if (diffText.length >= currentSnapshot.length * notWorthItRatio) {
    return { kind: 'BAIL_FULL', reason: 'not_worth_it' }
  }

  return { kind: 'DIFF', keptRefs, newRefs, removedRefs, diffText }
}

// ── Helpers ──

function refSort(a: string, b: string): number {
  return (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0)
}

function formatRefRange(refs: string[]): string {
  if (refs.length === 0) return '-'
  const nums = refs
    .map((r) => { const m = /^e(\d+)$/.exec(r); return m ? parseInt(m[1], 10) : null })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)

  if (nums.length === 0) return refs.join(', ')

  const ranges: string[] = []
  let start = nums[0]
  let end = nums[0]
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] === end + 1) {
      end = nums[i]
    } else {
      ranges.push(start === end ? `e${start}` : `e${start}-e${end}`)
      start = nums[i]
      end = nums[i]
    }
  }
  ranges.push(start === end ? `e${start}` : `e${start}-e${end}`)
  return ranges.join(', ')
}
