/**
 * TabManager — Lazy Attach architecture.
 *
 * Encapsulates all tab state: discovery, lazy physical attach, agent tracking.
 *
 * Tab lifecycle:
 *   virtual   → discovered by chrome.tabs.query, no chrome.debugger session
 *   attaching → chrome.debugger.attach() in flight
 *   connected → physically attached via chrome.debugger
 *
 * Relay notifications:
 *   Extension.tabDiscovered        — virtual tab discovered (relay stores, Playwright ignores)
 *   Extension.tabUpdated           — virtual tab metadata (title/url) changed
 *   Extension.tabRemoved           — virtual tab removed from cache
 *   Target.attachedToTarget        — physical debugger attached (Playwright sees this)
 *   Target.detachedFromTarget      — physical debugger detached (Playwright sees this)
 *
 * Delegates to:
 *   SessionIndicators  — idle tab detection
 */

import { TabType } from '../../constants.js'
import { createLogger } from '../../logger.js'
import { attachDebugger, detachDebugger, detachAll } from './debugger-attach.js'
import { SessionIndicators } from './session-indicators.js'
import { cleanupTabQueue, cleanupAllTabQueues } from '../commands/dispatch.js'
import { interceptEvent } from '../events/index.js'

const log = createLogger('tabs')

const TAB_MANAGER_STATE_KEY = 'accio_tabManagerState'
const ALARM_TAB_RECOVERY = 'relayTabRecovery'
const REATTACH_BASE_DELAY_MS = 1_000
const REATTACH_MAX_DELAY_MS = 30_000

const DEBUGGABLE_URL_RE = /^(https?|file):\/\//

function isDebuggableUrl(url) {
  if (!url) return false
  return DEBUGGABLE_URL_RE.test(url) || url === 'about:blank'
}

function toNullableNumber(value) {
  return Number.isInteger(value) ? value : null
}

export class TabManager {
  /** @type {Map<number, {state: string, sessionId: string, targetKey: string, targetId: string, url?: string, title?: string, windowId?: number|null, active?: boolean}>} */
  #tabs = new Map()
  /** @type {Map<string, number>} sessionId → tabId */
  #bySession = new Map()
  /** @type {Map<string, number>} targetId → tabId */
  #byTarget = new Map()
  /** @type {Map<string, number>} child sessionId → parent tabId */
  #childSession = new Map()
  /** @type {Map<number, Set<string>>} parent tabId → child sessionIds */
  #childSets = new Map()
  /** @type {Map<number, string>} tabId → TabType */
  #agentTabs = new Map()
  /** @type {Set<number>} */
  #autoAttachBlocked = new Set()
  /** @type {Set<number>} */
  #expectedDetach = new Set()
  /** @type {Map<number, Promise<boolean>>} tabId → pending attach promise */
  #pending = new Map()
  /** @type {Map<number, number>} */
  #attachGeneration = new Map()
  /** @type {Map<number, {attempt: number, nextAttemptAt: number, reason: string}>} */
  #recovery = new Map()
  #retainedCount = 0
  /** @type {boolean} */
  #shuttingDown = false
  /** @type {boolean} */
  #restored = false
  /** @type {Promise<void>|null} */
  #restorePromise = null
  /** @type {boolean} */
  #persistScheduled = false
  /** @type {Promise<void>} */
  #persistChain = Promise.resolve()
  /** @type {boolean} */
  #recoveryRunning = false
  /** @type {boolean} */
  #healthCheckRunning = false
  /** @type {Promise<unknown>} */
  #executionScopeChain = Promise.resolve()
  /** @type {(payload: any) => void} */
  #sendToRelay
  /** @type {() => string} */
  #getBrowserInstanceId
  /** @type {() => number|null} */
  #getSelectedWindowId
  /** @type {() => boolean} */
  #getIsCurrentBrowserSelected

  /** @type {SessionIndicators} */
  #indicators

  /**
   * @param {(payload: any) => void} sendToRelay — fire-and-forget relay send function
   */
  constructor(sendToRelay, options = {}) {
    this.#sendToRelay = sendToRelay
    this.#getBrowserInstanceId = typeof options.getBrowserInstanceId === 'function'
      ? options.getBrowserInstanceId
      : () => 'browser-instance'
    this.#getSelectedWindowId = typeof options.getSelectedWindowId === 'function'
      ? options.getSelectedWindowId
      : () => null
    this.#getIsCurrentBrowserSelected = typeof options.getIsCurrentBrowserSelected === 'function'
      ? options.getIsCurrentBrowserSelected
      : () => true
    this.#indicators = new SessionIndicators({
      getTabEntries: () => this.#tabs.entries(),
      detachTab: (tabId, reason) => void this.detach(tabId, reason),
    })
  }

  // ── CDP command tracking (forwarded from dispatch) ──

  onCdpCommand(tabId) {
    this.#indicators.trackCommand(tabId)
  }

  // ── Session lifecycle ──

  startSessionIndicators() {
    this.#indicators.start()
  }

  stopSessionIndicators() {
    this.#indicators.stop()
  }

  handleIndicatorAlarm(alarmName) {
    return this.#indicators.handleAlarm(alarmName)
  }

  handleMaintenanceAlarm(alarmName) {
    if (alarmName !== ALARM_TAB_RECOVERY) return false
    void this.#runRecoveryPass()
    return true
  }

  handleTransportClosed() {
    this.stopSessionIndicators()
    chrome.alarms.clear(ALARM_TAB_RECOVERY)
    this.#schedulePersist()
  }

  async restoreState() {
    if (this.#restored) return
    if (this.#restorePromise) {
      await this.#restorePromise
      return
    }

    this.#restorePromise = (async () => {
      this.#restored = true
      if (this.#tabs.size > 0 || this.#agentTabs.size > 0 || this.#autoAttachBlocked.size > 0) return

      try {
        const stored = await chrome.storage.session.get(TAB_MANAGER_STATE_KEY)
        const snapshot = stored[TAB_MANAGER_STATE_KEY]
        if (!snapshot || typeof snapshot !== 'object') return

        const currentTabs = await chrome.tabs.query({})
        const currentById = new Map(
          currentTabs
            .filter((tab) => Number.isInteger(tab?.id))
            .map((tab) => [tab.id, tab]),
        )

        const rawTabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : []
        for (const raw of rawTabs) {
          const tabId = Number(raw?.tabId)
          const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : ''
          const targetKey = typeof raw?.targetKey === 'string' ? raw.targetKey : ''
          const targetId = typeof raw?.targetId === 'string' ? raw.targetId : ''
          if (!Number.isInteger(tabId) || tabId <= 0 || !sessionId || !targetId || !targetKey) continue
          if (this.#tabs.has(tabId) || this.#bySession.has(sessionId) || this.#byTarget.has(targetId)) continue

          const current = currentById.get(tabId)
          const url = current?.url ?? raw?.url
          const title = current?.title ?? raw?.title
          if (!isDebuggableUrl(url)) continue

          const state = raw?.state === 'connected' || raw?.state === 'attaching'
            ? raw.state
            : 'virtual'
          this.#tabs.set(tabId, {
            state,
            sessionId,
            targetKey,
            targetId,
            url,
            title,
            windowId: toNullableNumber(current?.windowId ?? raw?.windowId),
            active: current?.active === true || raw?.active === true,
          })
          this.#bySession.set(sessionId, tabId)
          this.#byTarget.set(targetId, tabId)
        }

        const rawAgents = Array.isArray(snapshot.agentTabs) ? snapshot.agentTabs : []
        for (const raw of rawAgents) {
          const tabId = Number(raw?.tabId)
          const type = raw?.type === TabType.RETAINED ? TabType.RETAINED : TabType.AGENT
          if (!Number.isInteger(tabId) || !this.#tabs.has(tabId)) continue
          this.#agentTabs.set(tabId, type)
          if (type === TabType.RETAINED) this.#retainedCount++
        }

        const rawAutoAttachBlocked = Array.isArray(snapshot.autoAttachBlocked)
          ? snapshot.autoAttachBlocked
          : []
        for (const id of rawAutoAttachBlocked) {
          const tabId = Number(id)
          if (Number.isInteger(tabId) && tabId > 0) this.#autoAttachBlocked.add(tabId)
        }
      } catch (err) {
        log.warn('restoreState failed:', err)
      }
    })()

    try {
      await this.#restorePromise
    } finally {
      this.#restorePromise = null
    }
  }

  async refreshAfterTransportReady() {
    await this.restoreState()

    const currentTabs = await chrome.tabs.query({})
    const currentById = new Map(
      currentTabs
        .filter((tab) => Number.isInteger(tab?.id))
        .map((tab) => [tab.id, tab]),
    )

    const toRemove = []
    const toDiscover = []
    const toAttach = []

    for (const [tabId, entry] of this.#tabs) {
      const current = currentById.get(tabId)
      if (!current) {
        toRemove.push(tabId)
        continue
      }

      entry.url = current.url ?? entry.url
      entry.title = current.title ?? entry.title
      entry.windowId = toNullableNumber(current.windowId)
      entry.active = current.active === true

      if (!isDebuggableUrl(entry.url)) {
        toRemove.push(tabId)
        continue
      }

      if (!this.#shouldAutoAttachEntry(tabId, entry)) {
        this.#setEntryVirtual(tabId, entry)
        toDiscover.push(tabId)
        continue
      }

      if (entry.state === 'connected' || entry.state === 'attaching') {
        const attached = await this.#recoverPhysicalConnection(tabId, entry)
        if (attached) {
          this.#clearRecovery(tabId)
          toAttach.push(tabId)
        } else {
          await this.#scheduleRecovery(tabId, 'connection-restored', { tab: current, emitDetached: false })
          toDiscover.push(tabId)
        }
        continue
      }

      entry.state = 'virtual'
      toDiscover.push(tabId)
    }

    for (const tabId of toRemove) {
      this.#removeEntry(tabId)
    }

    for (const tabId of toDiscover) {
      const entry = this.#tabs.get(tabId)
      if (entry) this.#emitDiscovered(entry)
    }

    for (const tabId of toAttach) {
      const entry = this.#tabs.get(tabId)
      if (entry) this.#emitAttached(entry)
    }
    this.#schedulePersist()
  }

  async shutdown() {
    return this.clearAll()
  }

  // ── Tab state queries ──

  get size() { return this.#tabs.size }
  has(tabId) { return this.#tabs.has(tabId) }
  get(tabId) { return this.#tabs.get(tabId) }
  entries() { return this.#tabs.entries() }

  get agentTabCount() { return this.#agentTabs.size }
  get retainedTabCount() { return this.#retainedCount }
  get agentTabs() { return this.#agentTabs }
  get browserInstanceId() { return this.#getBrowserInstanceId() }
  get selectedWindowId() { return this.#getSelectedWindowId() }
  get isCurrentBrowserSelected() { return this.#getIsCurrentBrowserSelected() }

  // ── Lookup ──

  getBySessionId(sessionId) {
    const direct = this.#bySession.get(sessionId)
    if (direct !== undefined) return { tabId: direct, kind: 'main' }
    const child = this.#childSession.get(sessionId)
    if (child !== undefined) return { tabId: child, kind: 'child' }
    return null
  }

  getByTargetId(targetId) {
    return this.#byTarget.get(targetId) ?? null
  }

  resolveSelectedPhysicalTarget() {
    if (!this.isCurrentBrowserSelected) return null
    const selectedWindowId = this.selectedWindowId
    for (const [tabId, entry] of this.#tabs) {
      if (
        entry.active === true
        && entry.state === 'connected'
        && Number.isInteger(selectedWindowId)
        && entry.windowId === selectedWindowId
      ) {
        return {
          tabId,
          sessionId: entry.sessionId,
          targetId: entry.targetId,
          targetKey: entry.targetKey,
          windowId: entry.windowId ?? null,
        }
      }
    }
    return null
  }

  resolveTabId(sessionId, targetId) {
    if (sessionId) {
      const found = this.getBySessionId(sessionId)
      if (found) return found.tabId
    }
    if (targetId) {
      const found = this.getByTargetId(targetId)
      if (found !== null) return found
    }
    return null
  }

  // ── Auto-attach block tracking (persisted to session storage) ──

  markAutoAttachBlocked(tabId) {
    this.#autoAttachBlocked.add(tabId)
    this.#schedulePersist()
  }

  isAutoAttachBlocked(tabId) { return this.#autoAttachBlocked.has(tabId) }

  clearAutoAttachBlocked(tabId) {
    this.#autoAttachBlocked.delete(tabId)
    this.#schedulePersist()
  }

  async reconcileExecutionScope(activeTabId = null, reason = 'execution-scope-changed') {
    await this.applyExecutionScope(activeTabId, { reason })
  }

  async applyExecutionScope(activeTabId = null, options = {}) {
    const manual = options.manual === true
    const reason = typeof options.reason === 'string' && options.reason
      ? options.reason
      : 'execution-scope-changed'

    const run = async () => {
      for (const [tabId, entry] of this.#tabs) {
        if (this.#shouldKeepEntryAttached(tabId, entry, activeTabId, manual)) {
          continue
        }

        if (entry.state === 'connected' || entry.state === 'attaching') {
          await this.#detachEntryToVirtual(tabId, entry, reason)
          continue
        }

        this.#setEntryVirtual(tabId, entry)
      }

      if (Number.isInteger(activeTabId) && await this.#shouldAttachTabForScope(activeTabId, manual)) {
        return await this.attach(activeTabId, { manual })
      }

      this.#schedulePersist()
      return null
    }

    const scopeRun = this.#executionScopeChain.then(run, run)
    this.#executionScopeChain = scopeRun.then(
      () => undefined,
      () => undefined,
    )
    return await scopeRun
  }

  // ── Agent tab tracking ──

  markAgent(tabId, retain = false) {
    const prev = this.#agentTabs.get(tabId)
    const next = retain ? TabType.RETAINED : TabType.AGENT
    this.#agentTabs.set(tabId, next)
    if (next === TabType.RETAINED && prev !== TabType.RETAINED) this.#retainedCount++
    else if (next !== TabType.RETAINED && prev === TabType.RETAINED) this.#retainedCount--
    this.#schedulePersist()
  }

  deleteAgent(tabId) {
    const prev = this.#agentTabs.get(tabId)
    if (prev === undefined) return
    if (prev === TabType.RETAINED) this.#retainedCount--
    this.#agentTabs.delete(tabId)
    this.#schedulePersist()
  }

  isAgent(tabId) { return this.#agentTabs.has(tabId) }
  isRetained(tabId) { return this.#agentTabs.get(tabId) === TabType.RETAINED }

  // ── Discovery (virtual registration) ──

  async discoverAll(isConnected) {
    const t0 = performance.now()
    if (!isConnected()) return

    const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] })
    log.debug('discoverAll: query took', (performance.now() - t0).toFixed(1), 'ms,', allTabs.length, 'tabs')

    let count = 0
    for (const tab of allTabs) {
      if (!tab.id || this.#tabs.has(tab.id)) continue
      this.#registerVirtual(tab.id, tab.url, tab.title, {
        windowId: tab.windowId ?? null,
        active: tab.active === true,
      })
      count++
    }
    log.info('discoverAll: registered', count, 'virtual tabs in', (performance.now() - t0).toFixed(1), 'ms')
  }

  discover(tabId, url, title, tabMeta = {}) {
    if (!this.#tabs.has(tabId) && isDebuggableUrl(url)) {
      this.#registerVirtual(tabId, url, title, tabMeta)
      log.debug('discover: registered virtual tab', tabId)
    }
  }

  /**
   * Update a tracked tab's URL and/or title.
   * Sends Extension.tabUpdated to the relay so the agent side stays in sync.
   */
  updateTab(tabId, url, title, tabMeta = {}) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return

    let changed = false
    if (url !== undefined && url !== entry.url) { entry.url = url; changed = true }
    if (title !== undefined && title !== entry.title) { entry.title = title; changed = true }
    if ('windowId' in tabMeta) {
      const nextWindowId = toNullableNumber(tabMeta.windowId)
      if (nextWindowId !== entry.windowId) { entry.windowId = nextWindowId; changed = true }
    }
    if ('active' in tabMeta) {
      const nextActive = tabMeta.active === true
      if (nextActive !== entry.active) { entry.active = nextActive; changed = true }
    }
    if (!changed) return

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabUpdated',
        params: {
          sessionId: entry.sessionId,
          tabId,
          windowId: entry.windowId ?? null,
          active: entry.active === true,
          targetKey: entry.targetKey,
          targetInfo: {
            targetId: entry.targetId, type: 'page',
            title: entry.title || '', url: entry.url || '',
            attached: entry.state === 'connected',
          },
        },
      },
    })
    this.#schedulePersist()
  }

  #registerVirtual(tabId, url, title, tabMeta = {}) {
    if (this.#tabs.has(tabId)) return

    const sessionId = this.#buildSessionId(tabId)
    const targetKey = this.#buildTargetKey(tabId)
    const targetId = targetKey

    this.#tabs.set(tabId, {
      state: 'virtual',
      sessionId,
      targetKey,
      targetId,
      url,
      title,
      windowId: toNullableNumber(tabMeta.windowId),
      active: tabMeta.active === true,
    })
    this.#bySession.set(sessionId, tabId)
    this.#byTarget.set(targetId, tabId)
    this.#emitDiscovered(this.#tabs.get(tabId))
    this.#schedulePersist()
  }

  // ── Lazy Attach (on-demand physical attachment) ──

  async ensureAttached(tabId, options = {}) {
    const manual = options.manual === true
    this.#expectedDetach.delete(tabId)
    if (this.#autoAttachBlocked.has(tabId) && !manual) {
      log.info('ensureAttached: auto-attach blocked for tab', tabId)
      return false
    }
    if (manual) {
      this.clearAutoAttachBlocked(tabId)
    }
    const entry = this.#tabs.get(tabId)
    if (!entry) { log.warn('ensureAttached: tab not tracked', tabId); return false }
    if (entry.state === 'connected') return true
    if (entry.state === 'attaching') {
      const p = this.#pending.get(tabId)
      if (p) return p
    }

    const promise = this.#physicalAttach(tabId, entry)
    this.#pending.set(tabId, promise)
    try { return await promise } finally { this.#pending.delete(tabId) }
  }

  async #physicalAttach(tabId, entry) {
    const t0 = performance.now()
    if (this.#shuttingDown) return false
    const attachGeneration = (this.#attachGeneration.get(tabId) ?? 0) + 1
    this.#attachGeneration.set(tabId, attachGeneration)
    entry.state = 'attaching'
    log.info('physicalAttach: begin', tabId)

    try {
      if (this.#shuttingDown) return false
      const { realTargetId } = await attachDebugger(tabId)
      log.info('physicalAttach: debugger attached', {
        tabId,
        sessionId: entry.sessionId,
        previousTargetId: entry.targetId,
        realTargetId: realTargetId || null,
        url: entry.url || '',
      })

      // Guard: tab may have been removed by clearAll/detach while we were awaiting
      if (!this.#tabs.has(tabId) || this.#attachGeneration.get(tabId) !== attachGeneration) {
        log.warn('physicalAttach: tab removed during attach, cleaning up', tabId)
        void this.#detachPhysicalDebugger(tabId)
        return false
      }

      if (realTargetId && realTargetId !== entry.targetId) {
        this.#byTarget.delete(entry.targetId)
        entry.targetId = realTargetId
        this.#byTarget.set(realTargetId, tabId)
      }

      entry.state = 'connected'
      this.#clearRecovery(tabId)

      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: entry.sessionId,
            tabId,
            windowId: entry.windowId ?? null,
            active: entry.active === true,
            targetKey: entry.targetKey,
            targetInfo: {
              targetId: entry.targetId, type: 'page',
              title: entry.title || '', url: entry.url || '', attached: true,
            },
            waitingForDebugger: false,
          },
        },
      })
      log.info('physicalAttach: emitted Target.attachedToTarget', {
        tabId,
        sessionId: entry.sessionId,
        targetKey: entry.targetKey,
        targetId: entry.targetId,
        windowId: entry.windowId ?? null,
        active: entry.active === true,
        url: entry.url || '',
      })

      log.info('physicalAttach: done', tabId, 'in', (performance.now() - t0).toFixed(1), 'ms')
      this.#schedulePersist()
      return true
    } catch (err) {
      log.warn('physicalAttach: failed', tabId, (performance.now() - t0).toFixed(1), 'ms', err)
      void this.#detachPhysicalDebugger(tabId)
      if (this.#tabs.has(tabId)) entry.state = 'virtual'
      this.#schedulePersist()
      return false
    }
  }

  async attach(tabId, options = {}) {
    const manual = options.manual === true
    if (this.#autoAttachBlocked.has(tabId) && !manual) {
      log.info('attach: auto-attach blocked for tab', tabId)
      return null
    }
    const existing = this.#tabs.get(tabId)
    if (existing?.state === 'connected') {
      if (manual) {
        this.clearAutoAttachBlocked(tabId)
      }
      log.debug('attach: already connected', tabId)
      return existing
    }

    const wasNew = !existing
    if (wasNew) {
      let url, title
      let windowId = null
      let active = false
      try {
        const tab = await chrome.tabs.get(tabId)
        url = tab.url; title = tab.title
        windowId = toNullableNumber(tab.windowId)
        active = tab.active === true
      } catch { /* tab may have closed */ }
      const sessionId = this.#buildSessionId(tabId)
      const targetKey = this.#buildTargetKey(tabId)
      const targetId = targetKey
      this.#tabs.set(tabId, { state: 'virtual', sessionId, targetKey, targetId, url, title, windowId, active })
      this.#bySession.set(sessionId, tabId)
      this.#byTarget.set(targetId, tabId)
    }

    const ok = await this.ensureAttached(tabId, { manual })
    if (!ok) {
      if (wasNew && this.#tabs.has(tabId)) this.#removeEntry(tabId)
      return null
    }

    const entry = this.#tabs.get(tabId)
    return entry ? { sessionId: entry.sessionId, targetId: entry.targetId } : null
  }

  // ── Detach ──

  async detach(tabId, reason) {
    const t0 = performance.now()
    const entry = this.#tabs.get(tabId)
    log.info('detach:', tabId, reason, 'state:', entry?.state)

    const wasPhysical = entry?.state === 'connected' || entry?.state === 'attaching'
    if (wasPhysical) {
      await this.#detachPhysicalDebugger(tabId)
      log.debug('detach: chrome.debugger cleanup', tabId, (performance.now() - t0).toFixed(1), 'ms')
    }

    if (entry?.sessionId) {
      if (wasPhysical && entry.targetId) {
        this.#sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: entry.sessionId, targetId: entry.targetId, reason },
          },
        })
      } else {
        this.#notifyRemoved(entry.sessionId)
      }
    }

    this.#removeEntry(tabId)
    this.#schedulePersist()
  }

  clearAll() {
    const t0 = performance.now()
    this.#shuttingDown = true
    this.stopSessionIndicators()

    const physical = []
    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected' || entry.state === 'attaching') {
        physical.push(tabId)
      }
    }

    log.info('clearAll:', this.#tabs.size, 'total,', physical.length, 'physically attached')

    this.#tabs.clear()
    this.#bySession.clear()
    this.#byTarget.clear()
    this.#childSession.clear()
    this.#childSets.clear()
    this.#pending.clear()
    this.#recovery.clear()
    chrome.alarms.clear(ALARM_TAB_RECOVERY)
    this.#autoAttachBlocked.clear()
    void chrome.storage.session.remove(TAB_MANAGER_STATE_KEY).catch(() => {})
    this.#agentTabs.clear()
    this.#retainedCount = 0
    this.#indicators.clear()
    cleanupAllTabQueues()

    const settled = detachAll(physical)
    settled.then(() => {
      this.#shuttingDown = false
      log.info('clearAll: done in', (performance.now() - t0).toFixed(1), 'ms')
    })
    return settled
  }

  // ── Debugger event handlers ──

  onDebuggerEvent(source, method, params) {
    const tabId = source.tabId
    if (!tabId) return
    const tab = this.#tabs.get(tabId)
    if (!tab?.sessionId) return

    const result = interceptEvent(method, tabId, params, {
      childSession: this.#childSession,
      childSets: this.#childSets,
      log,
    })

    if (result.suppress) return

    if (
      method === 'Target.attachedToTarget'
      || method === 'Target.detachedFromTarget'
      || method === 'Target.targetInfoChanged'
    ) {
      log.info('onDebuggerEvent forwarding target event', {
        tabId,
        sourceSessionId: source.sessionId || null,
        method,
        eventSessionId: typeof params?.sessionId === 'string' ? params.sessionId : null,
        eventTargetId:
          typeof params?.targetId === 'string'
            ? params.targetId
            : typeof params?.targetInfo?.targetId === 'string'
              ? params.targetInfo.targetId
              : null,
      })
    }

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: { sessionId: source.sessionId || tab.sessionId, method, params },
    })
  }

  async onDebuggerDetach(source, reason) {
    const tabId = source.tabId
    log.info('onDebuggerDetach:', tabId, reason, 'tracked:', this.#tabs.has(tabId))
    if (!tabId || !this.#tabs.has(tabId)) return
    if (this.#expectedDetach.delete(tabId)) return
    if (reason === 'canceled_by_user') {
      const entry = this.#tabs.get(tabId)
      if (!entry) return
      this.markAutoAttachBlocked(tabId)
      if (entry.state === 'connected' || entry.state === 'attaching') {
        this.#emitDetached(entry, reason)
      }
      this.#setEntryVirtual(tabId, entry)
      this.#schedulePersist()
      return
    }
    await this.#scheduleRecovery(tabId, reason)
  }

  async handleTabRemoved(tabId) {
    await this.detach(tabId, 'tab-closed')
    this.deleteAgent(tabId)
    this.clearAutoAttachBlocked(tabId)
  }

  async handleTabReplaced(addedTabId, removedTabId) {
    const replacementTab = await chrome.tabs.get(addedTabId).catch(() => null)

    const movedAutoAttachBlocked = this.#autoAttachBlocked.delete(removedTabId)
    if (movedAutoAttachBlocked) {
      this.#autoAttachBlocked.add(addedTabId)
    }

    const agentType = this.#agentTabs.get(removedTabId)
    if (agentType !== undefined) {
      this.#agentTabs.delete(removedTabId)
      this.#agentTabs.set(addedTabId, agentType)
    }

    const entry = this.#tabs.get(removedTabId)
    if (!entry) {
      if (!replacementTab) {
        this.deleteAgent(addedTabId)
        this.clearAutoAttachBlocked(addedTabId)
        this.#schedulePersist()
        return
      }
      if (replacementTab) {
        this.discover(addedTabId, replacementTab.url, replacementTab.title)
      }
      this.#schedulePersist()
      return
    }

    const wasPhysical = entry.state === 'connected' || entry.state === 'attaching'
    this.#moveTrackedTab(removedTabId, addedTabId, replacementTab?.url, replacementTab?.title)

    if (!replacementTab || !isDebuggableUrl(replacementTab.url)) {
      this.#notifyRemoved(entry.sessionId)
      this.#removeEntry(addedTabId)
      if (agentType === undefined) this.clearAutoAttachBlocked(addedTabId)
      this.deleteAgent(addedTabId)
      this.#schedulePersist()
      return
    }

    if (wasPhysical) {
      await this.#scheduleRecovery(addedTabId, 'tab-replaced')
      return
    }

    entry.state = 'virtual'
    this.updateTab(addedTabId, replacementTab.url, replacementTab.title)
    this.#schedulePersist()
  }

  async performHealthCheck() {
    if (this.#shuttingDown || this.#healthCheckRunning) return
    this.#healthCheckRunning = true

    try {
      const connectedTabs = [...this.#tabs.entries()]
        .filter(([tabId, entry]) => entry.state === 'connected' && this.#shouldAutoAttachEntry(tabId, entry))

      for (const [tabId, entry] of connectedTabs) {
        if (!this.#tabs.has(tabId) || this.#recovery.has(tabId)) continue
        try {
          await this.#refreshTargetInfo(tabId, entry)
        } catch {
          await this.#scheduleRecovery(tabId, 'debugger-unhealthy')
        }
      }
    } finally {
      this.#healthCheckRunning = false
    }
  }

  // ── Private helpers ──

  #buildSessionId(tabId) {
    return `cb-tab:${this.browserInstanceId}:${tabId}`
  }

  #buildTargetKey(tabId) {
    return `vtab:${this.browserInstanceId}:${tabId}`
  }

  setActiveTab(tabId, windowId = null) {
    let changed = false
    for (const [entryTabId, entry] of this.#tabs) {
      const nextActive = entryTabId === tabId
      if (entry.active !== nextActive) {
        entry.active = nextActive
        changed = true
      }
      if (entryTabId === tabId) {
        const nextWindowId = toNullableNumber(windowId ?? entry.windowId)
        if (nextWindowId !== entry.windowId) {
          entry.windowId = nextWindowId
          changed = true
        }
      }
    }
    if (changed) this.#schedulePersist()
  }

  announceCurrentTarget(tabId) {
    const entry = this.#tabs.get(tabId)
    if (!entry?.sessionId || !entry?.targetId) return

    this.#sendToRelay({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        tabId,
        windowId: entry.windowId ?? null,
      },
    })
  }

  async #recoverPhysicalConnection(tabId, entry) {
    try {
      await this.#refreshTargetInfo(tabId, entry)
      entry.state = 'connected'
      return true
    } catch {
      try {
        const { realTargetId } = await attachDebugger(tabId)
        this.#updateTargetId(tabId, entry, realTargetId)
        entry.state = 'connected'
        return true
      } catch (err) {
        log.warn('recoverPhysicalConnection failed:', tabId, err)
        return false
      }
    }
  }

  async #scheduleRecovery(tabId, reason, options = {}) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return

    const wasPhysical = entry.state === 'connected' || entry.state === 'attaching'
    const existing = this.#recovery.get(tabId)
    const tab = options.tab ?? await chrome.tabs.get(tabId).catch(() => null)

    if (!tab || !isDebuggableUrl(tab.url)) {
      this.#notifyRemoved(entry.sessionId)
      this.#removeEntry(tabId)
      this.deleteAgent(tabId)
      this.clearAutoAttachBlocked(tabId)
      this.#schedulePersist()
      return
    }

    entry.url = tab.url ?? entry.url
    entry.title = tab.title ?? entry.title
    entry.windowId = toNullableNumber(tab.windowId)
    entry.active = tab.active === true
    entry.state = 'attaching'
    this.#clearChildSessions(tabId)

    if (options.emitDetached !== false && wasPhysical && !existing) {
      this.#emitDetached(entry, reason)
    }

    const attempt = existing ? existing.attempt + 1 : 0
    const delayMs = Math.min(REATTACH_MAX_DELAY_MS, REATTACH_BASE_DELAY_MS * Math.pow(2, attempt))
    this.#recovery.set(tabId, {
      attempt,
      nextAttemptAt: Date.now() + delayMs,
      reason,
    })
    this.#ensureRecoveryAlarm()
    this.#schedulePersist()
  }

  #ensureRecoveryAlarm() {
    if (this.#recovery.size === 0) {
      chrome.alarms.clear(ALARM_TAB_RECOVERY)
      return
    }

    let nextAttemptAt = Infinity
    for (const recovery of this.#recovery.values()) {
      if (recovery.nextAttemptAt < nextAttemptAt) nextAttemptAt = recovery.nextAttemptAt
    }

    const delayInMinutes = Math.max((nextAttemptAt - Date.now()) / 60_000, 1 / 60)
    chrome.alarms.create(ALARM_TAB_RECOVERY, { delayInMinutes })
  }

  #clearRecovery(tabId) {
    if (!this.#recovery.delete(tabId)) return
    this.#ensureRecoveryAlarm()
  }

  async #runRecoveryPass() {
    if (this.#shuttingDown || this.#recoveryRunning) return
    this.#recoveryRunning = true

    try {
      const now = Date.now()
      const dueTabs = [...this.#recovery.entries()]
        .filter(([, recovery]) => recovery.nextAttemptAt <= now)
        .map(([tabId]) => tabId)

      for (const tabId of dueTabs) {
        const entry = this.#tabs.get(tabId)
        if (!entry) {
          this.#clearRecovery(tabId)
          continue
        }

        if (!this.#shouldAutoAttachEntry(tabId, entry)) {
          this.#setEntryVirtual(tabId, entry)
          this.#clearRecovery(tabId)
          this.#schedulePersist()
          continue
        }

        const attached = await this.#recoverPhysicalConnection(tabId, entry)
        if (attached) {
          this.#clearRecovery(tabId)
          this.#emitAttached(entry)
          this.#schedulePersist()
          continue
        }

        await this.#scheduleRecovery(tabId, this.#recovery.get(tabId)?.reason || 'reattach-failed')
      }
    } finally {
      this.#recoveryRunning = false
      this.#ensureRecoveryAlarm()
    }
  }

  async #refreshTargetInfo(tabId, entry) {
    const info = /** @type {any} */ (
      await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
    )
    const realTargetId = String(info?.targetInfo?.targetId || '').trim()
    this.#updateTargetId(tabId, entry, realTargetId)
  }

  #updateTargetId(tabId, entry, realTargetId) {
    if (!realTargetId || realTargetId === entry.targetId) return
    this.#byTarget.delete(entry.targetId)
    entry.targetId = realTargetId
    this.#byTarget.set(realTargetId, tabId)
  }

  #moveTrackedTab(fromTabId, toTabId, url, title) {
    const entry = this.#tabs.get(fromTabId)
    if (!entry) return null

    this.#tabs.delete(fromTabId)
    entry.url = url ?? entry.url
    entry.title = title ?? entry.title
    this.#tabs.set(toTabId, entry)
    this.#bySession.set(entry.sessionId, toTabId)
    this.#byTarget.set(entry.targetId, toTabId)

    const pending = this.#pending.get(fromTabId)
    if (pending) {
      this.#pending.delete(fromTabId)
    }

    const recovery = this.#recovery.get(fromTabId)
    if (recovery) {
      this.#recovery.delete(fromTabId)
      this.#recovery.set(toTabId, recovery)
    }

    const children = this.#childSets.get(fromTabId)
    if (children) {
      this.#childSets.delete(fromTabId)
      this.#childSets.set(toTabId, children)
      for (const sid of children) this.#childSession.set(sid, toTabId)
    }

    this.#indicators.moveTab(fromTabId, toTabId)
    cleanupTabQueue(fromTabId)
    return entry
  }

  #removeEntry(tabId) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    if (entry.sessionId) this.#bySession.delete(entry.sessionId)
    if (entry.targetId) this.#byTarget.delete(entry.targetId)
    this.#tabs.delete(tabId)
    this.#attachGeneration.delete(tabId)
    this.#expectedDetach.delete(tabId)
    this.#indicators.removeTab(tabId)
    cleanupTabQueue(tabId)
    this.#clearRecovery(tabId)

    this.#clearChildSessions(tabId)
  }

  #notifyRemoved(sessionId) {
    if (!sessionId) return
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: { method: 'Extension.tabRemoved', params: { sessionId } },
    })
  }

  #emitDiscovered(entry) {
    if (!entry?.sessionId || !entry?.targetId) return
    const tabId = this.#bySession.get(entry.sessionId)
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabDiscovered',
        params: {
          sessionId: entry.sessionId,
          tabId: Number.isInteger(tabId) ? tabId : null,
          windowId: entry.windowId ?? null,
          active: entry.active === true,
          targetKey: entry.targetKey,
          targetInfo: {
            targetId: entry.targetId,
            type: 'page',
            title: entry.title || '',
            url: entry.url || '',
            attached: false,
          },
        },
      },
    })
  }

  #emitAttached(entry) {
    if (!entry?.sessionId || !entry?.targetId) return
    const tabId = this.#bySession.get(entry.sessionId)
    log.info('emitAttached', {
      tabId: Number.isInteger(tabId) ? tabId : null,
      sessionId: entry.sessionId,
      targetKey: entry.targetKey,
      targetId: entry.targetId,
      windowId: entry.windowId ?? null,
      active: entry.active === true,
      url: entry.url || '',
    })
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: entry.sessionId,
          tabId: Number.isInteger(tabId) ? tabId : null,
          windowId: entry.windowId ?? null,
          active: entry.active === true,
          targetKey: entry.targetKey,
          targetInfo: {
            targetId: entry.targetId,
            type: 'page',
            title: entry.title || '',
            url: entry.url || '',
            attached: true,
          },
          waitingForDebugger: false,
        },
      },
    })
  }

  #emitDetached(entry, reason) {
    if (!entry?.sessionId || !entry?.targetId) return
    const tabId = this.#bySession.get(entry.sessionId)
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: entry.sessionId,
          tabId: Number.isInteger(tabId) ? tabId : null,
          windowId: entry.windowId ?? null,
          active: entry.active === true,
          targetKey: entry.targetKey,
          targetId: entry.targetId,
          reason,
        },
      },
    })
  }

  #clearChildSessions(tabId) {
    const children = this.#childSets.get(tabId)
    if (!children) return
    for (const sid of children) this.#childSession.delete(sid)
    this.#childSets.delete(tabId)
  }

  #shouldAutoAttachEntry(tabId, entry) {
    return this.#shouldKeepEntryAttached(tabId, entry, tabId, false)
  }

  #setEntryVirtual(tabId, entry) {
    this.#clearRecovery(tabId)
    this.#clearChildSessions(tabId)
    entry.state = 'virtual'
    if (entry.targetId !== entry.targetKey) {
      this.#byTarget.delete(entry.targetId)
      entry.targetId = entry.targetKey
      this.#byTarget.set(entry.targetId, tabId)
    }
  }

  #shouldKeepEntryAttached(tabId, entry, activeTabId, manual = false) {
    const selectedWindowId = this.selectedWindowId
    return this.isCurrentBrowserSelected
      && (manual || !this.#autoAttachBlocked.has(tabId))
      && Number.isInteger(selectedWindowId)
      && entry.windowId === selectedWindowId
      && entry.active === true
      && tabId === activeTabId
  }

  async #detachEntryToVirtual(tabId, entry, reason) {
    this.#attachGeneration.set(tabId, (this.#attachGeneration.get(tabId) ?? 0) + 1)
    this.#expectedDetach.add(tabId)
    try {
      await this.#detachPhysicalDebugger(tabId)
    } catch (error) {
      this.#expectedDetach.delete(tabId)
      throw error
    }
    this.#emitDetached(entry, reason)
    this.#setEntryVirtual(tabId, entry)
  }

  async #shouldAttachTabForScope(tabId, manual) {
    if (!this.isCurrentBrowserSelected) return false
    const selectedWindowId = this.selectedWindowId
    if (!Number.isInteger(selectedWindowId)) return false
    if (!manual && this.#autoAttachBlocked.has(tabId)) return false

    const entry = this.#tabs.get(tabId)
    if (entry) {
      return entry.windowId === selectedWindowId && entry.active === true
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null)
    return Number.isInteger(tab?.windowId)
      && tab.windowId === selectedWindowId
      && tab.active === true
  }

  async #detachPhysicalDebugger(tabId) {
    const result = await detachDebugger(tabId)
    if (result?.status === 'failed') {
      throw new Error(result.message || `Failed to detach debugger from tab ${tabId}`)
    }
  }

  #schedulePersist() {
    if (this.#shuttingDown || this.#persistScheduled) return
    this.#persistScheduled = true
    queueMicrotask(() => {
      this.#persistScheduled = false
      this.#persistChain = this.#persistChain
        .then(() => this.#persistState())
        .catch((err) => log.warn('persistState failed:', err))
    })
  }

  async #persistState() {
    const snapshot = {
      tabs: [...this.#tabs.entries()].map(([tabId, entry]) => ({
        tabId,
        state: entry.state === 'connected' || entry.state === 'attaching'
          ? entry.state
          : 'virtual',
        sessionId: entry.sessionId,
        targetKey: entry.targetKey,
        targetId: entry.targetId,
        url: entry.url || '',
        title: entry.title || '',
        windowId: entry.windowId ?? null,
        active: entry.active === true,
      })),
      agentTabs: [...this.#agentTabs.entries()].map(([tabId, type]) => ({ tabId, type })),
      autoAttachBlocked: [...this.#autoAttachBlocked],
    }
    await chrome.storage.session.set({ [TAB_MANAGER_STATE_KEY]: snapshot })
  }
}
