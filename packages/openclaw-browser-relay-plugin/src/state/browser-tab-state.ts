export type BrowserTabRecord = {
  targetId: string
  kind: 'agent' | 'retained'
  createdAt: number
  lastCommandAt: number
  sessionKey?: string
  rootSessionKey?: string
}

function resolveRootSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined
  let current = sessionKey
  while (current.startsWith('agent:')) {
    const splitIndex = current.indexOf(':sub:')
    if (splitIndex === -1) break
    current = current.slice(6, splitIndex)
  }
  return current
}

export class BrowserTabState {
  private readonly tabs = new Map<string, BrowserTabRecord>()
  private readonly recentlyClosed = new Set<string>()
  private windowId: number | null = null
  private anchorTargetId: string | null = null
  private syncChain = Promise.resolve()

  registerTab(targetId: string, options: { retain?: boolean; sessionKey?: string } = {}): void {
    if (!targetId || this.recentlyClosed.has(targetId)) return
    const existing = this.tabs.get(targetId)
    const now = Date.now()
    const sessionKey = options.sessionKey ?? existing?.sessionKey
    this.tabs.set(targetId, {
      targetId,
      kind: options.retain ? 'retained' : 'agent',
      createdAt: existing?.createdAt ?? now,
      lastCommandAt: now,
      sessionKey,
      rootSessionKey: sessionKey ? resolveRootSessionKey(sessionKey) : existing?.rootSessionKey,
    })
  }

  closeTab(targetId: string): boolean {
    if (!targetId || this.recentlyClosed.has(targetId) || !this.tabs.has(targetId)) {
      return false
    }

    this.tabs.delete(targetId)
    this.recentlyClosed.add(targetId)
    setTimeout(() => this.recentlyClosed.delete(targetId), 10_000)

    if (this.anchorTargetId === targetId) {
      const next = this.tabs.keys().next()
      this.anchorTargetId = next.done ? null : next.value
      if (!this.anchorTargetId) {
        this.windowId = null
      }
    }

    return true
  }

  touchTab(targetId?: string): void {
    if (!targetId) return
    const current = this.tabs.get(targetId)
    if (!current) return
    current.lastCommandAt = Date.now()
  }

  markRetained(targetId: string, retained: boolean): void {
    const current = this.tabs.get(targetId)
    if (!current) return
    current.kind = retained ? 'retained' : 'agent'
  }

  get agentTabCount(): number {
    return this.tabs.size
  }

  get retainedTabCount(): number {
    let count = 0
    for (const entry of this.tabs.values()) {
      if (entry.kind === 'retained') count += 1
    }
    return count
  }

  get nonRetainedIds(): string[] {
    return [...this.tabs.entries()]
      .filter(([, entry]) => entry.kind === 'agent')
      .map(([targetId]) => targetId)
  }

  get allTargetIds(): string[] {
    return [...this.tabs.keys()]
  }

  getTargetIdsBySessionTree(sessionKey: string): string[] {
    return [...this.tabs.values()]
      .filter((entry) => entry.rootSessionKey === sessionKey)
      .map((entry) => entry.targetId)
  }

  getTab(targetId?: string): BrowserTabRecord | undefined {
    return targetId ? this.tabs.get(targetId) : undefined
  }

  isAgent(targetId: string): boolean {
    return this.tabs.has(targetId)
  }

  isRetained(targetId: string): boolean {
    return this.tabs.get(targetId)?.kind === 'retained'
  }

  setWindow(windowId: number, anchorTargetId: string): void {
    this.windowId = windowId
    this.anchorTargetId = anchorTargetId
  }

  setAnchor(targetId: string): void {
    if (!this.anchorTargetId) {
      this.anchorTargetId = targetId
    }
  }

  get currentWindowId(): number | null {
    return this.windowId
  }

  get currentAnchorTargetId(): string | null {
    return this.anchorTargetId
  }

  clearWindow(): void {
    this.windowId = null
    this.anchorTargetId = null
  }

  purgeStale(validTargetIds: Set<string>): number {
    let removed = 0
    for (const targetId of [...this.tabs.keys()]) {
      if (validTargetIds.has(targetId)) continue
      if (this.closeTab(targetId)) removed += 1
    }
    return removed
  }

  getIdleTabs(idleMs: number): string[] {
    const now = Date.now()
    const result: string[] = []
    for (const [targetId, entry] of this.tabs.entries()) {
      if (entry.kind !== 'agent') continue
      if (now - entry.lastCommandAt > idleMs) {
        result.push(targetId)
      }
    }
    return result
  }

  reset(): void {
    this.tabs.clear()
    this.recentlyClosed.clear()
    this.windowId = null
    this.anchorTargetId = null
  }

  async withSyncLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.syncChain
    let release!: () => void
    this.syncChain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}
