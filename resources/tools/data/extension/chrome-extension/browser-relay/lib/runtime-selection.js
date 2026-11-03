import { getBrowserInstanceId } from './browser-instance.js'
import { awaitWithDeadline } from './cdp/commands/deadline.js'

export function createRuntimeSelection(manager, sendToRelay, isConnected) {
  let browserInstanceId = ''
  let selectedBrowserInstanceId = null
  let selectedWindowId = null
  const ready = getBrowserInstanceId().then((id) => { browserInstanceId = id })

  const isCurrentBrowserSelected = () =>
    browserInstanceId !== '' && selectedBrowserInstanceId === browserInstanceId
  const isSelectedWindow = (windowId) =>
    isCurrentBrowserSelected() && Number.isInteger(windowId) && windowId === selectedWindowId
  const snapshot = () => ({ browserInstanceId, selectedBrowserInstanceId, selectedWindowId })
  const awaitOperation = (context, stage, operation) => context
    ? awaitWithDeadline(context, stage, operation)
    : operation()

  function mirror(params = {}) {
    const browserId = typeof params.selectedBrowserInstanceId === 'string'
      ? params.selectedBrowserInstanceId.trim() || null
      : null
    const windowId = Number.isInteger(params.selectedWindowId) ? params.selectedWindowId : null
    const changed = browserId !== selectedBrowserInstanceId || windowId !== selectedWindowId
    selectedBrowserInstanceId = browserId
    selectedWindowId = windowId
    return changed
  }

  function announceCurrentTarget(tabId = null) {
    if (!isConnected()) return
    const entry = tabId === null ? null : manager.get(tabId)
    sendToRelay({
      method: 'Extension.currentTargetChanged',
      params: entry?.state === 'connected'
        ? {
            sessionId: entry.attachmentSessionId,
            targetId: entry.realTargetId,
            tabId,
            windowId: entry.windowId ?? null,
          }
        : {},
    })
  }

  function updateTab(tab) {
    manager.discover(tab.id, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
    if (tab.active) manager.setActiveTab(tab.id, tab.windowId)
    manager.updateTab(tab.id, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
  }

  async function syncCurrentTarget({ manual = false, commandContext, isCurrent = isConnected } = {}) {
    await ready
    if (!isCurrent()) return null
    const windowId = selectedWindowId
    const selectedBrowser = selectedBrowserInstanceId
    const isSelectionCurrent = () => isCurrent()
      && selectedWindowId === windowId && selectedBrowserInstanceId === selectedBrowser
    if (!isCurrentBrowserSelected() || windowId === null) {
      await manager.applyExecutionScope(null, { commandContext })
      if (isSelectionCurrent()) announceCurrentTarget()
      return null
    }

    const tabs = await awaitOperation(commandContext, 'chrome.tabs.query:currentTarget', () =>
      chrome.tabs.query({ active: true, windowId }))
    if (!isSelectionCurrent()) return null
    const tab = tabs.find((entry) => Number.isInteger(entry.id))
    const inspectable = typeof tab?.url === 'string'
      && /^(https?|file):\/\/|^about:blank$/.test(tab.url)
    if (!inspectable) {
      await manager.applyExecutionScope(null, { commandContext })
      if (isSelectionCurrent()) announceCurrentTarget()
      return null
    }

    updateTab(tab)
    const attached = await manager.applyExecutionScope(tab.id, { manual, commandContext })
    if (!isSelectionCurrent()) return null
    announceCurrentTarget(attached?.tabId)
    return attached
  }

  function selectWindow(windowId) {
    mirror({ selectedBrowserInstanceId: browserInstanceId, selectedWindowId: windowId })
    sendToRelay({ method: 'Extension.selectExecutionWindow', params: { windowId } })
  }

  async function attachTab(tabId, commandContext, isCurrent) {
    const tab = await awaitOperation(commandContext, 'chrome.tabs.get:manualAttach', () => chrome.tabs.get(tabId))
    if (!isCurrent()) throw new Error('Relay connection changed while selecting a tab')
    selectWindow(tab.windowId)
    updateTab(tab)
    const selectedWindow = tab.windowId
    const isSelectionCurrent = () => isCurrent() && isSelectedWindow(selectedWindow)
    const attached = await manager.applyExecutionScope(tabId, { manual: true, commandContext })
    if (!isSelectionCurrent()) throw new Error('Relay selection changed while attaching a tab')
    if (!attached) {
      announceCurrentTarget()
      throw new Error(`Attach failed for tab ${tabId}`)
    }
    await awaitOperation(commandContext, 'chrome.tabs.update:manualAttach', () =>
      chrome.tabs.update(tabId, { active: true }))
    if (!isCurrent()) throw new Error('Relay connection changed while focusing a tab')
    await awaitOperation(commandContext, 'chrome.windows.update:manualAttach', () =>
      chrome.windows.update(tab.windowId, { focused: true }))
    if (!isCurrent()) throw new Error('Relay connection changed while focusing a window')
    announceCurrentTarget(tabId)
    return attached
  }

  function listTabs() {
    return manager.listTabSnapshots().map((tab) => ({
      ...tab,
      targetId: tab.state === 'connected' ? tab.targetId : null,
      browserInstanceId,
      selectedBrowser: isCurrentBrowserSelected(),
      selectedWindow: isSelectedWindow(tab.windowId),
    }))
  }

  function listBrowserInstances() {
    const windows = new Map()
    for (const tab of listTabs()) {
      const windowId = Number.isInteger(tab.windowId) ? tab.windowId : null
      if (!windows.has(windowId)) {
        windows.set(windowId, { windowId, active: false, selected: isSelectedWindow(windowId), tabs: [] })
      }
      const window = windows.get(windowId)
      window.active ||= tab.active === true
      window.tabs.push(tab)
    }
    return [{
      browserInstanceId,
      selected: isCurrentBrowserSelected(),
      windows: [...windows.values()].sort((a, b) =>
        (a.windowId ?? Number.MAX_SAFE_INTEGER) - (b.windowId ?? Number.MAX_SAFE_INTEGER)),
    }]
  }

  return {
    ready,
    snapshot,
    mirror,
    isCurrentBrowserSelected,
    isSelectedWindow,
    getSelectedWindowId: () => selectedWindowId,
    selectWindow,
    syncCurrentTarget,
    attachTab,
    announceCurrentTarget,
    listTabs,
    listBrowserInstances,
  }
}
