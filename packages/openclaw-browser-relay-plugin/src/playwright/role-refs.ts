const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
])

const NAMED_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'article',
  'region',
  'main',
  'navigation',
])

const COMPACT_SKIP_ROLES = new Set([
  'generic',
  'group',
  'list',
  'table',
  'row',
  'rowgroup',
  'grid',
  'treegrid',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tree',
  'directory',
  'document',
  'application',
  'presentation',
  'none',
])

export type RoleRef = {
  role: string
  name?: string
  nth?: number
}

export type RoleSnapshotOptions = {
  interactive?: boolean
  compact?: boolean
  maxDepth?: number
}

type DuplicateTracker = {
  counts: Map<string, number>
  refsByKey: Map<string, string[]>
  getKey: (role: string, name?: string) => string
  getNextIndex: (role: string, name?: string) => number
  trackRef: (role: string, name: string | undefined, ref: string) => void
  getDuplicateKeys: () => Set<string>
}

function createDuplicateTracker(): DuplicateTracker {
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()

  return {
    counts,
    refsByKey,
    getKey(role, name) {
      return `${role}:${name ?? ''}`
    },
    getNextIndex(role, name) {
      const key = this.getKey(role, name)
      const current = counts.get(key) ?? 0
      counts.set(key, current + 1)
      return current
    },
    trackRef(role, name, ref) {
      const key = this.getKey(role, name)
      const refs = refsByKey.get(key) ?? []
      refs.push(ref)
      refsByKey.set(key, refs)
    },
    getDuplicateKeys() {
      const duplicates = new Set<string>()
      for (const [key, refs] of refsByKey.entries()) {
        if (refs.length > 1) {
          duplicates.add(key)
        }
      }
      return duplicates
    },
  }
}

function getIndentDepth(line: string): number {
  const match = line.match(/^(\s*)/)
  return match ? Math.floor(match[1].length / 2) : 0
}

function stripRedundantContainerLines(snapshot: string): string {
  const lines = snapshot.split('\n')
  const kept: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes('[ref=')) {
      kept.push(line)
      continue
    }
    if (line.includes(':') && !line.trimEnd().endsWith(':')) {
      kept.push(line)
      continue
    }

    const depth = getIndentDepth(line)
    let containsNestedRef = false
    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      if (getIndentDepth(lines[nestedIndex]) <= depth) break
      if (lines[nestedIndex]?.includes('[ref=')) {
        containsNestedRef = true
        break
      }
    }

    if (containsNestedRef) {
      kept.push(line)
    }
  }

  return kept.join('\n')
}

function removeDuplicateNth(refs: Record<string, RoleRef>, tracker: DuplicateTracker): void {
  const duplicateKeys = tracker.getDuplicateKeys()
  for (const [ref, value] of Object.entries(refs)) {
    const key = tracker.getKey(value.role, value.name)
    if (!duplicateKeys.has(key)) {
      delete refs[ref]?.nth
    }
  }
}

function appendRefLine(
  line: string,
  refs: Record<string, RoleRef>,
  options: RoleSnapshotOptions,
  tracker: DuplicateTracker,
  nextRef: () => string,
): string | null {
  const depth = getIndentDepth(line)
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return null
  }

  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
  if (!match) {
    return options.interactive ? null : line
  }

  const [, prefix, rawRole, name, tail] = match
  if (rawRole.startsWith('/')) {
    return options.interactive ? null : line
  }

  const role = rawRole.toLowerCase()
  const interactive = INTERACTIVE_ROLES.has(role)
  const named = NAMED_ROLES.has(role)
  const compactSkip = COMPACT_SKIP_ROLES.has(role)

  if (options.interactive && !interactive) {
    return null
  }
  if (options.compact && compactSkip && !name) {
    return null
  }
  if (!(interactive || (named && name))) {
    return line
  }

  const ref = nextRef()
  const nth = tracker.getNextIndex(role, name)
  tracker.trackRef(role, name, ref)
  refs[ref] = { role, ...(name ? { name } : {}), ...(nth > 0 ? { nth } : {}) }

  let rewritten = `${prefix}${rawRole}`
  if (name) rewritten += ` "${name}"`
  rewritten += ` [ref=${ref}]`
  if (nth > 0) rewritten += ` [nth=${nth}]`
  if (tail) rewritten += tail
  return rewritten
}

export function parseRoleSnapshot(
  ariaSnapshot: string,
  options: RoleSnapshotOptions = {},
): {
  snapshot: string
  refs: Record<string, RoleRef>
  stats: { lines: number; chars: number; refs: number; interactive: number }
} {
  const lines = ariaSnapshot.split('\n')
  const refs: Record<string, RoleRef> = {}
  const tracker = createDuplicateTracker()
  let nextId = 0
  const nextRef = () => {
    nextId += 1
    return `e${nextId}`
  }

  if (options.interactive) {
    const interactiveLines: string[] = []
    for (const line of lines) {
      const depth = getIndentDepth(line)
      if (options.maxDepth !== undefined && depth > options.maxDepth) continue
      const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
      if (!match) continue

      const [, , rawRole, name, tail] = match
      if (rawRole.startsWith('/')) continue
      const role = rawRole.toLowerCase()
      if (!INTERACTIVE_ROLES.has(role)) continue

      const ref = nextRef()
      const nth = tracker.getNextIndex(role, name)
      tracker.trackRef(role, name, ref)
      refs[ref] = { role, ...(name ? { name } : {}), ...(nth > 0 ? { nth } : {}) }

      let rewritten = `- ${rawRole}`
      if (name) rewritten += ` "${name}"`
      rewritten += ` [ref=${ref}]`
      if (nth > 0) rewritten += ` [nth=${nth}]`
      if (tail?.includes('[')) rewritten += tail
      interactiveLines.push(rewritten)
    }

    removeDuplicateNth(refs, tracker)
    const snapshot = interactiveLines.join('\n') || '(no interactive elements)'
    return {
      snapshot,
      refs,
      stats: {
        lines: snapshot.split('\n').length,
        chars: snapshot.length,
        refs: Object.keys(refs).length,
        interactive: Object.values(refs).filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length,
      },
    }
  }

  const rewrittenLines = lines
    .map((line) => appendRefLine(line, refs, options, tracker, nextRef))
    .filter((line): line is string => line !== null)

  removeDuplicateNth(refs, tracker)
  const snapshot = options.compact ? stripRedundantContainerLines(rewrittenLines.join('\n') || '(empty)') : rewrittenLines.join('\n') || '(empty)'

  return {
    snapshot,
    refs,
    stats: {
      lines: snapshot.split('\n').length,
      chars: snapshot.length,
      refs: Object.keys(refs).length,
      interactive: Object.values(refs).filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length,
    },
  }
}
