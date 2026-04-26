import { beforeEach, describe, expect, it, vi } from 'vitest'

const attachDebugger = vi.fn()
const detachDebugger = vi.fn()
const detachAll = vi.fn(async () => [])
const cleanupTabQueue = vi.fn()
const cleanupAllTabQueues = vi.fn()
const interceptEvent = vi.fn(() => ({}))
const groupRestore = vi.fn()
const groupAddTab = vi.fn()
const groupDissolve = vi.fn()

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/tabs/debugger-attach.js', () => ({
  attachDebugger,
  detachDebugger,
  detachAll,
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/commands/dispatch.js', () => ({
  cleanupTabQueue,
  cleanupAllTabQueues,
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/events/index.js', () => ({
  interceptEvent,
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/tabs/session-indicators.js', () => ({
  SessionIndicators: class {
    trackCommand() {}
    removeTab() {}
    moveTab() {}
    clear() {}
    start() {}
    stop() {}
    handleAlarm() { return false }
  },
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/tabs/agent-group.js', () => ({
  AgentGroupManager: class {
    currentGroupId: number | null = null

    get groupId() { return this.currentGroupId }

    reset() {
      this.currentGroupId = null
    }

    async restore(groupId?: number | null) {
      this.currentGroupId = Number.isInteger(groupId) ? Number(groupId) : null
      await groupRestore(groupId)
    }

    async addTab(tabId: number) {
      if (this.currentGroupId === null) this.currentGroupId = 9001
      await groupAddTab(tabId)
    }

    async dissolve(...args: unknown[]) {
      this.currentGroupId = null
      await groupDissolve(...args)
    }
  },
}))

const sessionState: Record<string, unknown> = {}
let tabsById = new Map<number, { id: number; url: string; title: string; windowId?: number; active?: boolean }>()
const debuggerSendCommand = vi.fn()

function getSessionValue(key: string | string[]) {
  if (typeof key === 'string') {
    return { [key]: sessionState[key] }
  }
  const result: Record<string, unknown> = {}
  for (const item of key) result[item] = sessionState[item]
  return result
}

function flushTasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

type StoredTabManagerState = {
  tabs?: Array<{
    tabId: number
    state: string
    sessionId: string
    targetKey?: string
    targetId: string
    url?: string
    title?: string
    windowId?: number | null
    active?: boolean
  }>
  agentTabs?: Array<{
    tabId: number
    type: string
  }>
  cancelled?: number[]
  groupId?: number | null
}

async function loadTabManager() {
  const mod = await import('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/tabs/manager.js')
  return mod.TabManager
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.useRealTimers()

  for (const key of Object.keys(sessionState)) {
    delete sessionState[key]
  }

  tabsById = new Map([
    [1, { id: 1, url: 'https://example.com', title: 'Example' }],
    [2, { id: 2, url: 'https://example.org', title: 'Docs', windowId: 12, active: false }],
  ])

  attachDebugger.mockResolvedValue({ realTargetId: 'target-1' })
  debuggerSendCommand.mockReset()
  groupRestore.mockReset()
  groupAddTab.mockReset()
  groupDissolve.mockReset()

  Object.assign(globalThis, {
    chrome: {
      storage: {
        session: {
          get: vi.fn(async (key: string | string[]) => getSessionValue(key)),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(sessionState, value)
          }),
          remove: vi.fn(async (key: string) => {
            delete sessionState[key]
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          const tab = tabsById.get(tabId)
          if (!tab) throw new Error(`tab ${tabId} not found`)
          return tab
        }),
        query: vi.fn(async () => [...tabsById.values()]),
      },
      alarms: {
        create: vi.fn(),
        clear: vi.fn(async () => true),
      },
      debugger: {
        sendCommand: debuggerSendCommand,
      },
    },
  })
})

describe('accio browser relay tab manager', () => {
  it('auto-recovers unexpected debugger detach with backoff instead of dropping the tab', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))

    const sendToRelay = vi.fn()
    const TabManager = await loadTabManager()
    const mgr = new TabManager(sendToRelay)

    const attached = await mgr.attach(1)
    await flushTasks()
    sendToRelay.mockClear()

    await mgr.onDebuggerDetach({ tabId: 1 }, 'target_closed')
    await flushTasks()

    debuggerSendCommand.mockRejectedValue(new Error('debugger lost'))
    vi.setSystemTime(new Date('2026-04-25T00:00:01.500Z'))
    mgr.handleMaintenanceAlarm('relayTabRecovery')
    await flushTasks()
    await flushTasks()

    expect(attached?.sessionId).toBeTruthy()
    expect(mgr.has(1)).toBe(true)
    expect(mgr.get(1)?.state).toBe('connected')
    expect(mgr.get(1)?.sessionId).toBe(attached?.sessionId)
    expect(detachDebugger).not.toHaveBeenCalled()
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: attached?.sessionId,
          tabId: 1,
          windowId: null,
          active: false,
          targetKey: 'vtab:browser-instance:1',
          targetId: attached?.targetId,
          reason: 'target_closed',
        },
      },
    })
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: attached?.sessionId,
          tabId: 1,
          windowId: null,
          active: false,
          targetKey: 'vtab:browser-instance:1',
          targetInfo: {
            targetId: 'target-1',
            type: 'page',
            title: 'Example',
            url: 'https://example.com',
            attached: true,
          },
          waitingForDebugger: false,
        },
      },
    })
    const snapshot = sessionState.accio_tabManagerState as StoredTabManagerState | undefined
    expect(snapshot?.tabs).toEqual([
      expect.objectContaining({
        tabId: 1,
        state: 'connected',
        sessionId: attached?.sessionId,
        targetKey: 'vtab:browser-instance:1',
        targetId: 'target-1',
      }),
    ])
  })

  it('restores persisted tabs, group state, and re-announces tracked sessions after transport recovery', async () => {
    sessionState.accio_tabManagerState = {
      tabs: [
        {
          tabId: 1,
          state: 'connected',
          sessionId: 'cb-tab:browser-instance:1',
          targetKey: 'vtab:browser-instance:1',
          targetId: 'target-1',
          url: 'https://example.com',
          title: 'Example',
          active: true,
        },
        {
          tabId: 2,
          state: 'attaching',
          sessionId: 'cb-tab:browser-instance:2',
          targetKey: 'vtab:browser-instance:2',
          targetId: 'target-2',
          url: 'https://example.org',
          title: 'Docs',
          windowId: 12,
        },
      ],
      agentTabs: [{ tabId: 2, type: 'agent' }],
      cancelled: [],
      groupId: 77,
    }

    debuggerSendCommand.mockImplementation(async ({ tabId }: { tabId: number }) => {
      if (tabId === 1) {
        return { targetInfo: { targetId: 'target-1' } }
      }
      throw new Error('detached')
    })
    attachDebugger.mockResolvedValueOnce({ realTargetId: 'target-2' })

    const sendToRelay = vi.fn()
    const TabManager = await loadTabManager()
    const mgr = new TabManager(sendToRelay)

    await mgr.restoreState()
    await mgr.refreshAfterTransportReady()

    expect(mgr.get(1)).toMatchObject({
      state: 'connected',
      sessionId: 'cb-tab:browser-instance:1',
      targetKey: 'vtab:browser-instance:1',
      targetId: 'target-1',
    })
    expect(mgr.get(2)).toMatchObject({
      state: 'connected',
      sessionId: 'cb-tab:browser-instance:2',
      targetKey: 'vtab:browser-instance:2',
      targetId: 'target-2',
    })
    expect(groupRestore).toHaveBeenCalledWith(77)
    expect(groupAddTab).toHaveBeenCalledWith(2)
    expect(sendToRelay).not.toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabDiscovered',
        params: {
          sessionId: 'session-2',
          targetInfo: {
            targetId: 'vtab-2',
            type: 'page',
            title: 'Docs',
            url: 'https://example.org',
            attached: false,
          },
        },
      },
    })
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'cb-tab:browser-instance:2',
          tabId: 2,
          windowId: 12,
          active: false,
          targetKey: 'vtab:browser-instance:2',
          targetInfo: {
            targetId: 'target-2',
            type: 'page',
            title: 'Docs',
            url: 'https://example.org',
            attached: true,
          },
          waitingForDebugger: false,
        },
      },
    })
    const snapshot = sessionState.accio_tabManagerState as StoredTabManagerState | undefined
    expect(snapshot?.groupId).toBe(77)
  })

  it('moves tracked state across chrome.tabs.onReplaced and auto-recovers the debugger session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))

    const sendToRelay = vi.fn()
    const TabManager = await loadTabManager()
    const mgr = new TabManager(sendToRelay)

    const attached = await mgr.attach(1)
    mgr.markAgent(1)
    await flushTasks()
    sendToRelay.mockClear()

    tabsById.delete(1)
    tabsById.set(3, { id: 3, url: 'https://example.net', title: 'Replacement' })
    debuggerSendCommand.mockRejectedValue(new Error('debugger lost'))

    await mgr.handleTabReplaced(3, 1)
    await flushTasks()

    expect(mgr.has(1)).toBe(false)
    expect(mgr.has(3)).toBe(true)
    expect(mgr.get(3)?.state).toBe('attaching')
    expect(mgr.get(3)?.sessionId).toBe(attached?.sessionId)
    expect(mgr.isAgent(3)).toBe(true)
    expect(mgr.isAgent(1)).toBe(false)
    expect(groupAddTab).toHaveBeenCalledWith(3)

    attachDebugger.mockResolvedValueOnce({ realTargetId: 'target-3' })
    vi.setSystemTime(new Date('2026-04-25T00:00:01.500Z'))
    mgr.handleMaintenanceAlarm('relayTabRecovery')
    await flushTasks()

    expect(mgr.get(3)).toMatchObject({
      state: 'connected',
      sessionId: attached?.sessionId,
      targetId: 'target-3',
      title: 'Replacement',
      url: 'https://example.net',
    })
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: attached?.sessionId,
          tabId: 3,
          windowId: null,
          active: false,
          targetKey: 'vtab:browser-instance:1',
          targetId: attached?.targetId,
          reason: 'tab-replaced',
        },
      },
    })
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: attached?.sessionId,
          tabId: 3,
          windowId: null,
          active: false,
          targetKey: 'vtab:browser-instance:1',
          targetInfo: {
            targetId: 'target-3',
            type: 'page',
            title: 'Replacement',
            url: 'https://example.net',
            attached: true,
          },
          waitingForDebugger: false,
        },
      },
    })
  })

  it('detects dead debugger sessions during health check and reattaches automatically', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))

    const sendToRelay = vi.fn()
    const TabManager = await loadTabManager()
    const mgr = new TabManager(sendToRelay)

    const attached = await mgr.attach(1)
    await flushTasks()
    sendToRelay.mockClear()

    debuggerSendCommand.mockRejectedValue(new Error('debugger unavailable'))
    await mgr.performHealthCheck()
    await flushTasks()

    expect(mgr.get(1)?.state).toBe('attaching')
    expect(sendToRelay).toHaveBeenCalledWith({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: attached?.sessionId,
          tabId: 1,
          windowId: null,
          active: false,
          targetKey: 'vtab:browser-instance:1',
          targetId: attached?.targetId,
          reason: 'debugger-unhealthy',
        },
      },
    })

    vi.setSystemTime(new Date('2026-04-25T00:00:01.500Z'))
    mgr.handleMaintenanceAlarm('relayTabRecovery')
    await flushTasks()

    expect(mgr.get(1)?.state).toBe('connected')
  })
})
