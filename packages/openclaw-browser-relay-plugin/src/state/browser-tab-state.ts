import type { PageOwnership } from './page-ownership.js'

export type BrowserTabRecord = PageOwnership & {
  targetId: string
  createdAt: number
  lastCommandAt: number
}

export class BrowserTabState {
  private readonly tabs = new Map<string, BrowserTabRecord>()
  private readonly recentlyClosed = new Set<string>()
  private currentTarget: string | null = null
  private syncChain = Promise.resolve()

  registerTab(targetId: string, options: Partial<PageOwnership> = {}): void {
    if (!targetId || this.recentlyClosed.has(targetId)) return
    const existing = this.tabs.get(targetId)
    const now = Date.now()
    this.tabs.set(targetId, {
      targetId,
      createdBy: options.createdBy !== undefined ? options.createdBy : existing?.createdBy ?? null,
      claimedBy: options.claimedBy !== undefined ? options.claimedBy : existing?.claimedBy ?? null,
      sessionGroupId: options.sessionGroupId !== undefined ? options.sessionGroupId : existing?.sessionGroupId ?? null,
      retained: options.retained ?? existing?.retained ?? false,
      createdAt: existing?.createdAt ?? now,
      lastCommandAt: now,
    })
  }

  closeTab(targetId: string): boolean {
    if (!targetId || this.recentlyClosed.has(targetId) || !this.tabs.has(targetId)) {
      return false
    }

    this.tabs.delete(targetId)
    this.recentlyClosed.add(targetId)
    setTimeout(() => this.recentlyClosed.delete(targetId), 10_000)

    if (this.currentTarget === targetId) {
      this.currentTarget = null
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
    current.retained = retained
  }

  get agentTabCount(): number {
    return [...this.tabs.values()].filter((entry) => entry.createdBy !== null).length
  }

  get retainedTabCount(): number {
    let count = 0
    for (const entry of this.tabs.values()) {
      if (entry.createdBy && entry.retained) count += 1
    }
    return count
  }

  get nonRetainedIds(): string[] {
    return [...this.tabs.entries()]
      .filter(([, entry]) => entry.createdBy && !entry.retained)
      .map(([targetId]) => targetId)
  }

  get allTargetIds(): string[] {
    return [...this.tabs.keys()]
  }

  getTab(targetId?: string): BrowserTabRecord | undefined {
    return targetId ? this.tabs.get(targetId) : undefined
  }

  isAgent(targetId: string): boolean {
    return Boolean(this.tabs.get(targetId)?.createdBy)
  }

  isRetained(targetId: string): boolean {
    return this.tabs.get(targetId)?.retained === true
  }

  setCurrentTarget(targetId: string): void {
    if (!targetId || this.recentlyClosed.has(targetId)) return
    this.currentTarget = targetId
  }

  clearCurrentTarget(targetId?: string): void {
    if (!targetId || this.currentTarget === targetId) {
      this.currentTarget = null
    }
  }

  get currentTargetId(): string | null {
    return this.currentTarget
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
      if (!entry.createdBy || entry.retained) continue
      if (now - entry.lastCommandAt > idleMs) {
        result.push(targetId)
      }
    }
    return result
  }

  reset(): void {
    this.tabs.clear()
    this.recentlyClosed.clear()
    this.currentTarget = null
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
