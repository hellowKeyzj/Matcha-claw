/** MatchaClaw Browser Relay — MV3 service worker orchestration. */
import {
  TabManager,
  createDispatcher,
  createTabCommandScheduler,
  initRelay,
  trySendToRelay,
  isRelayConnected,
  isRelayEnabled,
  isReconnecting,
  getRelayConnectionSnapshot,
  toggle,
  connectAndAttach,
  reconnectNow,
  bootstrapRelayConnection,
  initFromStorage,
  setRelayEnabled,
  getLogBuffer,
  ensureKeepAliveAlarm,
  handleConnectionAlarm,
  hasPendingReconnectAlarm,
} from './lib/cdp/index.js'
import { SETTINGS_KEYS, getSetting } from './lib/constants.js'
import { awaitWithDeadline, createCommandContext } from './lib/cdp/commands/deadline.js'
import { getCommandDiagnostics } from './lib/cdp/commands/diagnostics.js'
import { createLogger } from './lib/logger.js'
import { sendToRelay } from './lib/cdp/relay/connection.js'
import { createRuntimeSelection } from './lib/runtime-selection.js'
import { initDownloadTracker } from './lib/downloads/tracker.js'
import { registerTabDiscoveryListeners } from './lib/cdp/tabs/discovery-listeners.js'
import { clearAgentClaimFaviconCache, isAgentClaimFavicon } from './lib/page-tab-indicator.js'

const log = createLogger('bg')
const context = createBackgroundContext()
initializeRelay(context)
registerDebuggerListeners(context)
registerTabLifecycleListeners(context)
registerAlarmListeners(context)
registerRuntimeLifecycleListeners()
registerRuntimeMessageListeners(context)
void bootstrapRelayConnection().catch((error) => log.warn('relay bootstrap failed:', error))

function createBackgroundContext() {
  const scheduler = createTabCommandScheduler()
  let selection
  const mgr = new TabManager((payload) => {
    trySendToRelay(payload)
    const event = payload?.params
    if (payload?.method !== 'forwardCDPEvent' || event?.method !== 'Target.attachedToTarget') return
    const attached = event.params
    if (attached?.targetInfo?.type === 'page' && attached.active
      && selection.isSelectedWindow(attached.windowId)) {
      selection.announceCurrentTarget(attached.tabId)
    }
  }, scheduler, {
    getSelectedWindowId: () => selection.getSelectedWindowId(),
    getIsCurrentBrowserSelected: () => selection.isCurrentBrowserSelected(),
    onExecutionScopeReleased() {
      scheduleCurrentTargetSync(ctx)
    },
    async onExecutionWindowSelected(windowId, commandContext) {
      if (commandContext) {
        await awaitWithDeadline(commandContext, 'background.selectionReady', () => selection.ready)
      } else {
        await selection.ready
      }
      selection.selectWindow(windowId)
    },
  })
  selection = createRuntimeSelection(mgr, trySendToRelay, () => {
    const relay = getRelayConnectionSnapshot()
    return relay.transportOpen && relay.handshakeReady
  })
  const handleCdp = createDispatcher(mgr, scheduler)
  const tabsReady = (async () => {
    await selection.ready
    if (!(await mgr.loadTabs())) throw new Error('Failed to restore tab registry')
    if (!(await mgr.reconcileTabs())) throw new Error('Failed to reconcile tab registry')
  })()
  // Native listeners must be installed synchronously on every MV3 worker wake-up.
  const { resyncDownloads, clearDownloadWatches } = initDownloadTracker(sendToRelay)
  const ctx = {
    mgr, selection, handleCdp, tabsReady,
    tabsReadyBarrier: { current: tabsReady, state: 'restoring', error: null },
    resyncGeneration: null,
    currentTargetSync: null,
    resyncDownloads, clearDownloadWatches,
  }
  setTabsReadiness(ctx, tabsReady, 'restoring')
  return ctx
}

function setTabsReadiness({ tabsReadyBarrier }, readiness, state) {
  tabsReadyBarrier.current = readiness
  tabsReadyBarrier.state = state
  tabsReadyBarrier.error = null
  // Observe failures without replacing the rejecting barrier used by commands.
  void readiness.then(() => {
    if (tabsReadyBarrier.current !== readiness) return
    tabsReadyBarrier.state = 'ready'
  }, (error) => {
    if (tabsReadyBarrier.current !== readiness) return
    tabsReadyBarrier.state = 'failed'
    tabsReadyBarrier.error = error instanceof Error ? error.message : String(error)
    log.warn('tab readiness failed:', error)
  })
  return readiness
}

function isCurrentTransport(generation) {
  const relay = getRelayConnectionSnapshot()
  return relay.transportOpen && relay.handshakeReady && relay.transportGeneration === generation
}

async function awaitTabsReadiness(ctx, commandContext) {
  const readiness = ctx.tabsReadyBarrier.current
  const generation = getRelayConnectionSnapshot().transportGeneration
  if (commandContext) {
    await awaitWithDeadline(commandContext, 'background.tabsReady', () => readiness)
  } else {
    await readiness
  }
  if (!isCurrentTransport(generation) || readiness !== ctx.tabsReadyBarrier.current) {
    throw new Error('Relay connection changed while waiting for tab resync')
  }
  return generation
}

function scheduleCurrentTargetSync(ctx) {
  const generation = getRelayConnectionSnapshot().transportGeneration
  if (ctx.resyncGeneration !== generation || !isCurrentTransport(generation)) return
  if (ctx.currentTargetSync?.generation === generation) {
    ctx.currentTargetSync.dirty = true
    return
  }
  const readiness = ctx.tabsReadyBarrier.current
  const pending = { generation, dirty: true }
  ctx.currentTargetSync = pending
  const sync = (async () => {
    await readiness
    do {
      pending.dirty = false
      if (!isCurrentTransport(generation)) throw new Error('Relay connection changed during scope sync')
      await ctx.selection.syncCurrentTarget({ isCurrent: () => isCurrentTransport(generation) })
    } while (pending.dirty)
  })()
  const clearPending = () => {
    if (ctx.currentTargetSync === pending) ctx.currentTargetSync = null
  }
  void sync.then(clearPending, clearPending)
  setTabsReadiness(ctx, sync, 'syncing')
}

function initializeRelay(ctx) {
  const { mgr, selection, handleCdp, tabsReady, resyncDownloads, clearDownloadWatches } = ctx
  initRelay({
    async onMessage(msg, commandContext) {
      await awaitTabsReadiness(ctx, commandContext)
      return handleCdp(msg, commandContext)
    },
    onControlMessage(msg) {
      if (msg?.method === 'Extension.helloAck') {
        selection.mirror(msg.params)
        return
      }
      if (msg?.method === 'Extension.selectionChanged' && selection.mirror(msg.params)) {
        // Broadcasts also follow discovery/reconcile: they never prove manual intent.
        scheduleCurrentTargetSync(ctx)
      }
    },
    async onShutdown(reason) {
      ctx.resyncGeneration = null
      mgr.beginTabsResync()
      if (reason === 'connectionLost') {
        mgr.stopSessionIndicators()
        return
      }
      const dissolveGroup = await getSetting(SETTINGS_KEYS.CLOSE_GROUP_ON_DISABLE)
      const cleanup = await Promise.allSettled([
        clearDownloadWatches(),
        mgr.shutdown({ dissolveGroup }),
      ])
      const failure = cleanup.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    },
    onConnected() {
      const epoch = mgr.beginTabsResync()
      const generation = getRelayConnectionSnapshot().transportGeneration
      ctx.resyncGeneration = generation
      const isCurrent = () => isCurrentTransport(generation) && mgr.isTabsResyncCurrent(epoch)
      const resync = (async () => {
        await tabsReady
        if (!isCurrent()) throw new Error('Relay connection changed before tab resync')
        mgr.startSessionIndicators()
        if (!(await mgr.discoverAll(isCurrent))) throw new Error('Tab discovery was superseded')
        await selection.syncCurrentTarget({ isCurrent })
        if (!isCurrent()) throw new Error('Relay connection changed during tab resync')
        if (!mgr.resyncAttachedTabs({ epoch, authoritative: true })) {
          throw new Error('Authoritative tab resync was superseded')
        }
        // Attachment events must precede currentTargetChanged on a fresh server connection.
        const currentTab = mgr.listTabSnapshots().find((tab) =>
          tab.active && tab.state === 'connected' && selection.isSelectedWindow(tab.windowId))
        selection.announceCurrentTarget(currentTab?.tabId)
        void resyncDownloads().catch((error) => log.warn('download resync failed:', error))
      })()
      return setTabsReadiness(ctx, resync, 'resyncing')
    },
  })
}

function registerDebuggerListeners({ mgr, tabsReady, selection }) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void tabsReady.then(() => mgr.onDebuggerEvent(source, method, params))
      .catch((error) => log.warn('debugger event handling failed:', method, error))
  })
  chrome.debugger.onDetach.addListener((source, reason) => {
    void tabsReady.then(async () => {
      const entry = mgr.get(source.tabId)
      const windowId = entry?.windowId
      const detached = await mgr.onDebuggerDetach(source, reason, { recover: isRelayConnected })
      if (detached && reason === 'canceled_by_user' && selection.isSelectedWindow(windowId)) {
        selection.announceCurrentTarget()
      }
    }).catch((error) => log.warn('debugger detach handling failed:', error))
  })
}

function registerTabLifecycleListeners(ctx) {
  const { mgr, selection, tabsReady } = ctx
  const schedule = (task) => {
    void tabsReady.then(task).catch((error) => log.warn('tab lifecycle handling failed:', error))
  }
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (!isRelayConnected() && !isReconnecting()) {
      void (async () => {
        if (!(await isRelayEnabled()) || isRelayConnected() || isReconnecting()) return
        await connectAndAttach()
      })().catch((error) => log.warn('tab activation relay connection failed:', error))
    }
    schedule(async () => {
      mgr.setActiveTab(tabId, windowId)
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (tab && mgr.has(tabId)) {
        mgr.updateTab(tabId, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
      }
      if (selection.isSelectedWindow(windowId) && isRelayConnected()) {
        scheduleCurrentTargetSync(ctx)
        return
      }
    })
  })

  registerTabDiscoveryListeners(chrome.tabs, mgr, isRelayConnected, {
    schedule,
    onUpdated: (tabId, changeInfo) => {
      const pageChanged = changeInfo.url !== undefined
      const faviconChanged = changeInfo.favIconUrl !== undefined && !isAgentClaimFavicon(changeInfo.favIconUrl)
      if (pageChanged || faviconChanged) clearAgentClaimFaviconCache(tabId)
      return pageChanged || changeInfo.status === 'complete' || faviconChanged
    },
  })
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!tab.active || !selection.isSelectedWindow(tab.windowId)) return
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return
    schedule(() => scheduleCurrentTargetSync(ctx))
  })
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    schedule(async () => {
      mgr.recordNavigationTarget(details.tabId, details.sourceTabId)
      const tab = await chrome.tabs.get(details.tabId).catch(() => null)
      if (!tab) return
      mgr.discover(tab.id, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
    })
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearAgentClaimFaviconCache(tabId)
    schedule(async () => {
      const windowId = mgr.get(tabId)?.windowId
      mgr.removeNavigationTarget(tabId)
      await mgr.close(tabId, 'tab-closed', { closedBy: 'external' })
      if (selection.isSelectedWindow(windowId)) scheduleCurrentTargetSync(ctx)
    })
  })
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    clearAgentClaimFaviconCache(removedTabId)
    schedule(async () => {
      const windowId = mgr.get(removedTabId)?.windowId
      await mgr.handleTabReplaced(addedTabId, removedTabId)
      if (selection.isSelectedWindow(windowId)) scheduleCurrentTargetSync(ctx)
    })
  })
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return
    schedule(async () => {
      const tabs = await chrome.tabs.query({ active: true, windowId })
      const tab = tabs.find((entry) => Number.isInteger(entry.id))
      if (tab) {
        mgr.setActiveTab(tab.id, windowId)
        mgr.updateTab(tab.id, tab.url, tab.title, { windowId, active: true })
      }
      if (selection.isSelectedWindow(windowId)) scheduleCurrentTargetSync(ctx)
    })
  })
}

function registerAlarmListeners({ mgr, tabsReady }) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (handleConnectionAlarm(alarm.name)) return
    if (mgr.handleIndicatorAlarm(alarm.name)) return
    if (alarm.name !== 'relayKeepAlive') return
    if (isRelayConnected()) {
      trySendToRelay({ method: 'ping' })
      void tabsReady.then(() => mgr.performHealthCheck())
        .catch((error) => log.warn('tab health check failed:', error))
      return
    }
    void (async () => {
      await initFromStorage()
      if (!(await isRelayEnabled()) || isReconnecting() || await hasPendingReconnectAlarm()) return
      await reconnectNow()
    })().catch((error) => log.warn('relay keepAlive reconnect check failed:', error))
  })
}

function registerRuntimeLifecycleListeners() {
  chrome.runtime.onStartup.addListener(() => {
    void (async () => {
      await initFromStorage()
      if (await isRelayEnabled()) await connectAndAttach()
    })().catch((error) => log.warn('browser startup relay connection failed:', error))
  })
  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      if (details.reason === 'install') {
        await setRelayEnabled(true)
        void chrome.runtime.openOptionsPage()
      }
      if (!(await isRelayEnabled())) return
      await ensureKeepAliveAlarm()
      await connectAndAttach()
    })().catch((error) => log.warn('extension installation relay connection failed:', error))
  })
}

function registerRuntimeMessageListeners(ctx) {
  const { mgr, selection, tabsReadyBarrier } = ctx
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'getLogs') {
      const limit = Math.max(1, Math.min(100, Number(msg.limit) || 100))
      const logs = [...getLogBuffer(limit), ...getCommandDiagnostics(limit)]
        .sort((a, b) => a.ts - b.ts)
        .slice(-limit)
      sendResponse({ logs })
      return false
    }
    const respond = (operation) => {
      void operation().then(sendResponse, (error) => {
        log.warn('runtime message failed:', msg.type, error)
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }).catch((error) => log.warn('runtime response channel closed:', error))
      return true
    }
    if (msg?.type === 'toggleRelay') {
      return respond(async () => {
        try {
          await toggle()
          return { state: getRelayConnectionSnapshot().state }
        } catch (error) {
          log.warn('toggleRelay failed:', error)
          return { state: getRelayConnectionSnapshot().state, error: error instanceof Error ? error.message : String(error) }
        }
      })
    }
    if (msg?.type === 'openInstallGuide') {
      const lang = typeof msg.lang === 'string' && msg.lang ? msg.lang : 'en'
      const url = chrome.runtime.getURL(`pages/install-extension.html?lang=${encodeURIComponent(lang)}`)
      void chrome.tabs.create({ url }).catch((error) => log.warn('install guide opening failed:', error))
      sendResponse({ ok: true })
      return false
    }
    if (msg?.type === 'getRelayStatus') {
      return respond(async () => {
        await selection.ready
        const tabs = await chrome.tabs.query({})
        return {
          ...getRelayConnectionSnapshot(),
          ...selection.snapshot(),
          tabCount: tabs.length,
          totalTabs: tabs.length,
          attachedTabs: mgr.size,
          agentTabs: mgr.agentTabCount,
          retainedTabs: mgr.retainedTabCount,
          tabsReady: tabsReadyBarrier.state === 'ready',
          tabSyncState: tabsReadyBarrier.state,
          tabSyncError: tabsReadyBarrier.error,
        }
      })
    }
    if (msg?.type === 'getTabList') {
      sendResponse({ tabs: selection.listTabs() })
      return false
    }
    if (msg?.type === 'getBrowserInstanceList') {
      return respond(async () => {
        await selection.ready
        return {
          browserInstances: selection.listBrowserInstances(),
          selectedBrowserInstanceId: selection.snapshot().selectedBrowserInstanceId,
          selectedWindowId: selection.getSelectedWindowId(),
        }
      })
    }
    if (msg?.type === 'selectExecutionWindow' || msg?.type === 'attachTab') {
      return respond(async () => {
        const isWindowSelection = msg.type === 'selectExecutionWindow'
        const id = Number(isWindowSelection ? msg.windowId : msg.tabId)
        if (!Number.isInteger(id) || (isWindowSelection ? id < 0 : id <= 0)) {
          throw new Error(isWindowSelection ? 'Invalid windowId' : 'Invalid tabId')
        }
        const commandContext = createCommandContext({ method: `Extension.${msg.type}` })
        const generation = await awaitTabsReadiness(ctx, commandContext)
        const isCurrent = () => isCurrentTransport(generation)
        if (!isWindowSelection) {
          const attached = await selection.attachTab(id, commandContext, isCurrent)
          return { ok: true, attached }
        }
        const window = await awaitWithDeadline(commandContext, 'chrome.windows.get:selection', () => chrome.windows.get(id))
        if (!isCurrent()) throw new Error('Relay connection changed while selecting a window')
        selection.selectWindow(window.id)
        await selection.syncCurrentTarget({ manual: true, commandContext, isCurrent })
        if (!isCurrent()) throw new Error('Relay connection changed while selecting a window')
        return { ok: true, ...selection.snapshot() }
      })
    }
    return false
  })
}
