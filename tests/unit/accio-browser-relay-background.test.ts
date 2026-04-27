import { beforeEach, describe, expect, it, vi } from 'vitest'

type RelayCallbacks = {
  onConnected?: () => Promise<void> | void
  onMessage?: (msg: unknown) => Promise<unknown> | unknown
  onControlMessage?: (msg: unknown) => Promise<void> | void
  onShutdown?: () => Promise<void> | void
  onTransportClosed?: () => Promise<void> | void
  installDebuggerListeners?: () => void
}

type MockTab = {
  id: number
  url: string
  title: string
  windowId?: number
  active?: boolean
}

const trySendToRelay = vi.fn()
const connectAndAttach = vi.fn(async () => true)
const ensureKeepAliveAlarm = vi.fn()
const initFromStorage = vi.fn(async () => {})
const setRelayEnabled = vi.fn(async () => {})
const handleConnectionAlarm = vi.fn(() => false)
const resetReconnectBackoff = vi.fn()
const getSetting = vi.fn(async () => false)
const getBrowserInstanceId = vi.fn(async () => 'browser-a')
const isRelayConnected = vi.fn(() => true)
const isRelayActive = vi.fn(() => true)
const isRelayEnabled = vi.fn(async () => true)
const isReconnecting = vi.fn(() => false)
const getRelayState = vi.fn(() => 'connected')
const toggle = vi.fn(async () => {})
const disconnect = vi.fn(async () => {})
const getLogBuffer = vi.fn(() => [])
const createDispatcher = vi.fn(() => vi.fn(async () => null))
const initRelay = vi.fn()

let relayCallbacks: RelayCallbacks = {}
let currentTabs: MockTab[] = []
const listeners: Record<string, ((...args: unknown[]) => unknown) | undefined> = {}

class MockTabManager {
  static latest: MockTabManager | null = null

  attach = vi.fn(async (tabId: number) => ({
    sessionId: `cb-tab:browser-a:${tabId}`,
    targetId: `target-${tabId}`,
  }))
  announceCurrentTarget = vi.fn()
  setActiveTab = vi.fn()
  updateTab = vi.fn()
  has = vi.fn(() => true)
  get = vi.fn((tabId: number) => currentTabs.find((tab) => tab.id === tabId) ?? null)
  entries = vi.fn(() => new Map().entries())
  restoreState = vi.fn(async () => {})
  refreshAfterTransportReady = vi.fn(async () => {})
  startSessionIndicators = vi.fn()
  discoverAll = vi.fn(async () => {})
  handleTransportClosed = vi.fn()
  onDebuggerEvent = vi.fn()
  onDebuggerDetach = vi.fn(async () => {})
  handleTabRemoved = vi.fn(async () => {})
  handleTabReplaced = vi.fn(async () => {})
  performHealthCheck = vi.fn(async () => {})
  handleIndicatorAlarm = vi.fn(() => false)
  handleMaintenanceAlarm = vi.fn(() => false)
  shutdown = vi.fn(async () => {})
  isAgent = vi.fn(() => false)
  isRetained = vi.fn(() => false)
  get size() { return 0 }
  get agentTabCount() { return 0 }
  get retainedTabCount() { return 0 }

  constructor() {
    MockTabManager.latest = this
  }
}

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/index.js', () => ({
  TabManager: MockTabManager,
  createDispatcher,
  initRelay: (callbacks: RelayCallbacks) => {
    relayCallbacks = callbacks
    initRelay(callbacks)
  },
  trySendToRelay,
  isRelayConnected,
  isRelayActive,
  isRelayEnabled,
  isReconnecting,
  getRelayState,
  toggle,
  disconnect,
  connectAndAttach,
  initFromStorage,
  setRelayEnabled,
  getLogBuffer,
  ensureKeepAliveAlarm,
  handleConnectionAlarm,
  resetReconnectBackoff,
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/constants.js', () => ({
  RelayState: {
    DISABLED: 'disabled',
    DISCONNECTED: 'disconnected',
    CONNECTED: 'connected',
  },
  SETTINGS_KEYS: {
    CLOSE_GROUP_ON_DISABLE: 'closeGroupOnDisable',
  },
  getSetting,
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  setDebug: vi.fn(),
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/browser-instance.js', () => ({
  getBrowserInstanceId,
}))

function registerChromeEvent(path: string) {
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => unknown) => {
      listeners[path] = listener
    }),
  }
}

async function loadBackground() {
  await import('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/background.js')
}

async function flushTasks() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  relayCallbacks = {}
  MockTabManager.latest = null
  currentTabs = [
    { id: 11, url: 'https://example.com/a', title: 'Page A', windowId: 1, active: true },
    { id: 22, url: 'https://example.com/b', title: 'Page B', windowId: 2, active: false },
  ]

  Object.keys(listeners).forEach((key) => {
    delete listeners[key]
  })

  Object.assign(globalThis, {
    chrome: {
      tabs: {
        query: vi.fn(async (query: Record<string, unknown>) => {
          if (query.active === true && query.lastFocusedWindow === true) {
            return currentTabs.filter((tab) => tab.active)
          }
          if (query.active === true && typeof query.windowId === 'number') {
            return currentTabs.filter((tab) => tab.active && tab.windowId === query.windowId)
          }
          return currentTabs
        }),
        get: vi.fn(async (tabId: number) => {
          const found = currentTabs.find((tab) => tab.id === tabId)
          if (!found) throw new Error(`tab ${tabId} not found`)
          return found
        }),
        update: vi.fn(async () => {}),
        onActivated: registerChromeEvent('tabs.onActivated'),
        onUpdated: registerChromeEvent('tabs.onUpdated'),
        onRemoved: registerChromeEvent('tabs.onRemoved'),
        onReplaced: registerChromeEvent('tabs.onReplaced'),
      },
      windows: {
        getAll: vi.fn(async () => {
          const windowIds = [...new Set(currentTabs.map((tab) => tab.windowId).filter((value): value is number => typeof value === 'number'))]
          return windowIds.map((id) => ({ id, type: 'normal' }))
        }),
        getLastFocused: vi.fn(async () => ({ tabs: currentTabs })),
        update: vi.fn(async () => {}),
        onFocusChanged: registerChromeEvent('windows.onFocusChanged'),
        WINDOW_ID_NONE: -1,
      },
      debugger: {
        onEvent: registerChromeEvent('debugger.onEvent'),
        onDetach: registerChromeEvent('debugger.onDetach'),
      },
      alarms: {
        create: vi.fn(),
        clear: vi.fn(async () => true),
        onAlarm: registerChromeEvent('alarms.onAlarm'),
      },
      runtime: {
        onStartup: registerChromeEvent('runtime.onStartup'),
        onMessage: registerChromeEvent('runtime.onMessage'),
        onInstalled: registerChromeEvent('runtime.onInstalled'),
        openOptionsPage: vi.fn(),
        getManifest: vi.fn(() => ({ version: '0.0.0-test' })),
      },
      action: {
        setTitle: vi.fn(async () => {}),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
    },
  })
})

describe('accio browser relay background', () => {
  it('auto-attaches the selected window active tab on activation changes', async () => {
    await loadBackground()
    await flushTasks()

    await relayCallbacks.onControlMessage?.({
      method: 'Extension.selectionChanged',
      params: {
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: 2,
      },
    })
    await flushTasks()

    currentTabs = [
      { id: 11, url: 'https://example.com/a', title: 'Page A', windowId: 1, active: false },
      { id: 22, url: 'https://example.com/b', title: 'Page B', windowId: 2, active: true },
    ]

    const onActivated = listeners['tabs.onActivated']
    expect(onActivated).toBeTypeOf('function')

    await onActivated?.({ tabId: 22, windowId: 2 })
    await flushTasks()

    expect(MockTabManager.latest?.setActiveTab).toHaveBeenCalledWith(22, 2)
    expect(MockTabManager.latest?.attach).toHaveBeenCalledWith(22, { manual: false })
    expect(MockTabManager.latest?.announceCurrentTarget).toHaveBeenCalledWith(22)
  })

  it('does not auto-attach active tab changes outside the selected window', async () => {
    await loadBackground()
    await flushTasks()

    await relayCallbacks.onControlMessage?.({
      method: 'Extension.selectionChanged',
      params: {
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: 1,
      },
    })
    await flushTasks()
    MockTabManager.latest?.attach.mockClear()
    MockTabManager.latest?.announceCurrentTarget.mockClear()

    currentTabs = [
      { id: 11, url: 'https://example.com/a', title: 'Page A', windowId: 1, active: false },
      { id: 22, url: 'https://example.com/b', title: 'Page B', windowId: 2, active: true },
    ]

    const onActivated = listeners['tabs.onActivated']
    expect(onActivated).toBeTypeOf('function')

    await onActivated?.({ tabId: 22, windowId: 2 })
    await flushTasks()

    expect(MockTabManager.latest?.setActiveTab).toHaveBeenCalledWith(22, 2)
    expect(MockTabManager.latest?.attach).not.toHaveBeenCalled()
    expect(MockTabManager.latest?.announceCurrentTarget).not.toHaveBeenCalled()
  })

  it('restores selected-window active-page binding after worker restart reconnect', async () => {
    await loadBackground()
    await flushTasks()

    expect(relayCallbacks.onConnected).toBeTypeOf('function')
    await relayCallbacks.onConnected?.()
    await flushTasks()

    expect(MockTabManager.latest?.refreshAfterTransportReady).toHaveBeenCalled()
    expect(MockTabManager.latest?.startSessionIndicators).toHaveBeenCalled()

    await relayCallbacks.onControlMessage?.({
      method: 'Extension.selectionChanged',
      params: {
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: 1,
      },
    })
    await flushTasks()

    expect(MockTabManager.latest?.attach).toHaveBeenCalledWith(11, { manual: true })
    expect(MockTabManager.latest?.announceCurrentTarget).toHaveBeenCalledWith(11)
  })

  it('does not auto-select the only normal window after relay connect', async () => {
    currentTabs = [
      { id: 31, url: 'https://example.com/only', title: 'Only Tab', windowId: 9, active: true },
    ]

    await loadBackground()
    await flushTasks()

    expect(relayCallbacks.onConnected).toBeTypeOf('function')
    await relayCallbacks.onConnected?.()
    await flushTasks()

    expect(trySendToRelay).not.toHaveBeenCalledWith({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 9 },
    })
    expect(MockTabManager.latest?.attach).not.toHaveBeenCalled()
    expect(MockTabManager.latest?.announceCurrentTarget).not.toHaveBeenCalled()
  })

  it('manual attach selects the tab window and promotes it to current target', async () => {
    await loadBackground()
    await flushTasks()

    const onMessage = listeners['runtime.onMessage']
    expect(onMessage).toBeTypeOf('function')

    const sendResponse = vi.fn()
    const result = onMessage?.({ type: 'attachTab', tabId: 22 }, {}, sendResponse)
    expect(result).toBe(true)
    await flushTasks()

    expect(MockTabManager.latest?.attach).toHaveBeenCalledWith(22, { manual: true })
    expect(MockTabManager.latest?.setActiveTab).toHaveBeenCalledWith(22, 2)
    expect(MockTabManager.latest?.updateTab).toHaveBeenCalledWith(22, 'https://example.com/b', 'Page B', {
      windowId: 2,
      active: true,
    })
    expect(MockTabManager.latest?.announceCurrentTarget).toHaveBeenCalledWith(22)
    expect(trySendToRelay).toHaveBeenCalledWith({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 2 },
    })
    expect(chrome.tabs.update).toHaveBeenCalledWith(22, { active: true })
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true })
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      attached: {
        sessionId: 'cb-tab:browser-a:22',
        targetId: 'target-22',
      },
    })
  })
})
