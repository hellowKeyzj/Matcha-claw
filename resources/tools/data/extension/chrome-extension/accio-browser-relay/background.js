/**
 * MatchaClaw Browser Relay — MV3 Service Worker entry point.
 *
 * Thin orchestration layer: wires up relay, tabs, and CDP modules,
 * then registers Chrome event listeners.
 *
 * CDP channel            → lib/cdp/            (WebSocket relay, tab management, CDP dispatch)
 * Content Script channel → lib/content_script/  (DOM interaction via chrome.scripting)
 */

import {
  TabManager,
  createDispatcher,
  initRelay,
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
} from './lib/cdp/index.js'
import { RelayState, SETTINGS_KEYS, getSetting } from './lib/constants.js'
import { createLogger, setDebug } from './lib/logger.js'
import { getBrowserInstanceId } from './lib/browser-instance.js'

setDebug(true)

const log = createLogger('bg')

// ── Wire modules together ──

const runtimeState = {
  browserInstanceId: '',
  selectedBrowserInstanceId: null,
  selectedWindowId: null,
}

let runtimeReadyPromise = null

function currentBrowserInstanceId() {
  return runtimeState.browserInstanceId
}

function currentSelectedBrowserInstanceId() {
  return runtimeState.selectedBrowserInstanceId
}

function currentSelectedWindowId() {
  return runtimeState.selectedWindowId
}

function requireBrowserInstanceId() {
  const browserInstanceId = currentBrowserInstanceId()
  if (!browserInstanceId) {
    throw new Error('browser instance not initialized')
  }
  return browserInstanceId
}

function isCurrentBrowserSelected() {
  return currentSelectedBrowserInstanceId() === currentBrowserInstanceId()
}

function isSelectedWindow(windowId) {
  return isCurrentBrowserSelected()
    && Number.isInteger(windowId)
    && currentSelectedWindowId() === windowId
}

function isInspectableTabUrl(url) {
  return typeof url === 'string' && /^(https?|file):\/\/|^about:blank$/.test(url)
}

function toSelectedWindowId(value) {
  return Number.isInteger(value) ? value : null
}

function mirrorSelectionState(params = {}) {
  runtimeState.selectedBrowserInstanceId =
    typeof params.selectedBrowserInstanceId === 'string' && params.selectedBrowserInstanceId.trim()
      ? params.selectedBrowserInstanceId.trim()
      : null
  runtimeState.selectedWindowId = toSelectedWindowId(params.selectedWindowId)
}

async function initializeRuntimeState() {
  if (runtimeReadyPromise) {
    return runtimeReadyPromise
  }

  runtimeReadyPromise = (async () => {
    runtimeState.browserInstanceId = await getBrowserInstanceId()
  })().catch((error) => {
    runtimeReadyPromise = null
    throw error
  })

  return runtimeReadyPromise
}

async function ensureRuntimeReady() {
  await initializeRuntimeState()
}

function runWhenRuntimeReady(task, label) {
  void ensureRuntimeReady()
    .then(task)
    .catch((error) => {
      log.error(`${label}:`, error)
    })
}

const mgr = new TabManager(trySendToRelay, {
  getBrowserInstanceId: requireBrowserInstanceId,
})
const handleCdp = createDispatcher(mgr)

function announceWindowSelection(windowId) {
  if (!isRelayConnected()) return
  trySendToRelay({
    method: 'Extension.selectExecutionWindow',
    params: { windowId },
  })
}

function clearPrimaryTarget() {
  if (!isRelayConnected()) return
  trySendToRelay({
    method: 'Extension.primaryTargetChanged',
    params: {},
  })
}

async function getPrimaryTabForSelectedWindow() {
  const windowId = currentSelectedWindowId()
  if (!Number.isInteger(windowId)) return null

  const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => [])
  const activeTab = tabs.find((entry) => Number.isInteger(entry?.id))
  if (!activeTab?.id || !isInspectableTabUrl(activeTab.url)) {
    return null
  }
  return activeTab
}

async function syncSelectedBrowserPrimary() {
  await ensureRuntimeReady()
  if (!isCurrentBrowserSelected() || currentSelectedWindowId() === null || !isRelayConnected()) {
    clearPrimaryTarget()
    return
  }

  const tab = await getPrimaryTabForSelectedWindow()
  if (!tab?.id) {
    clearPrimaryTarget()
    return
  }

  mgr.setActiveTab(tab.id, tab.windowId ?? null)
  mgr.updateTab(tab.id, tab.url, tab.title, {
    windowId: tab.windowId ?? null,
    active: true,
  })

  const attached = await mgr.attach(tab.id).catch((error) => {
    log.warn('syncSelectedBrowserPrimary attach failed:', tab.id, error)
    return null
  })
  if (!attached) {
    clearPrimaryTarget()
    return
  }

  trySendToRelay({
    method: 'Extension.primaryTargetChanged',
    params: {
      sessionId: attached.sessionId,
      targetId: attached.targetId,
      tabId: tab.id,
      windowId: tab.windowId ?? null,
    },
  })
}

async function buildBrowserInstanceList() {
  await ensureRuntimeReady()
  const windows = new Map()
  for (const [tabId, entry] of mgr.entries()) {
    const windowId = Number.isInteger(entry.windowId) ? entry.windowId : -1
    if (!windows.has(windowId)) {
      windows.set(windowId, {
        windowId: windowId >= 0 ? windowId : null,
        active: false,
        selected: windowId >= 0 && isSelectedWindow(windowId),
        tabs: [],
      })
    }
    const bucket = windows.get(windowId)
    const isPhysical = entry.state === 'connected'
    bucket.active = bucket.active || entry.active === true
    bucket.tabs.push({
      tabId,
      sessionId: entry.sessionId,
      targetKey: entry.targetKey,
      targetId: isPhysical ? entry.targetId : null,
      state: entry.state,
      url: entry.url || '',
      title: entry.title || '',
      active: entry.active === true,
      windowId: entry.windowId ?? null,
      isAgent: mgr.isAgent(tabId),
      isRetained: mgr.isRetained(tabId),
    })
  }

  return [{
    browserInstanceId: currentBrowserInstanceId(),
    selected: isCurrentBrowserSelected(),
    windows: [...windows.values()].sort((a, b) => (a.windowId ?? Number.MAX_SAFE_INTEGER) - (b.windowId ?? Number.MAX_SAFE_INTEGER)),
  }]
}

initRelay({
  async onMessage(msg) {
    return handleCdp(msg)
  },
  async onControlMessage(msg) {
    await ensureRuntimeReady()
    if (msg?.method !== 'Extension.selectionChanged') return
    mirrorSelectionState(msg.params)
    if (isCurrentBrowserSelected() && currentSelectedWindowId() !== null) {
      await syncSelectedBrowserPrimary()
    } else {
      clearPrimaryTarget()
    }
  },
  async onShutdown() {
    log.info('onShutdown callback: disabled')
    let dissolveGroup = false
    const shouldClose = await getSetting(SETTINGS_KEYS.CLOSE_GROUP_ON_DISABLE)
    log.info('onShutdown: closeGroupOnDisable setting =', shouldClose)
    if (shouldClose) {
      log.info('onShutdown: dissolving agent tab group per user setting')
      dissolveGroup = true
    }
    await mgr.shutdown({ dissolveGroup })
    log.info('onShutdown: done, dissolveGroup =', dissolveGroup)
  },
  async onTransportClosed() {
    log.info('onTransportClosed callback')
    mgr.handleTransportClosed()
  },
  async onConnected() {
    await ensureRuntimeReady()
    log.info('onConnected callback: restoring + announcing tracked tabs')
    await mgr.refreshAfterTransportReady()
    mgr.startSessionIndicators()
    void mgr.discoverAll(isRelayConnected)
    if (isCurrentBrowserSelected() && currentSelectedWindowId() !== null) {
      await syncSelectedBrowserPrimary()
    }
  },
  installDebuggerListeners() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      mgr.onDebuggerEvent(source, method, params)
    })
    chrome.debugger.onDetach.addListener((source, reason) => {
      log.info('chrome.debugger.onDetach:', source.tabId, reason)
      void mgr.onDebuggerDetach(source, reason)
    })
  },
})

void mgr.restoreState()
// ── Helpers ──

async function handleToggle() {
  log.info('handleToggle: state =', getRelayState())
  if (getRelayState() === RelayState.DISABLED) {
    await toggle()
  } else {
    await disconnect()
  }
  log.info('handleToggle: done, state =', getRelayState())
}

// ── Event listeners ──

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ensureRuntimeReady()
  mgr.setActiveTab(tabId, windowId)
  try {
    const tab = await chrome.tabs.get(tabId)
    if (mgr.has(tabId)) {
      mgr.updateTab(tabId, tab.url, tab.title, {
        windowId: tab.windowId ?? null,
        active: true,
      })
    }
  } catch {
    // tab may already be gone
  }
  if (isSelectedWindow(windowId) && isRelayConnected()) {
    void syncSelectedBrowserPrimary()
    return
  }
  if (getRelayState() === RelayState.DISABLED || isRelayConnected() || isReconnecting()) return
  void connectAndAttach()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  runWhenRuntimeReady(() => {
    if (!isRelayConnected()) return

    if (mgr.has(tabId) && (changeInfo.title || changeInfo.url)) {
      mgr.updateTab(tabId, changeInfo.url, changeInfo.title, {
        windowId: tab.windowId ?? null,
        active: tab.active === true,
      })
    }

    if (changeInfo.status === 'complete') {
      mgr.discover(tabId, tab.url, tab.title, {
        windowId: tab.windowId ?? null,
        active: tab.active === true,
      })
      if (tab.active && isSelectedWindow(tab.windowId ?? null)) {
        void syncSelectedBrowserPrimary()
      }
    }
  }, 'tabs.onUpdated init failed')
})

chrome.tabs.onRemoved.addListener((tabId) => {
  runWhenRuntimeReady(async () => {
    const removedWindowId = mgr.get(tabId)?.windowId ?? null
    await mgr.handleTabRemoved(tabId)
    if (isSelectedWindow(removedWindowId) && isRelayConnected()) {
      await syncSelectedBrowserPrimary()
    }
  }, 'tabs.onRemoved init failed')
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  runWhenRuntimeReady(async () => {
    const replacedWindowId = mgr.get(removedTabId)?.windowId ?? null
    await mgr.handleTabReplaced(addedTabId, removedTabId)
    if (isSelectedWindow(replacedWindowId) && isRelayConnected()) {
      await syncSelectedBrowserPrimary()
    }
  }, 'tabs.onReplaced init failed')
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  runWhenRuntimeReady(async () => {
    const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => [])
    const activeTab = tabs.find((entry) => Number.isInteger(entry?.id))
    if (activeTab?.id) {
      mgr.setActiveTab(activeTab.id, windowId)
      if (mgr.has(activeTab.id)) {
        mgr.updateTab(activeTab.id, activeTab.url, activeTab.title, {
          windowId,
          active: true,
        })
      }
    }
    if (isSelectedWindow(windowId) && isRelayConnected()) {
      await syncSelectedBrowserPrimary()
    }
  }, 'windows.onFocusChanged init failed')
})

// Keep-alive alarm: created conditionally, cleared on disconnect.
void (async () => {
  if (await isRelayEnabled()) {
    ensureKeepAliveAlarm()
  }
})()

chrome.alarms.onAlarm.addListener((alarm) => {
  // Let connection module handle reconnect / disconnect-notify alarms
  if (handleConnectionAlarm(alarm.name)) return

  // Let session indicators handle idle-check alarm
  if (mgr.handleIndicatorAlarm(alarm.name)) return

  if (mgr.handleMaintenanceAlarm(alarm.name)) return

  if (alarm.name !== 'relayKeepAlive') return

  if (isRelayConnected()) {
    trySendToRelay({ method: 'ping' })
    void mgr.performHealthCheck()
    return
  }
  if (isReconnecting()) return

  // SW may have restarted — in-memory state is DISABLED but storage says enabled.
  // Reset backoff so stale exponential delays from a previous SW lifetime
  // don't cause a long wait before the first reconnect attempt.
  if (getRelayState() === RelayState.DISABLED || getRelayState() === RelayState.DISCONNECTED) {
    void (async () => {
      if (getRelayState() === RelayState.DISABLED) {
        await initFromStorage()
      }
      if (await isRelayEnabled()) {
        log.info('alarm: relay enabled but disconnected, attempting reconnect')
        resetReconnectBackoff()
        await connectAndAttach()
      }
    })()
  }
})

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureRuntimeReady()
    await mgr.restoreState()
    await initFromStorage()
    if (!(await isRelayEnabled())) return
    console.info('[matchaclaw-relay] browser started with relay enabled, attempting connection')
    await connectAndAttach()
  })()
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getRelayStatus') {
    void (async () => {
      await ensureRuntimeReady()
      sendResponse({
        state: getRelayState(),
        connected: isRelayConnected(),
        active: isRelayActive(),
        reconnecting: isReconnecting(),
        attachedTabs: mgr.size,
        agentTabs: mgr.agentTabCount,
        retainedTabs: mgr.retainedTabCount,
        browserInstanceId: currentBrowserInstanceId(),
        selectedBrowserInstanceId: currentSelectedBrowserInstanceId(),
        selectedWindowId: currentSelectedWindowId(),
      })
    })()
    return true
  }
  if (msg?.type === 'toggleRelay') {
    handleToggle()
      .then(() => {
        try { sendResponse({ state: getRelayState() }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        log.error('handleToggle failed:', e)
        try { sendResponse({ state: getRelayState(), error: e?.message }) } catch { /* channel closed */ }
      })
    return true
  }
  if (msg?.type === 'getTabList') {
    void (async () => {
      await ensureRuntimeReady()
      const tabs = []
      for (const [tabId, entry] of mgr.entries()) {
        const isPhysical = entry.state === 'connected'
        tabs.push({
          tabId,
          state: entry.state,
          sessionId: entry.sessionId,
          targetKey: entry.targetKey,
          targetId: isPhysical ? entry.targetId : null,
          url: entry.url || '',
          title: entry.title || '',
          windowId: entry.windowId ?? null,
          active: entry.active === true,
          browserInstanceId: currentBrowserInstanceId(),
          selectedBrowser: isCurrentBrowserSelected(),
          selectedWindow: isSelectedWindow(entry.windowId ?? null),
          isAgent: mgr.isAgent(tabId),
          isRetained: mgr.isRetained(tabId),
        })
      }
      sendResponse({ tabs })
    })()
    return true
  }
  if (msg?.type === 'getBrowserInstanceList') {
    void (async () => {
      const browserInstances = await buildBrowserInstanceList()
      sendResponse({
        browserInstances,
        selectedBrowserInstanceId: currentSelectedBrowserInstanceId(),
        selectedWindowId: currentSelectedWindowId(),
      })
    })()
    return true
  }
  if (msg?.type === 'selectExecutionWindow') {
    ;(async () => {
      await ensureRuntimeReady()
      const windowId = Number(msg.windowId)
      if (!Number.isInteger(windowId)) {
        sendResponse({ ok: false, error: 'invalid windowId' })
        return
      }
      try {
        if (!isRelayConnected()) {
          throw new Error('Relay not connected')
        }
        mirrorSelectionState({
          selectedBrowserInstanceId: currentBrowserInstanceId(),
          selectedWindowId: windowId,
        })
        announceWindowSelection(windowId)
        await syncSelectedBrowserPrimary()
        sendResponse({
          ok: true,
          selectedBrowserInstanceId: currentSelectedBrowserInstanceId(),
          selectedWindowId: currentSelectedWindowId(),
        })
      } catch (error) {
        log.error('selectExecutionWindow failed:', error)
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()
    return true
  }
  if (msg?.type === 'attachTab') {
    const tabId = Number(msg.tabId)
    if (!Number.isInteger(tabId) || tabId <= 0) {
      sendResponse({ ok: false, error: 'invalid tabId' })
      return false
    }

    ;(async () => {
      try {
        await ensureRuntimeReady()
        log.info('attachTab request:', tabId)
        const attached = await mgr.attach(tabId)
        if (!attached) {
          sendResponse({ ok: false, error: `attach failed for tab ${tabId}` })
          return
        }

        try {
          const tab = await chrome.tabs.get(tabId)
          await chrome.tabs.update(tabId, { active: true })
          if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true })
          }
        } catch (focusError) {
          log.warn('attachTab focus failed:', tabId, focusError)
        }

        log.info('attachTab done:', tabId, attached.targetId)
        sendResponse({ ok: true, attached })
      } catch (error) {
        log.error('attachTab failed:', tabId, error)
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()

    return true
  }
  if (msg?.type === 'getLogs') {
    sendResponse({ logs: getLogBuffer(msg.limit || 100) })
    return false
  }
})

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await ensureRuntimeReady()
    if (details.reason === 'install') {
      await setRelayEnabled(true)
      void chrome.runtime.openOptionsPage()
    }
    ensureKeepAliveAlarm()
    log.info('onInstalled:', details.reason, '— attempting connection')
    await connectAndAttach()
  })()
})

void initializeRuntimeState().catch((error) => {
  log.error('runtime initialization failed:', error)
})
