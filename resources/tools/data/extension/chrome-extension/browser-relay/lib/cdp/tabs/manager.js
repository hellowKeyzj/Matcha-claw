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
 *   Extension.tabRemoved           — virtual tab removed from cache; carries
 *                                    closedBy (relay | external | cleanup) + agentTab
 *   Target.attachedToTarget        — physical debugger attached (Playwright sees this)
 *   Target.detachedFromTarget      — physical debugger detached (Playwright sees this)
 *
 * Delegates to:
 *   SessionIndicators  — spinner animation + idle tab detection
 *   AgentGroupManager  — Chrome tab group management
 */

import { createLogger } from '../../logger.js'
import { setAgentClaimTabIndicator } from '../../page-tab-indicator.js'
import {
  CommandDeadlineExceededError,
  awaitWithDeadline,
  createCommandContext,
} from '../commands/deadline.js'
import {
  detachDebugger,
  initializeAttachedDebugger,
  startDebuggerAttach,
  startDebuggerDetach,
} from './debugger-attach.js'
import { SessionIndicators } from './session-indicators.js'
import { AgentGroupManager } from './agent-group.js'
import { ExecutionScope } from './execution-scope.js'
import { interceptEvent } from '../events/index.js'

const log = createLogger('tabs')

const TAB_REGISTRY_KEY = 'accio_tabRegistryV2'
const LEGACY_CANCELLED_TABS_KEY = 'accio_cancelledTabs'
const LEGACY_TABS_STATE_KEY = 'accio_tabsState'
const MAX_PENDING_NAVIGATION_TARGETS = 256

let _sessionSeq = 0

const DEBUGGABLE_URL_RE = /^(https?|file):\/\//

function isDebuggableUrl(url) {
  if (!url) return false
  return DEBUGGABLE_URL_RE.test(url) || url === 'about:blank'
}

function canClaimTab(entry, principalId, sessionGroupId) {
  if (entry.claimedBy && entry.claimedBy !== principalId) return false
  if (sessionGroupId === null) {
    return entry.claimedBy === principalId && entry.sessionGroupId === null
  }
  return entry.sessionGroupId
    ? entry.sessionGroupId === sessionGroupId || (!entry.createdBy && entry.sessionGroupId === principalId)
    : !entry.createdBy || entry.createdBy === principalId
}

/** Derive stable vtab handle from numeric tab ID. */
function toVtabId(tabId) {
  return `vtab-${tabId}`
}

function fromVtabId(targetId) {
  if (typeof targetId !== 'string') return null
  const match = /^vtab-(\d+)$/.exec(targetId)
  if (!match) return null
  const tabId = Number(match[1])
  return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null
}

const FOREIGN_EXTENSION_ATTACH_ERROR_RE = /Cannot access a chrome-extension:\/\/ URL of different extension/i
const ATTACH_OPERATION_METHOD = 'TabManager.attachDebugger'
const ATTACH_CLEANUP_METHOD = 'TabManager.attachCleanup'
const SHUTDOWN_CLEANUP_METHOD = 'TabManager.shutdownCleanup'
const ATTACH_CLEANUP_TIMEOUT_MS = 1_000
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 1_000

async function waitForPendingAttach(pending, commandContext, boundByCaller = true) {
  try {
    return commandContext && boundByCaller
      ? await awaitWithDeadline(commandContext, 'tab_manager.waitForPendingAttach', () => pending)
      : await pending
  } catch (err) {
    if (
      commandContext &&
      err instanceof CommandDeadlineExceededError &&
      err.method === ATTACH_OPERATION_METHOD
    ) {
      throw new CommandDeadlineExceededError({
        context: commandContext,
        stage: err.stage,
        operationElapsedMs: err.operationElapsedMs,
        timeoutSource: err.timeoutSource,
      })
    }
    throw err
  }
}

/**
 * Structured result of ensureAttached/#physicalAttach.
 *
 * @typedef {{ ok: true } | {
 *   ok: false,
 *   code: 'user_denied'         // user rejected the chrome.debugger permission banner
 *       | 'not_tracked'         // tab is not in the manager registry
 *       | 'tab_removed'         // tab entry disappeared while attaching
 *       | 'shutting_down'       // clearAll in progress
 *       | 'tab_busy'            // "Tabs cannot be edited" — user dragging a tab, transient
 *       | 'extension_conflict'  // another extension's iframe blocks debugger.attach (platform restriction)
 *       | 'attach_failed',      // any other chrome.debugger.attach failure
 *   message: string,
 *   conflictExtensionIds?: string[],
 * }} AttachOutcome
 */

/**
 * @typedef {{
 *   state: 'virtual' | 'attaching' | 'connected',
 *   attachmentSessionId: string,
 *   realTargetId: string | null,
 *   url?: string,
 *   title?: string,
 *   windowId: number | null,
 *   active: boolean,
 *   openerVtabId?: string,
 *   createdByAgent: boolean,
 *   createdBy: string | null,
 *   claimedBy: string | null,
 *   sessionGroupId: string | null,
 *   claimedByAgent: boolean,
 *   retained: boolean,
 *   attachPermission: 'allowed' | 'user_denied',
 *   childSessionIds: Set<string>,
 *   childAttachments?: Map<string, {parentSessionId: string, params: object}>,
 * }} TabEntry
 */

/**
 * Diagnose which other extension(s) injected iframes into the tab.
 * Chrome rejects chrome.debugger.attach for the whole tab if ANY frame belongs
 * to a different extension (e.g. hidden helper iframes from screenshot tools).
 *
 * @param {number} tabId
 * @returns {Promise<string[]>} offending extension IDs (deduped, own ID excluded)
 */
async function findForeignExtensionFrames(tabId, commandContext) {
  try {
    const execute = () => chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        const out = []
        const scan = (root) => {
          for (const el of root.querySelectorAll('iframe')) {
            const src = el.src || el.getAttribute('src') || ''
            if (src.startsWith('chrome-extension://')) out.push(src)
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) scan(el.shadowRoot)
          }
        }
        scan(document)
        return out
      },
    })
    const results = commandContext
      ? await awaitWithDeadline(
          commandContext,
          'chrome.scripting.executeScript:findForeignExtensionFrames',
          execute,
        )
      : await execute()
    const srcs = results?.flatMap((r) => (Array.isArray(r?.result) ? r.result : [])) ?? []
    const ids = new Set()
    for (const src of srcs) {
      const id = src.slice('chrome-extension://'.length).split('/')[0]
      if (id && id !== chrome.runtime.id) ids.add(id)
    }
    return [...ids]
  } catch (err) {
    if (err instanceof CommandDeadlineExceededError) throw err
    return []
  }
}

export class TabManager {
  /** @type {Map<number, TabEntry>} */
  #tabs = new Map()
  /** @type {Map<number, number>} child tabId → source tabId */
  #pendingSourceTabByChildTab = new Map()
  /** @type {Map<string, {tabId: number, kind: 'main' | 'child'}>} */
  #sessionRoutes = new Map()
  /** @type {Map<number, {result: Promise<AttachOutcome>, lifecycle: Promise<void>}>} */
  #pending = new Map()
  /** @type {Map<number, Promise<void>>} tabId → active physical lifecycle barrier */
  #detaching = new Map()
  #intentionalDetaches = new Map()
  /**
   * Tabs whose removal the relay asked for. Set before chrome.tabs.remove and
   * consumed by removeTrackedEntry, because chrome.tabs.onRemoved also fires for
   * our own removes — without the mark, a relay close and a user close would be
   * indistinguishable at the point the event is emitted.
   * @type {Set<number>}
   */
  #relayRequestedCloses = new Set()
  /** @type {boolean} */
  #shuttingDown = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  #persistTimer = null
  /** @type {Promise<void>} */
  #writeChain = Promise.resolve()
  /** @type {Promise<void>} */
  #claimSyncChain = Promise.resolve()
  /**
   * Single-flight guard for reconcileFromChrome(). A route miss is a signal that
   * internal state has drifted from Chrome; concurrent misses must coalesce into
   * one Chrome query + one full relay resync instead of a storm of scans.
   * @type {Promise<void> | null}
   */
  #reconcileFromChromeInFlight = null
  /** @type {number} */
  #reconcileFromChromeEpoch = 0
  /** @type {number} */
  #tabsResyncEpoch = 0
  /** @type {boolean} */
  #legacyCleanupPending = false
  /** @type {(payload: any) => void} */
  #sendToRelay
  /** @type {import('../commands/tab-command-scheduler.js').TabCommandScheduler} */
  #scheduler

  /** @type {SessionIndicators} */
  #indicators
  /** @type {AgentGroupManager} */
  #group
  /** @type {ExecutionScope} */
  #scope
  #healthCheckRunning = false

  /**
   * @param {(payload: any) => void} sendToRelay — fire-and-forget relay send function
   * @param {import('../commands/tab-command-scheduler.js').TabCommandScheduler} scheduler
   */
  constructor(sendToRelay, scheduler, options) {
    if (!scheduler) throw new TypeError('TabManager requires a shared TabCommandScheduler')
    this.#sendToRelay = sendToRelay
    this.#scheduler = scheduler
    this.#scope = new ExecutionScope(options)
    this.#group = new AgentGroupManager()
    this.#indicators = new SessionIndicators({
      getGroupIds: () => this.#group.groupIds,
      getTabEntries: () => this.#tabs.entries(),
      detachTab: (tabId, reason) => this.detach(tabId, reason, { initiatedByUs: true }),
    })
  }

  #nextAttachmentSessionId(tabId) {
    return `cb-tab-${++_sessionSeq}-${tabId}`
  }

  #createVirtualEntry(
    tabId,
    {
      url,
      title,
      windowId = null,
      active = false,
      openerVtabId,
      createdByAgent = false,
      createdBy = null,
      claimedBy = null,
      sessionGroupId = null,
      retained = false,
      attachPermission = 'allowed',
    } = {},
  ) {
    return {
      state: 'virtual',
      attachmentSessionId: this.#nextAttachmentSessionId(tabId),
      realTargetId: null,
      url,
      title,
      windowId: Number.isInteger(windowId) ? windowId : null,
      active: active === true,
      ...(openerVtabId ? { openerVtabId } : {}),
      createdByAgent,
      createdBy,
      claimedBy,
      sessionGroupId,
      claimedByAgent: claimedBy !== null && !createdByAgent,
      retained: createdByAgent && retained,
      attachPermission,
      childSessionIds: new Set(),
    }
  }

  #currentTargetId(tabId, entry) {
    return entry.realTargetId || toVtabId(tabId)
  }

  #isRelayVisible(entry) {
    return entry.attachPermission !== 'user_denied' || isDebuggableUrl(entry.url)
  }

  #indexEntry(tabId, entry) {
    this.#sessionRoutes.set(entry.attachmentSessionId, { tabId, kind: 'main' })
    for (const sessionId of entry.childSessionIds) {
      this.#sessionRoutes.set(sessionId, { tabId, kind: 'child' })
    }
  }

  #unindexEntry(tabId, entry) {
    const mainRoute = this.#sessionRoutes.get(entry.attachmentSessionId)
    if (mainRoute?.tabId === tabId && mainRoute.kind === 'main') {
      this.#sessionRoutes.delete(entry.attachmentSessionId)
    }
    for (const sessionId of entry.childSessionIds) {
      const route = this.#sessionRoutes.get(sessionId)
      if (route?.tabId === tabId && route.kind === 'child') this.#sessionRoutes.delete(sessionId)
    }
  }

  #rebuildSessionRoutes() {
    this.#sessionRoutes.clear()
    for (const [tabId, entry] of this.#tabs) this.#indexEntry(tabId, entry)
  }

  #storeEntry(tabId, entry) {
    const previous = this.#tabs.get(tabId)
    if (previous) this.#unindexEntry(tabId, previous)
    this.#tabs.set(tabId, entry)
    this.#indexEntry(tabId, entry)
  }

  #setConnected(tabId, entry, realTargetId) {
    if (!realTargetId) throw new Error(`Connected tab ${tabId} requires a real target ID`)
    this.#unindexEntry(tabId, entry)
    entry.state = 'connected'
    entry.realTargetId = realTargetId
    this.#indexEntry(tabId, entry)
  }

  #setVirtual(tabId, entry, { rotateSession = false } = {}) {
    this.#unindexEntry(tabId, entry)
    entry.state = 'virtual'
    entry.realTargetId = null
    entry.childSessionIds.clear()
    entry.childAttachments?.clear()
    if (rotateSession) entry.attachmentSessionId = this.#nextAttachmentSessionId(tabId)
    this.#indexEntry(tabId, entry)
  }

  #addChildSession(tabId, sessionId, parentSessionId, params) {
    const entry = this.#tabs.get(tabId)
    if (!entry || entry.state !== 'connected') return
    entry.childSessionIds.add(sessionId)
    entry.childAttachments ??= new Map()
    entry.childAttachments.set(sessionId, { parentSessionId, params })
    this.#sessionRoutes.set(sessionId, { tabId, kind: 'child' })
  }

  #removeChildSession(tabId, sessionId) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    // Chrome may report only the ancestor detach; retire its descendant routes too.
    for (const [childId, attachment] of entry.childAttachments ?? []) {
      if (attachment.parentSessionId === sessionId) this.#removeChildSession(tabId, childId)
    }
    entry.childSessionIds.delete(sessionId)
    entry.childAttachments?.delete(sessionId)
    const route = this.#sessionRoutes.get(sessionId)
    if (route?.tabId === tabId && route.kind === 'child') this.#sessionRoutes.delete(sessionId)
  }

  #tabMetadata(tabId, entry) {
    return {
      sessionId: entry.attachmentSessionId,
      targetKey: toVtabId(tabId),
      vtabId: toVtabId(tabId),
      tabId,
      windowId: entry.windowId,
      active: entry.active,
      createdByAgent: entry.createdByAgent,
      createdBy: entry.createdBy,
      claimedBy: entry.claimedBy,
      sessionGroupId: entry.sessionGroupId,
      retained: entry.createdByAgent && entry.retained,
      ...(entry.openerVtabId ? { openerVtabId: entry.openerVtabId } : {}),
    }
  }

  #notifyUpdated(tabId, entry) {
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabUpdated',
        params: {
          ...this.#tabMetadata(tabId, entry),
          targetInfo: {
            targetId: this.#currentTargetId(tabId, entry), type: 'page',
            title: entry.title || '', url: entry.url || '',
            attached: entry.state === 'connected',
          },
        },
      },
    })
  }

  #notifyDiscovered(tabId, entry) {
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabDiscovered',
        params: {
          ...this.#tabMetadata(tabId, entry),
          targetInfo: {
            targetId: toVtabId(tabId),
            type: 'page',
            title: entry.title || '',
            url: entry.url || '',
            attached: false,
          },
        },
      },
    })
  }

  #serializeEntry(entry) {
    const state = entry.state === 'connected' ? 'connected' : 'virtual'
    return {
      state,
      attachmentSessionId: entry.attachmentSessionId,
      realTargetId: state === 'connected' ? entry.realTargetId : null,
      url: entry.url,
      title: entry.title,
      windowId: entry.windowId,
      active: entry.active,
      ...(entry.openerVtabId ? { openerVtabId: entry.openerVtabId } : {}),
      createdByAgent: entry.createdByAgent,
      createdBy: entry.createdBy,
      claimedBy: entry.claimedBy,
      sessionGroupId: entry.sessionGroupId,
      retained: entry.createdByAgent && entry.retained,
      attachPermission: entry.attachPermission,
    }
  }

  #deserializeV2Entry(tabId, value) {
    if (!value || typeof value !== 'object') return null
    const hasRealTarget = typeof value.realTargetId === 'string' && value.realTargetId.length > 0
    const state = value.state === 'connected' && hasRealTarget ? 'connected' : 'virtual'
    return {
      state,
      attachmentSessionId:
        typeof value.attachmentSessionId === 'string'
          ? value.attachmentSessionId
          : this.#nextAttachmentSessionId(tabId),
      realTargetId: state === 'connected' ? value.realTargetId : null,
      url: typeof value.url === 'string' ? value.url : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
      windowId: Number.isInteger(value.windowId) ? value.windowId : null,
      active: value.active === true,
      ...(fromVtabId(value.openerVtabId) !== null ? { openerVtabId: value.openerVtabId } : {}),
      createdByAgent: value.createdByAgent === true,
      createdBy: typeof value.createdBy === 'string' && value.createdBy ? value.createdBy : null,
      claimedBy: typeof value.claimedBy === 'string' && value.claimedBy ? value.claimedBy : null,
      sessionGroupId: typeof value.sessionGroupId === 'string' && value.sessionGroupId ? value.sessionGroupId : null,
      claimedByAgent: value.createdByAgent !== true && typeof value.claimedBy === 'string' && value.claimedBy.length > 0,
      retained: value.createdByAgent === true && value.retained === true,
      attachPermission: value.attachPermission === 'user_denied' ? 'user_denied' : 'allowed',
      childSessionIds: new Set(),
    }
  }

  #deserializeLegacyEntry(tabId, value, agentType, cancelled) {
    if (!value || typeof value !== 'object') return null
    const storedTargetId = value.targetId
    const hasRealTarget =
      typeof storedTargetId === 'string'
      && storedTargetId.length > 0
      && storedTargetId !== toVtabId(tabId)
    const state = value.state === 'connected' && hasRealTarget ? 'connected' : 'virtual'
    const createdByAgent = agentType === 'agent' || agentType === 'retained'
    return {
      state,
      attachmentSessionId:
        typeof value.sessionId === 'string' ? value.sessionId : this.#nextAttachmentSessionId(tabId),
      realTargetId:
        state === 'connected'
        && typeof storedTargetId === 'string'
        && storedTargetId !== toVtabId(tabId)
          ? storedTargetId
          : null,
      url: typeof value.url === 'string' ? value.url : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
      windowId: Number.isInteger(value.windowId) ? value.windowId : null,
      active: value.active === true,
      ...(fromVtabId(value.openerVtabId) !== null ? { openerVtabId: value.openerVtabId } : {}),
      createdByAgent,
      createdBy: null,
      claimedBy: null,
      sessionGroupId: null,
      claimedByAgent: false,
      retained: agentType === 'retained',
      attachPermission: cancelled ? 'user_denied' : 'allowed',
      childSessionIds: new Set(),
    }
  }

  #claimRestoredSessionId(tabId, entry, seenSessionIds) {
    let sessionId = typeof entry.attachmentSessionId === 'string'
      ? entry.attachmentSessionId.trim()
      : ''
    const match = /^cb-tab-(\d+)-\d+$/.exec(sessionId)
    if (match) _sessionSeq = Math.max(_sessionSeq, Number(match[1]))
    while (!sessionId || seenSessionIds.has(sessionId)) {
      sessionId = this.#nextAttachmentSessionId(tabId)
    }
    entry.attachmentSessionId = sessionId
    seenSessionIds.add(sessionId)
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

  // ── Tab group ──

  async addToAgentGroup(tabId, commandContext) {
    await this.#group.addTab(tabId, commandContext)
  }

  async dissolveAgentGroup() {
    await this.#group.dissolve(new Set(this.getAgentTabIds().filter((tabId) =>
      this.#tabs.get(tabId)?.createdBy && !this.isRetained(tabId))))
  }

  /**
   * Atomic shutdown: optionally dissolve agent group, then clear all state.
   * Dissolution runs BEFORE clearAll() so Agent-owned tabs remain identifiable.
   */
  async shutdown({ dissolveGroup = false } = {}) {
    if (dissolveGroup) await this.dissolveAgentGroup()
    return this.clearAll()
  }

  // ── Tab state queries ──

  get size() { return this.#tabs.size }
  has(tabId) { return this.#tabs.has(tabId) }
  get(tabId) { return this.#tabs.get(tabId) }
  get selectedWindowId() { return this.#scope.selectedWindowId }
  get isCurrentBrowserSelected() { return this.#scope.isCurrentBrowserSelected }
  get executionScopeEnabled() { return this.#scope.enabled }

  isInExecutionScope(tabId) {
    return this.#scope.allows(tabId, this.#tabs.get(tabId))
  }

  selectExecutionWindow(windowId, commandContext) {
    return this.#scope.selectWindow(windowId, commandContext)
  }

  setActiveTab(tabId, windowId = this.#tabs.get(tabId)?.windowId) {
    if (this.#scope.enabled && windowId === this.selectedWindowId) this.#scope.select(tabId)
    for (const [id, entry] of this.#tabs) {
      if (id !== tabId && entry.windowId !== windowId) continue
      this.updateTab(id, undefined, undefined, {
        ...(id === tabId && Number.isInteger(windowId) ? { windowId } : {}),
        active: id === tabId,
      })
    }
  }

  async withExecutionScope(tabId, commandContext, task, { attach = true } = {}) {
    const release = this.#scope.reserve(tabId)
    const selection = this.#scope.current
    try {
      if (attach) {
        const attached = await this.applyExecutionScope(tabId, { commandContext })
        if (!attached || this.#tabs.get(tabId)?.state !== 'connected') {
          throw new Error(`Failed to attach execution tab ${tabId}`)
        }
      }
      if (!this.#scope.allows(tabId, this.#tabs.get(tabId), selection)) {
        throw new Error('Execution scope changed before the command started')
      }
      return await task()
    } finally {
      const settlement = commandContext?.waitForNativeSettlement?.()
      if (settlement) void settlement.then(release, release)
      else release()
    }
  }

  async applyExecutionScope(activeTabId = null, { manual = false, commandContext } = {}) {
    const selection = this.#scope.select(activeTabId, { manual })
    if (selection.tabId !== activeTabId) {
      const current = this.#tabs.get(selection.tabId)
      return current?.state === 'connected' ? this.#tabSnapshot(selection.tabId, current) : null
    }
    const detached = []
    for (const [tabId, entry] of this.#tabs) {
      if (this.#scope.allows(tabId, entry, selection)) continue
      if (entry.state === 'connected' || entry.state === 'attaching' || this.#detaching.has(tabId)) {
        detached.push(this.detach(tabId, 'execution-scope-changed', { initiatedByUs: true }))
      }
    }
    const cleanup = Promise.all(detached)
    if (commandContext) {
      await awaitWithDeadline(commandContext, 'tab_manager.executionScope', () => cleanup)
    } else {
      await cleanup
    }
    if (!Number.isInteger(activeTabId) || !this.#scope.isCurrent(selection)) return null
    let entry = this.#tabs.get(activeTabId)
    if (!entry) {
      const getTab = () => chrome.tabs.get(activeTabId)
      const tab = commandContext
        ? await awaitWithDeadline(commandContext, 'chrome.tabs.get:executionScope', getTab)
        : await getTab().catch(() => null)
      if (!tab || !this.#scope.isCurrent(selection)) return null
      this.discover(activeTabId, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
      entry = this.#tabs.get(activeTabId)
    }
    if (!entry || !this.#scope.allows(activeTabId, entry, selection)) return null
    if (manual && entry.attachPermission === 'user_denied') {
      entry.attachPermission = 'allowed'
      this.#persistTabs()
    }
    const outcome = await this.ensureAttached(activeTabId, commandContext)
    return outcome.ok && this.#scope.allows(activeTabId, entry, selection)
      ? this.#tabSnapshot(activeTabId, entry)
      : null
  }

  getCurrentTargetId(tabId) {
    const entry = this.#tabs.get(tabId)
    return entry ? this.#currentTargetId(tabId, entry) : null
  }

  #tabSnapshot(tabId, entry) {
    return {
      tabId,
      state: entry.state,
      sessionId: entry.attachmentSessionId,
      vtabId: toVtabId(tabId),
      targetKey: toVtabId(tabId),
      windowId: entry.windowId,
      active: entry.active,
      targetId: this.#currentTargetId(tabId, entry),
      url: entry.url || '',
      title: entry.title || '',
      isAgent: this.isAgent(tabId),
      isRetained: this.isRetained(tabId),
      createdBy: entry.createdBy,
      claimedBy: entry.claimedBy,
      sessionGroupId: entry.sessionGroupId,
    }
  }

  listTabSnapshots() {
    return [...this.#tabs].map(([tabId, entry]) => this.#tabSnapshot(tabId, entry))
  }

  get agentTabCount() {
    let count = 0
    for (const entry of this.#tabs.values()) {
      if (entry.createdByAgent) count++
    }
    return count
  }

  get retainedTabCount() {
    let count = 0
    for (const entry of this.#tabs.values()) {
      if (entry.createdByAgent && entry.retained) count++
    }
    return count
  }

  getAgentTabIds() {
    const ids = []
    for (const [tabId, entry] of this.#tabs) {
      if (entry.createdByAgent) ids.push(tabId)
    }
    return ids
  }

  isAgent(tabId) { return this.#tabs.get(tabId)?.createdByAgent === true }
  isRetained(tabId) {
    const entry = this.#tabs.get(tabId)
    return entry?.createdByAgent === true && entry.retained === true
  }

  /**
   * @internal Test-only — DO NOT call from production code.
   * Atomically inject a connected (physical) tab into all indexes.
   * Mirrors the state that would exist after discover() + successful chrome.debugger.attach().
   * @param {number} tabId
   * @param {string} sessionId
   * @param {string} realTargetId — the real CDP targetId assigned after attach
   */
  _injectConnectedState(tabId, sessionId, realTargetId) {
    const previous = this.#tabs.get(tabId)
    const entry = {
      state: 'connected',
      attachmentSessionId: sessionId,
      realTargetId,
      url: previous?.url ?? 'https://test.example.com',
      title: previous?.title ?? 'Test',
      windowId: previous?.windowId ?? null,
      active: previous?.active ?? false,
      ...(previous?.openerVtabId ? { openerVtabId: previous.openerVtabId } : {}),
      createdByAgent: previous?.createdByAgent ?? false,
      createdBy: previous?.createdBy ?? null,
      claimedBy: previous?.claimedBy ?? null,
      sessionGroupId: previous?.sessionGroupId ?? null,
      claimedByAgent: previous?.claimedByAgent ?? false,
      retained: previous?.retained ?? false,
      attachPermission: previous?.attachPermission ?? 'allowed',
      childSessionIds: new Set(),
    }
    this.#storeEntry(tabId, entry)
    return entry
  }

  // ── Lookup ──

  getBySessionId(sessionId) {
    return this.#sessionRoutes.get(sessionId) ?? null
  }

  /** Resolve either the current real targetId or the stable vtabId. */
  getByStableOrRealTargetId(targetId) {
    const virtualTabId = fromVtabId(targetId)
    if (virtualTabId !== null) return this.#tabs.has(virtualTabId) ? virtualTabId : null

    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected' && entry.realTargetId === targetId) return tabId
    }
    return null
  }

  resolveTabId(sessionId, targetId) {
    const route = this.resolveCommandRoute(sessionId, targetId)
    return route.ok ? route.tabId : null
  }

  #routeByTargetId(targetId) {
    const tabId = this.getByStableOrRealTargetId(targetId)
    const entry = tabId === null ? undefined : this.#tabs.get(tabId)
    if (!entry) return null
    return {
      ok: true,
      tabId,
      attachmentSessionId: entry.attachmentSessionId,
      commandSessionId: undefined,
      sessionKind: undefined,
    }
  }

  /**
   * @param {{ allowTargetFallback?: boolean }} [options] allowTargetFallback is for methods whose
   *   scope is the tab itself rather than an execution context, so a replaced session carries no
   *   meaning for them (Target.closeTarget runs through chrome.tabs.remove and never touches CDP).
   *   Session-bound methods must leave it off: redirecting them to a different session would land
   *   them in the wrong execution context and return plausible-looking wrong data.
   */
  resolveCommandRoute(sessionId, targetId, { allowTargetFallback = false } = {}) {
    const commandSessionId = typeof sessionId === 'string' && sessionId.length > 0
      ? sessionId
      : undefined
    if (commandSessionId) {
      const found = this.getBySessionId(commandSessionId)
      const entry = found ? this.#tabs.get(found.tabId) : undefined
      if (found && entry) {
        return {
          ok: true,
          tabId: found.tabId,
          attachmentSessionId: entry.attachmentSessionId,
          commandSessionId,
          sessionKind: found.kind,
        }
      }
      if (!allowTargetFallback || !targetId) return { ok: false, code: 'stale_session' }
      // Drop the session identity entirely — keeping commandSessionId would make
      // validateCommandRoute re-resolve the dead session on dequeue and fail again.
      const degraded = this.#routeByTargetId(targetId)
      if (degraded) return { ...degraded, degradedFromSession: true }
      // Both keys missed: this is no longer "the session was replaced" but "we don't
      // track this tab", which is what the caller's reconcile self-heal is built for.
      return { ok: false, code: 'target_not_found' }
    }
    if (targetId) {
      const route = this.#routeByTargetId(targetId)
      if (route) return route
    }
    return { ok: false, code: 'target_not_found' }
  }

  validateCommandRoute(route) {
    if (!route?.ok) return false
    const entry = this.#tabs.get(route.tabId)
    if (!entry || entry.attachmentSessionId !== route.attachmentSessionId) return false
    if (!route.commandSessionId) return true
    const current = this.getBySessionId(route.commandSessionId)
    return Boolean(
      current
      && current.tabId === route.tabId
      && current.kind === route.sessionKind,
    )
  }

  // ── Tab state persistence (chrome.storage.session) ──

  #snapshot() {
    return {
      sessionSeq: _sessionSeq,
      tabs: [...this.#tabs].map(([tabId, entry]) => [tabId, this.#serializeEntry(entry)]),
      pendingNavigationTargets: [...this.#pendingSourceTabByChildTab],
    }
  }

  #enqueueSnapshot(snapshot) {
    const persist = async () => {
      await chrome.storage.session.set({ [TAB_REGISTRY_KEY]: snapshot })
      if (this.#legacyCleanupPending) {
        await chrome.storage.session.remove([
          LEGACY_TABS_STATE_KEY,
          LEGACY_CANCELLED_TABS_KEY,
        ])
        this.#legacyCleanupPending = false
      }
    }
    const write = this.#writeChain.then(persist, persist)
    this.#writeChain = write.catch((err) => {
      log.warn('persistTabs failed:', err)
    })
    return write
  }

  #persistTabs() {
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer)
    this.#persistTimer = setTimeout(() => {
      void this.#flushTabs().catch(() => {})
    }, 200)
  }

  #flushTabs() {
    this.#persistTimer = null
    return this.#enqueueSnapshot(this.#snapshot())
  }

  async #flushTabsImmediate() {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = null
    }
    await this.#flushTabs()
  }

  #restoreV2(data) {
    this.#tabs.clear()
    this.#pendingSourceTabByChildTab.clear()
    if (Number.isSafeInteger(data?.sessionSeq) && data.sessionSeq >= 0) {
      _sessionSeq = Math.max(_sessionSeq, data.sessionSeq)
    }
    const seenSessionIds = new Set()
    if (Array.isArray(data?.tabs)) {
      for (const record of data.tabs) {
        if (!Array.isArray(record) || record.length < 2) continue
        const [tabId, value] = record
        if (!Number.isSafeInteger(tabId) || tabId <= 0) continue
        const entry = this.#deserializeV2Entry(tabId, value)
        if (!entry) continue
        this.#claimRestoredSessionId(tabId, entry, seenSessionIds)
        this.#tabs.set(tabId, entry)
      }
    }
    if (Array.isArray(data?.pendingNavigationTargets)) {
      for (const relation of data.pendingNavigationTargets) {
        if (!Array.isArray(relation) || relation.length < 2) continue
        const [childTabId, sourceTabId] = relation
        if (
          !Number.isSafeInteger(childTabId) || childTabId <= 0 ||
          !Number.isSafeInteger(sourceTabId) || sourceTabId <= 0
        ) continue
        this.#pendingSourceTabByChildTab.set(childTabId, sourceTabId)
      }
    }
    this.#rebuildSessionRoutes()
  }

  #restoreLegacy(data, cancelledIds, liveTabs) {
    this.#tabs.clear()
    this.#pendingSourceTabByChildTab.clear()
    if (Number.isSafeInteger(data?.sessionSeq) && data.sessionSeq >= 0) {
      _sessionSeq = Math.max(_sessionSeq, data.sessionSeq)
    }
    const agentTabs = new Map()
    if (Array.isArray(data?.agentTabs)) {
      for (const record of data.agentTabs) {
        if (!Array.isArray(record) || record.length < 2) continue
        const [tabId, type] = record
        if (!Number.isSafeInteger(tabId) || (type !== 'agent' && type !== 'retained')) continue
        agentTabs.set(tabId, type)
      }
    }
    const cancelled = new Set(
      Array.isArray(cancelledIds)
        ? cancelledIds.filter((tabId) => Number.isSafeInteger(tabId) && tabId > 0)
        : [],
    )
    const seenSessionIds = new Set()
    if (Array.isArray(data?.tabs)) {
      for (const record of data.tabs) {
        if (!Array.isArray(record) || record.length < 2) continue
        const [tabId, value] = record
        if (!Number.isSafeInteger(tabId) || tabId <= 0) continue
        const entry = this.#deserializeLegacyEntry(
          tabId,
          value,
          agentTabs.get(tabId),
          cancelled.has(tabId),
        )
        if (!entry) continue
        this.#claimRestoredSessionId(tabId, entry, seenSessionIds)
        this.#tabs.set(tabId, entry)
      }
    }
    if (Array.isArray(data?.pendingNavigationTargets)) {
      for (const relation of data.pendingNavigationTargets) {
        if (!Array.isArray(relation) || relation.length < 2) continue
        const [childTabId, sourceTabId] = relation
        if (
          !Number.isSafeInteger(childTabId) || childTabId <= 0 ||
          !Number.isSafeInteger(sourceTabId) || sourceTabId <= 0
        ) continue
        this.#pendingSourceTabByChildTab.set(childTabId, sourceTabId)
      }
    }
    for (const tab of liveTabs) {
      if (!cancelled.has(tab.id) || this.#tabs.has(tab.id)) continue
      const entry = this.#createVirtualEntry(tab.id, {
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId,
        active: tab.active,
        attachPermission: 'user_denied',
      })
      this.#claimRestoredSessionId(tab.id, entry, seenSessionIds)
      this.#tabs.set(tab.id, entry)
    }
    this.#rebuildSessionRoutes()
  }

  async loadTabs() {
    try {
      const storedV2 = await chrome.storage.session.get(TAB_REGISTRY_KEY)
      const hasV2 = Object.prototype.hasOwnProperty.call(storedV2, TAB_REGISTRY_KEY)

      if (hasV2) {
        this.#restoreV2(storedV2[TAB_REGISTRY_KEY])
      } else {
        const legacy = await chrome.storage.session.get([
          LEGACY_TABS_STATE_KEY,
          LEGACY_CANCELLED_TABS_KEY,
        ])
        const cancelledIds = legacy[LEGACY_CANCELLED_TABS_KEY]
        const liveTabs = Array.isArray(cancelledIds) && cancelledIds.length > 0
          ? await chrome.tabs.query({})
          : []
        this.#restoreLegacy(
          legacy[LEGACY_TABS_STATE_KEY],
          cancelledIds,
          liveTabs,
        )
        this.#legacyCleanupPending = true
        try {
          await this.#flushTabsImmediate()
        } catch (err) {
          log.warn('loadTabs: failed to persist migrated registry:', err)
        }
      }

      log.info('loadTabs: restored', this.#tabs.size, 'tabs, sessionSeq =', _sessionSeq)
      return true
    } catch (err) {
      log.warn('loadTabs failed:', err)
      return false
    }
  }

  async reconcileTabs({ persist = true, isCurrent = () => true } = {}) {
    const candidates = new Map([...this.#tabs].map(([tabId, entry]) => [tabId, {
      entry,
      attachmentSessionId: entry.attachmentSessionId,
      state: entry.state,
      realTargetId: entry.realTargetId,
    }]))
    const pendingSources = [...this.#pendingSourceTabByChildTab]
    const liveTabs = await chrome.tabs.query({})
    if (!isCurrent()) return false
    const targets = await chrome.debugger.getTargets()
    if (!isCurrent()) return false

    const liveById = new Map(
      liveTabs
        .filter((tab) => Number.isSafeInteger(tab.id))
        .map((tab) => [tab.id, tab]),
    )
    const attachedTargets = new Map(
      targets
        .filter((target) => target.attached && target.tabId && target.type === 'page')
        .map((target) => [target.tabId, target.id || null]),
    )

    // Chrome observations only apply to the lifecycle present before the queries.
    const isUnchanged = (tabId) => {
      const candidate = candidates.get(tabId)
      const entry = this.#tabs.get(tabId)
      return entry === candidate?.entry
        && (!entry || (entry.attachmentSessionId === candidate.attachmentSessionId
          && entry.state === candidate.state && entry.realTargetId === candidate.realTargetId))
    }
    for (const [childTabId, sourceTabId] of pendingSources) {
      if (this.#pendingSourceTabByChildTab.get(childTabId) !== sourceTabId
        || !isUnchanged(childTabId) || !isUnchanged(sourceTabId)
        || liveById.has(childTabId)) continue
      this.#pendingSourceTabByChildTab.delete(childTabId)
    }
    // Pending relations were merged separately; removal must leave newer relations intact.
    for (const tabId of candidates.keys()) {
      if (!isUnchanged(tabId) || liveById.has(tabId)) continue
      log.info('reconcileTabs: tab closed during sleep, removing', tabId)
      this.removeTrackedEntry(tabId, 'tab-closed', { persist: false, removeNavigationTargets: false })
    }

    for (const [tabId, { entry }] of candidates) {
      if (!isUnchanged(tabId)) continue
      const liveTab = liveById.get(tabId)
      if (typeof liveTab?.url === 'string') entry.url = liveTab.url
      if (typeof liveTab?.title === 'string') entry.title = liveTab.title
      if (Number.isInteger(liveTab?.windowId)) entry.windowId = liveTab.windowId
      if (typeof liveTab?.active === 'boolean') entry.active = liveTab.active

      if (entry.state === 'virtual') {
        entry.realTargetId = null
        continue
      }
      if (entry.state === 'attaching') continue

      if (!attachedTargets.has(tabId)) {
        log.info('reconcileTabs: debugger detached during sleep, downgrading to virtual', tabId)
        this.downgradeToVirtual(tabId, 'sw-restart', { persist: false })
        continue
      }

      const realTargetId = attachedTargets.get(tabId)
      if (realTargetId && realTargetId !== entry.realTargetId) entry.realTargetId = realTargetId
    }

    this.#rebuildSessionRoutes()
    if (persist) this.#persistTabs()
    log.info('reconcileTabs: done,', this.#tabs.size, 'tabs surviving')
    return true
  }

  beginTabsResync() {
    this.#tabsResyncEpoch += 1
    return this.#tabsResyncEpoch
  }

  isTabsResyncCurrent(epoch) {
    return epoch === this.#tabsResyncEpoch
  }

  /**
   * Self-heal a command-route miss against Chrome ground truth, then converge relay.
   *
   * A route miss (target_not_found / stale_session) means our in-memory view has
   * drifted from Chrome — a dropped removal event, an SW-restart gap, or a relay
   * that still holds a tab we no longer track. Rather than trust the miss, we
   * re-derive truth from chrome.tabs/chrome.debugger via reconcileTabs() (which
   * realigns existing #tabs entries and rebuilds session routes) and then push the
   * full corrected snapshot to relay via resyncAttachedTabs(), whose
   * tabsResyncComplete prunes any entry not in the reconciled active set. This is
   * what lets a relay-side ghost get cleaned up by the very command that missed.
   *
   * Concurrent misses coalesce onto one in-flight run: a single Chrome query plus a
   * single resync, never a scan-per-command storm.
   *
   * Note: a tab whose #tabs entry was fully evicted is treated as genuinely gone —
   * we do not re-adopt a live Chrome tab here, because its agent-ownership metadata
   * is unrecoverable and operating on an unowned tab would break authorization.
   *
   * @returns {Promise<void>}
   */
  reconcileFromChrome() {
    if (
      this.#reconcileFromChromeInFlight &&
      this.isTabsResyncCurrent(this.#reconcileFromChromeEpoch)
    ) {
      return this.#reconcileFromChromeInFlight
    }
    const epoch = this.beginTabsResync()
    this.#reconcileFromChromeEpoch = epoch
    const run = (async () => {
      try {
        const reconciled = await this.reconcileTabs({
          isCurrent: () => this.isTabsResyncCurrent(epoch),
        })
        if (!reconciled) return
        // Ordering invariant for SDK-side recovery:
        // 1) resyncAttachedTabs must stay synchronous here so its tabsResyncComplete
        //    payload is enqueued onto the shared ordered relay send chain before we
        //    resolve Extension.reconcile.
        // 2) the relay must continue handling inbound messages synchronously in wire
        //    order, so that the prune lands before the SDK re-reads list().
        // If this call becomes async, the response can race ahead of the prune and the
        // retry path will observe pre-prune relay state.
        this.resyncAttachedTabs({ epoch, authoritative: true })
      } finally {
        if (this.#reconcileFromChromeInFlight === run) {
          this.#reconcileFromChromeInFlight = null
          this.#reconcileFromChromeEpoch = 0
        }
      }
    })()
    this.#reconcileFromChromeInFlight = run
    return run
  }

  // ── Agent tab tracking ──

  registerAgentTab(tabId, { url, title, windowId, active, principalId = null, sessionGroupId = null, retained = false } = {}) {
    if ((principalId !== null || sessionGroupId !== null)
      && (typeof principalId !== 'string' || !principalId.trim()
        || typeof sessionGroupId !== 'string' || !sessionGroupId.trim())) {
      throw new TypeError('principalId and sessionGroupId must both be non-empty strings')
    }
    let entry = this.#tabs.get(tabId)
    if (entry && ((entry.createdBy && entry.createdBy !== principalId)
      || !canClaimTab(entry, principalId, sessionGroupId))) {
      throw new Error('The browser page belongs to another session group or is claimed by another executor.')
    }
    if (entry) {
      if (url !== undefined) entry.url = url
      if (title !== undefined) entry.title = title
      if (Number.isInteger(windowId)) entry.windowId = windowId
      if (typeof active === 'boolean') entry.active = active
      entry.createdByAgent = true
      entry.createdBy = principalId
      entry.claimedBy = principalId
      entry.sessionGroupId = sessionGroupId
      entry.claimedByAgent = false
      entry.retained = retained === true
      void setAgentClaimTabIndicator(tabId, false).catch(() => {})
      this.#notifyUpdated(tabId, entry)
    } else {
      entry = this.#createVirtualEntry(tabId, {
        url,
        title,
        windowId,
        active,
        createdByAgent: true,
        createdBy: principalId,
        claimedBy: principalId,
        sessionGroupId,
        retained,
      })
      this.#storeEntry(tabId, entry)
      this.#notifyDiscovered(tabId, entry)
    }
    this.#persistTabs()
    return this.#tabSnapshot(tabId, entry)
  }

  releaseAgent(tabId) {
    const entry = this.#tabs.get(tabId)
    if (!entry?.createdByAgent) return
    entry.createdByAgent = false
    entry.createdBy = null
    entry.retained = false
    this.#notifyUpdated(tabId, entry)
    this.#persistTabs()
  }

  syncAgentClaimedUserTabs(claims, commandContext) {
    const snapshot = claims.map(({ targetId, principalId, sessionGroupId }) => ({ targetId, principalId, sessionGroupId }))
    log.info('claim snapshot received:', snapshot)
    const previous = this.#claimSyncChain.catch(() => {})
    const sync = previous.then(async () => {
      if (commandContext) {
        await awaitWithDeadline(commandContext, 'tab_claim.queue_wait', () => undefined)
      }
      return this.#applyAgentClaimedUserTabs(snapshot, commandContext)
    })
    this.#claimSyncChain = sync.then(() => {}, () => {})
    if (!commandContext) return sync
    return (async () => {
      await awaitWithDeadline(commandContext, 'tab_claim.queue_wait', () => previous)
      return sync
    })()
  }

  #restoreAgentClaimIndicator(tabId) {
    const refresh = this.#claimSyncChain
      .catch(() => {})
      .then(() => {
        if (!this.#tabs.get(tabId)?.claimedByAgent) return
        return setAgentClaimTabIndicator(tabId, true)
      })
    this.#claimSyncChain = refresh.then(() => {}, () => {})
  }

  async #applyAgentClaimedUserTabs(claims, commandContext) {
    if (this.#shuttingDown) return { marked: 0, cleared: 0, ignored: claims.length }
    const desiredClaims = new Map()
    for (const claim of claims) {
      const tabId = fromVtabId(claim.targetId)
      if (tabId === null) continue
      const previous = desiredClaims.get(tabId)
      if (previous && (previous.principalId !== claim.principalId || previous.sessionGroupId !== claim.sessionGroupId)) {
        throw new Error(`Conflicting claims for browser page ${claim.targetId}.`)
      }
      desiredClaims.set(tabId, claim)
    }
    // Validate the whole snapshot before changing any native ownership or indicators.
    for (const [tabId, claim] of desiredClaims) {
      const entry = this.#tabs.get(tabId)
      if (entry && !canClaimTab(entry, claim.principalId, claim.sessionGroupId)) {
        throw new Error(`Browser page ${claim.targetId} belongs to another session group or is claimed by another executor.`)
      }
    }
    let marked = 0
    let cleared = 0
    let matched = 0
    const indicatorUpdates = []

    const metadataUpdates = []
    for (const [tabId, entry] of this.#tabs) {
      const claim = desiredClaims.get(tabId)
      const principalId = claim?.principalId ?? null
      const sessionGroupId = claim ? claim.sessionGroupId : entry.createdBy || !entry.claimedBy ? entry.sessionGroupId : null
      if (principalId) { marked += 1; matched += 1 }
      else if (entry.claimedBy) cleared += 1
      if (entry.claimedBy !== principalId || entry.sessionGroupId !== sessionGroupId) metadataUpdates.push([tabId, entry])
      entry.claimedBy = principalId
      entry.sessionGroupId = sessionGroupId
      const claimed = principalId !== null && !entry.createdByAgent
      if (claimed !== entry.claimedByAgent) {
        log.info(claimed ? 'claim user tab:' : 'unclaim user tab:', toVtabId(tabId))
        indicatorUpdates.push({ tabId, claimed })
      }
      entry.claimedByAgent = claimed
    }
    if (metadataUpdates.length) this.#persistTabs()
    for (const [tabId, entry] of metadataUpdates) this.#notifyUpdated(tabId, entry)

    const results = await Promise.allSettled(indicatorUpdates.map(({ tabId, claimed }) =>
      setAgentClaimTabIndicator(tabId, claimed, commandContext)))
    const deadlineFailure = results.find(
      (result) => result.status === 'rejected'
        && result.reason instanceof CommandDeadlineExceededError,
    )
    if (deadlineFailure) throw deadlineFailure.reason
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.warn(
          'claim indicator update failed:',
          toVtabId(indicatorUpdates[index].tabId),
          result.reason,
        )
      }
    })
    return { marked, cleared, ignored: claims.length - matched }
  }

  // ── Discovery (virtual registration) ──

  resyncAttachedTabs({ epoch, authoritative }) {
    if (!this.isTabsResyncCurrent(epoch)) return false

    let count = 0
    let hidden = 0
    let attaching = 0
    const activeVtabIds = []
    for (const [tabId, entry] of this.#tabs) {
      if (!this.#isRelayVisible(entry)) {
        hidden++
        continue
      }
      if (entry.state === 'connected') {
        const vtabId = toVtabId(tabId)
        activeVtabIds.push(vtabId)
        this.#sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              ...this.#tabMetadata(tabId, entry),
              targetInfo: {
                targetId: this.#currentTargetId(tabId, entry), type: 'page',
                title: entry.title || '', url: entry.url || '', attached: true,
              },
              waitingForDebugger: false,
              vtabId,
              ...(entry.openerVtabId ? { openerVtabId: entry.openerVtabId } : {}),
            },
          },
        })
        // Reuse the normal Target events so a new relay can reconstruct attached
        // OOPIFs. Insertion order puts parents before descendants.
        for (const [childId, attachment] of entry.childAttachments ?? []) {
          if (!entry.childSessionIds.has(childId)) continue
          this.#sendToRelay({
            method: 'forwardCDPEvent',
            params: {
              sessionId: attachment.parentSessionId,
              method: 'Target.attachedToTarget',
              params: attachment.params,
            },
          })
        }
        count++
      } else if (entry.state === 'virtual') {
        const vtabId = toVtabId(tabId)
        activeVtabIds.push(vtabId)
        this.#notifyDiscovered(tabId, entry)
      } else if (entry.state === 'attaching') {
        // Register as alive but send no event: 'attaching' is a local-only mid-handshake
        // state relay was never told about. Omitting it from activeVtabIds would make
        // tabsResyncComplete prune a tab that is currently being attached — and since
        // resync now also runs on runtime paths (route-miss self-heal, SDK reconcile),
        // that window overlaps every concurrent attach. reconcileTabs() skips this state
        // for the same reason.
        activeVtabIds.push(toVtabId(tabId))
        attaching++
      }
    }
    log.info(
      'resyncAttachedTabs: re-sent', count, 'physical attachments,',
      activeVtabIds.length - count - attaching, 'virtual tabs,',
      attaching, 'attaching tabs,', hidden, 'hidden tabs',
    )

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabsResyncComplete',
        params: {
          activeVtabIds,
          epoch,
          authoritative,
        },
      },
    })
    return true
  }

  async discoverAll(isCurrent) {
    const t0 = performance.now()
    if (!isCurrent()) return false

    const allTabs = await chrome.tabs.query({})
    if (!isCurrent()) return false
    log.debug('discoverAll: query took', (performance.now() - t0).toFixed(1), 'ms,', allTabs.length, 'tabs')

    let count = 0
    for (const tab of allTabs) {
      if (!tab.id) continue
      const known = this.#tabs.has(tab.id)
      this.discover(tab.id, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
      if (!known && this.#tabs.has(tab.id)) count++
    }
    log.info('discoverAll: registered', count, 'virtual tabs in', (performance.now() - t0).toFixed(1), 'ms')
    return true
  }

  recordNavigationTarget(tabId, sourceTabId) {
    if (
      !Number.isSafeInteger(tabId) || tabId <= 0 ||
      !Number.isSafeInteger(sourceTabId) || sourceTabId <= 0 ||
      tabId === sourceTabId
    ) return

    const openerVtabId = toVtabId(sourceTabId)
    const existing = this.#tabs.get(tabId)
    if (!existing) {
      if (!this.#pendingSourceTabByChildTab.has(tabId)) {
        this.#pendingSourceTabByChildTab.set(tabId, sourceTabId)
        if (this.#pendingSourceTabByChildTab.size > MAX_PENDING_NAVIGATION_TARGETS) {
          const oldest = this.#pendingSourceTabByChildTab.keys().next().value
          if (oldest !== undefined) this.#pendingSourceTabByChildTab.delete(oldest)
        }
        this.#notifyOpenerUpdated(tabId, openerVtabId)
        this.#persistTabs()
      }
      return
    }
    if (existing.openerVtabId) return

    existing.openerVtabId = openerVtabId
    this.#inheritDerivedAgentOwnership(tabId, existing, sourceTabId)
    this.#notifyOpenerUpdated(tabId, openerVtabId)
    this.#persistTabs()
  }

  #notifyOpenerUpdated(tabId, openerVtabId) {
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabOpenerUpdated',
        params: {
          ...(this.#tabs.has(tabId)
            ? this.#tabMetadata(tabId, this.#tabs.get(tabId))
            : { targetKey: toVtabId(tabId), vtabId: toVtabId(tabId), tabId }),
          openerVtabId,
        },
      },
    })
  }

  removeNavigationTarget(tabId) {
    if (this.#removeNavigationTargetRelations(tabId)) this.#persistTabs()
  }

  #removeNavigationTargetRelations(tabId) {
    // A source can close before its child becomes debuggable. The native opener
    // relation survives; ownership still requires the source's current claim.
    return this.#pendingSourceTabByChildTab.delete(tabId)
  }

  discover(tabId, url, title, tabMeta = {}) {
    const entry = this.#tabs.get(tabId)
    if (entry) {
      if (entry.claimedByAgent) this.#restoreAgentClaimIndicator(tabId)
      this.updateTab(tabId, url, title, tabMeta)
      return
    }
    if (isDebuggableUrl(url)) {
      const sourceTabId = this.#pendingSourceTabByChildTab.get(tabId)
      this.#pendingSourceTabByChildTab.delete(tabId)
      this.#registerUserTab(tabId, url, title, { ...tabMeta, sourceTabId })
      log.debug('discover: registered virtual tab', tabId)
    }
  }

  #registerUserTab(tabId, url, title, { sourceTabId, windowId, active } = {}) {
    const existing = this.#tabs.get(tabId)
    if (existing) return existing

    const entry = this.#createVirtualEntry(tabId, {
      url,
      title,
      windowId,
      active,
      ...(sourceTabId === undefined ? {} : { openerVtabId: toVtabId(sourceTabId) }),
    })
    this.#storeEntry(tabId, entry)
    if (sourceTabId !== undefined) this.#inheritDerivedAgentOwnership(tabId, entry, sourceTabId)
    this.#notifyDiscovered(tabId, entry)
    this.#persistTabs()
    return entry
  }

  #inheritDerivedAgentOwnership(tabId, entry, sourceTabId) {
    const source = this.#tabs.get(sourceTabId)
    const principalId = source?.claimedBy
    if (!source || entry.createdByAgent || entry.createdBy
      || (entry.claimedBy && entry.claimedBy !== principalId)
      || (entry.sessionGroupId && entry.sessionGroupId !== source.sessionGroupId)) return

    entry.sessionGroupId = source.sessionGroupId
    if (!principalId) {
      this.#notifyUpdated(tabId, entry)
      return
    }
    entry.createdByAgent = true
    entry.createdBy = principalId
    entry.claimedBy = principalId
    entry.claimedByAgent = false
    entry.retained = false
    void setAgentClaimTabIndicator(tabId, false).catch(() => {})
    this.#notifyUpdated(tabId, entry)
    void this.#group.addTab(tabId).catch((error) => log.warn('derived tab grouping failed:', tabId, error))
  }

  /**
   * Update a tracked tab's URL and/or title.
   * Sends Extension.tabUpdated to the relay so the agent side stays in sync.
   */
  updateTab(tabId, url, title, tabMeta = {}) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return

    const wasRelayVisible = this.#isRelayVisible(entry)
    let changed = false
    if (url !== undefined && url !== entry.url) { entry.url = url; changed = true }
    if (title !== undefined && title !== entry.title) { entry.title = title; changed = true }
    if (Number.isInteger(tabMeta.windowId) && tabMeta.windowId !== entry.windowId) {
      entry.windowId = tabMeta.windowId
      changed = true
    }
    if (typeof tabMeta.active === 'boolean' && tabMeta.active !== entry.active) {
      entry.active = tabMeta.active
      changed = true
    }
    if (!changed) return

    const isRelayVisible = this.#isRelayVisible(entry)
    if (!wasRelayVisible && isRelayVisible) {
      this.#notifyDiscovered(tabId, entry)
    } else if (wasRelayVisible && !isRelayVisible) {
      this.#notifyRemoved(entry.attachmentSessionId, this.#currentTargetId(tabId, entry))
    } else if (isRelayVisible) {
      this.#notifyUpdated(tabId, entry)
    }
    void this.#persistTabs()
  }

  // ── Lazy Attach (on-demand physical attachment) ──

  /**
   * Ensure the tab is physically attached via chrome.debugger.
   *
   * Returns a structured result for attach failures. A command deadline remains
   * an exception so the dispatcher can preserve its authoritative stage.
   *
   * @param {number} tabId
   * @param {any} [commandContext]
   * @returns {Promise<AttachOutcome>}
   */
  async ensureAttached(tabId, commandContext) {
    let entry = this.#tabs.get(tabId)
    if (!entry) {
      return { ok: false, code: 'not_tracked', message: `Tab ${tabId} is not tracked` }
    }
    if (!this.isInExecutionScope(tabId)) {
      return { ok: false, code: 'outside_scope', message: `Tab ${tabId} is outside the execution scope` }
    }
    if (entry.attachPermission === 'user_denied') {
      log.warn('ensureAttached: debugger permission was denied by user', tabId)
      return { ok: false, code: 'user_denied', message: `User denied debugger permission for tab ${tabId}` }
    }
    if (entry.state === 'attaching') {
      const pending = this.#pending.get(tabId)
      if (pending) return waitForPendingAttach(pending.result, commandContext)
    }

    const detaching = this.#detaching.get(tabId)
    if (detaching) {
      if (commandContext) {
        await awaitWithDeadline(commandContext, 'tab_manager.waitForDetach', () => detaching)
      } else {
        await detaching
      }
      const current = this.#tabs.get(tabId)
      if (current !== entry) {
        return current
          ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
          : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
      }
      return this.ensureAttached(tabId, commandContext)
    }

    if (entry.state === 'connected') {
      // Verify real debugger state instead of trusting cache
      try {
        const realTargetId = await this.#getRealTargetId(tabId, commandContext)
        if (realTargetId) {
          const lateBarrier = this.#detaching.get(tabId)
          if (!lateBarrier) {
            const current = this.#tabs.get(tabId)
            if (current !== entry || current.state !== 'connected'
              || !this.isInExecutionScope(tabId) || current.attachPermission === 'user_denied') {
              return { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
            }
            return { ok: true }
          }
          if (commandContext) {
            await awaitWithDeadline(commandContext, 'tab_manager.waitForDetach', () => lateBarrier)
          } else {
            await lateBarrier
          }
          const current = this.#tabs.get(tabId)
          if (current !== entry) {
            return current
              ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
              : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
          }
          return this.ensureAttached(tabId, commandContext)
        }
        // Cache says connected but real debugger is detached — re-attach
        log.warn('ensureAttached: state mismatch for tab', tabId, '(cache=connected, real=detached), re-attaching')
        this.downgradeToVirtual(tabId, 'debugger-state-mismatch', {
          queueReason: 'debugger_state_mismatch',
        })
        entry = this.#tabs.get(tabId)
        if (!entry) {
          return { ok: false, code: 'not_tracked', message: `Tab ${tabId} is not tracked` }
        }
      } catch (err) {
        if (err instanceof CommandDeadlineExceededError) throw err
        // API call failed (transient) — conservatively trust cache, assume still connected
        log.warn('ensureAttached: getRealTargetId failed for tab', tabId, ', trusting cache', err)
        return { ok: true }
      }
    }

    const lateBarrier = this.#detaching.get(tabId)
    if (lateBarrier) {
      if (commandContext) {
        await awaitWithDeadline(commandContext, 'tab_manager.waitForDetach', () => lateBarrier)
      } else {
        await lateBarrier
      }
      const current = this.#tabs.get(tabId)
      if (current !== entry) {
        return current
          ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
          : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
      }
      return this.ensureAttached(tabId, commandContext)
    }

    if (entry.state === 'attaching') {
      const pending = this.#pending.get(tabId)
      if (pending) return waitForPendingAttach(pending.result, commandContext)
    }

    if (this.#tabs.get(tabId) !== entry || !this.isInExecutionScope(tabId)
      || entry.attachPermission === 'user_denied') {
      return { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
    }
    const pending = this.#startPhysicalAttach(tabId, entry, commandContext)
    commandContext?.trackNativeOperation?.(pending.lifecycle)
    this.#pending.set(tabId, pending)
    const clearPending = () => {
      if (this.#pending.get(tabId) === pending) this.#pending.delete(tabId)
    }
    void Promise.allSettled([pending.result, pending.lifecycle]).then(clearPending)
    return waitForPendingAttach(pending.result, commandContext, false)
  }

  async #getRealTargetId(tabId, commandContext) {
    const getTargets = () => chrome.debugger.getTargets()
    const targets = commandContext
      ? await awaitWithDeadline(commandContext, 'chrome.debugger.getTargets', getTargets)
      : await getTargets()
    const match = targets.find(t => t.tabId === tabId && t.attached && t.type === 'page')
    return match?.id || null
  }

  #holdPhysicalLifecycle(tabId, lifecycle) {
    const existing = this.#detaching.get(tabId)
    const current = Promise.resolve(lifecycle)
    const barrier = existing ? Promise.allSettled([existing, current]).then((results) => {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    }) : current
    this.#detaching.set(tabId, barrier)
    const clear = () => {
      if (this.#detaching.get(tabId) === barrier) this.#detaching.delete(tabId)
    }
    void barrier.then(clear, (error) => {
      clear()
      log.warn('physical lifecycle failed:', tabId, error)
    })
    return barrier
  }

  #startPhysicalAttach(tabId, entry, commandContext) {
    let resolveLifecycle, rejectLifecycle
    let retained = false
    const lifecycle = new Promise((resolve, reject) => {
      resolveLifecycle = resolve
      rejectLifecycle = reject
    })
    this.#holdPhysicalLifecycle(tabId, lifecycle)
    const retainLifecycle = (operation) => {
      retained = true
      void Promise.resolve(operation).then(resolveLifecycle, rejectLifecycle)
    }
    const result = this.#physicalAttach(tabId, entry, commandContext, retainLifecycle)
    const finish = () => {
      if (!retained) resolveLifecycle()
    }
    void result.then(finish, finish)
    return { result, lifecycle }
  }

  #startPhysicalCleanup(tabId) {
    const cleanupStartedAt = Date.now()
    const cleanupContext = createCommandContext({
      method: ATTACH_CLEANUP_METHOD,
      sentAt: cleanupStartedAt,
      deadlineAt: cleanupStartedAt + ATTACH_CLEANUP_TIMEOUT_MS,
    })
    const entry = this.#tabs.get(tabId)
    const intent = { entry }
    this.#intentionalDetaches.set(tabId, intent)
    const operation = startDebuggerDetach(tabId, cleanupContext)
    const lifecycle = operation.settlement.then(async (settlement) => {
      if (settlement.status === 'rejected' && await this.#getRealTargetId(tabId)) {
        throw settlement.reason
      }
    }).finally(() => {
      if (this.#intentionalDetaches.get(tabId) === intent) this.#intentionalDetaches.delete(tabId)
    })
    return { result: operation.result, lifecycle }
  }

  #completePhysicalAttach(tabId, entry, realTargetId) {
    if (this.#tabs.get(tabId) !== entry || entry.state !== 'attaching') return false
    this.#setConnected(tabId, entry, realTargetId)
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          ...this.#tabMetadata(tabId, entry),
          targetInfo: {
            targetId: this.#currentTargetId(tabId, entry), type: 'page',
            title: entry.title || '', url: entry.url || '', attached: true,
          },
          waitingForDebugger: false,
          vtabId: toVtabId(tabId),
          ...(entry.openerVtabId ? { openerVtabId: entry.openerVtabId } : {}),
        },
      },
    })
    void this.#persistTabs()
    return true
  }

  async #cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle) {
    const cleanup = this.#startPhysicalCleanup(tabId)
    const reconcile = cleanup.lifecycle.then(() => {
      if (this.#tabs.get(tabId) === entry && entry.state === 'attaching') {
        this.#revertAttachingToVirtual(tabId)
      }
    })
    retainLifecycle(reconcile)
    await cleanup.result
  }

  async #physicalAttach(tabId, entry, commandContext, retainLifecycle) {
    const t0 = performance.now()
    const selection = this.#scope.current
    if (!this.#scope.allows(tabId, entry, selection)) {
      return { ok: false, code: 'outside_scope', message: `Tab ${tabId} is outside the execution scope` }
    }
    if (this.#shuttingDown) return { ok: false, code: 'shutting_down', message: 'Extension is shutting down' }
    entry.state = 'attaching'
    log.info('physicalAttach: begin', tabId)
    const attachStartedAt = commandContext?.sentAt ?? Date.now()
    const attachContext = createCommandContext({
      method: ATTACH_OPERATION_METHOD,
      sentAt: attachStartedAt,
      deadlineAt: commandContext?.deadlineAt,
    })
    attachContext.assertCurrent = () => {
      commandContext?.assertCurrent?.()
      if (this.#tabs.get(tabId) !== entry || entry.state !== 'attaching'
        || entry.attachPermission === 'user_denied' || !this.#scope.allows(tabId, entry, selection)) {
        throw new Error(`Attach for tab ${tabId} was superseded`)
      }
    }
    attachContext.onNativeOperation = (operation) => commandContext?.trackNativeOperation?.(operation)
    let attachOperation

    try {
      if (this.#shuttingDown) return { ok: false, code: 'shutting_down', message: 'Extension is shutting down' }
      attachOperation = startDebuggerAttach(tabId, attachContext)
      const { realTargetId } = await attachOperation.result

      // Guard: tab may have been removed by clearAll/detach while we were awaiting
      if (this.#tabs.get(tabId) !== entry || entry.state !== 'attaching'
        || !this.#scope.allows(tabId, entry, selection)) {
        await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
        const tracked = this.#tabs.has(tabId)
        return tracked
          ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
          : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
      }

      this.#completePhysicalAttach(tabId, entry, realTargetId)
      log.info('physicalAttach: done', tabId, 'in', (performance.now() - t0).toFixed(1), 'ms')
      return { ok: true }
    } catch (err) {
      if (err instanceof CommandDeadlineExceededError) {
        if (err.debuggerAttached) {
          await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
        } else if (err.stage === 'chrome.debugger.attach' && attachOperation) {
          const lateCleanup = attachOperation.settlement.then(async (settlement) => {
            if (settlement.status !== 'fulfilled') return
            const cleanup = this.#startPhysicalCleanup(tabId)
            await cleanup.lifecycle
          })
          retainLifecycle(lateCleanup)
          if (this.#tabs.get(tabId) === entry) this.#revertAttachingToVirtual(tabId)
        } else if (this.#tabs.get(tabId) === entry) {
          this.#revertAttachingToVirtual(tabId)
        }
        throw err
      }

      const msg = err?.message || String(err)
      if (this.#tabs.get(tabId) !== entry) {
        await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
        const tracked = this.#tabs.has(tabId)
        return tracked
          ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
          : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
      }
      if (msg.includes('Another debugger is already attached')) {
        log.info('physicalAttach: debugger already attached, completing setup', tabId)
        try {
          const { realTargetId } = await initializeAttachedDebugger(tabId, attachContext, t0)
          if (this.#tabs.get(tabId) !== entry || entry.state !== 'attaching'
        || !this.#scope.allows(tabId, entry, selection)) {
            await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
            const tracked = this.#tabs.has(tabId)
            return tracked
              ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
              : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
          }
          if (realTargetId) {
            this.#completePhysicalAttach(tabId, entry, realTargetId)
            log.info('physicalAttach: reused existing debugger', tabId, 'realTargetId:', realTargetId)
            return { ok: true }
          }
          log.warn('physicalAttach: debugger attached but getRealTargetId returned null', tabId)
          await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
          return { ok: false, code: 'attach_failed', message: `Debugger already attached to tab ${tabId} but no page target found` }
        } catch (innerErr) {
          if (innerErr instanceof CommandDeadlineExceededError) {
            await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
            throw innerErr
          }
          if (this.#tabs.get(tabId) !== entry || entry.state !== 'attaching'
        || !this.#scope.allows(tabId, entry, selection)) {
            await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
            const tracked = this.#tabs.has(tabId)
            return tracked
              ? { ok: false, code: 'attach_failed', message: `Attach for tab ${tabId} was superseded` }
              : { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
          }
          log.warn('physicalAttach: debugger setup failed', tabId, innerErr)
          await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
          return {
            ok: false,
            code: 'attach_failed',
            message: `Debugger setup failed for tab ${tabId}`,
          }
        }
      }

      /** @type {AttachOutcome} */
      let outcome = { ok: false, code: 'attach_failed', message: msg }
      try {
        if (/Tabs cannot be edited/i.test(msg)) {
          outcome = { ok: false, code: 'tab_busy', message: msg }
        } else if (FOREIGN_EXTENSION_ATTACH_ERROR_RE.test(msg)) {
          const foreignIds = await findForeignExtensionFrames(tabId, attachContext)
          outcome = { ok: false, code: 'extension_conflict', message: msg, conflictExtensionIds: foreignIds }
        }
      } finally {
        if (this.#tabs.get(tabId) === entry) {
          await this.#cleanupIncompletePhysicalAttach(tabId, entry, retainLifecycle)
        }
      }
      return outcome
    }
  }

  async attach(tabId, commandContext) {
    const existing = this.#tabs.get(tabId)
    if (existing?.attachPermission === 'user_denied') {
      log.warn('attach: debugger permission was denied by user', tabId)
      return null
    }
    if (existing?.state === 'connected' && !this.#detaching.has(tabId)
      && this.isInExecutionScope(tabId)) {
      return {
        sessionId: existing.attachmentSessionId,
        targetId: this.#currentTargetId(tabId, existing),
        vtabId: toVtabId(tabId),
      }
    }
    const wasNew = !existing
    if (wasNew) {
      let url, title, windowId, active
      try {
        const getTab = () => chrome.tabs.get(tabId)
        const tab = commandContext
          ? await awaitWithDeadline(commandContext, 'chrome.tabs.get:attach', getTab)
          : await getTab()
        url = tab.url; title = tab.title; windowId = tab.windowId; active = tab.active
      } catch (err) {
        if (err instanceof CommandDeadlineExceededError) throw err
      }
      const entry = this.#createVirtualEntry(tabId, { url, title, windowId, active })
      this.#storeEntry(tabId, entry)
    }

    const res = await this.ensureAttached(tabId, commandContext)
    if (!res.ok) {
      if (wasNew && this.#tabs.has(tabId)) this.#removeEntry(tabId)
      return null
    }

    const entry = this.#tabs.get(tabId)
    return entry
      ? {
          sessionId: entry.attachmentSessionId,
          targetId: this.#currentTargetId(tabId, entry),
          vtabId: toVtabId(tabId),
        }
      : null
  }

  // ── Detach & Close ──
  //
  // detach: debugger disconnected but the tab may still exist.
  //         Downgrades entry to virtual and notifies relay. Optionally
  //         calls chrome.debugger.detach if we are initiating the disconnect.
  //
  // close:  tab confirmed gone (chrome.tabs.onRemoved / agent close).
  //         Fully removes entry from all maps and notifies relay to delete.

  /**
   * Detach the debugger session, downgrading the entry from physical to virtual.
   * The tab itself may still exist — only the debugger link is severed.
   *
   * @param {number} tabId
   * @param {string} reason — descriptive reason for logs/relay (e.g. 'target_closed', 'idle_timeout')
   * @param {object} [opts]
   * @param {boolean} [opts.initiatedByUs] — true if we are proactively releasing the debugger
   *   (need to call chrome.debugger.detach); false if Chrome already detached it.
   * @param {number} [opts.expectedGeneration] — no-op if a replacement queue generation exists
   * @param {string} [opts.expectedAttachmentSessionId] — no-op if the tab already moved to a new epoch
   */
  async detach(
    tabId,
    reason,
    { initiatedByUs = false, expectedGeneration, expectedAttachmentSessionId } = {},
  ) {
    const entry = this.#tabs.get(tabId)
    log.info('detach:', tabId, reason, 'state:', entry?.state, 'initiatedByUs:', initiatedByUs)
    if (!entry) return
    if (
      expectedAttachmentSessionId !== undefined
      && entry.attachmentSessionId !== expectedAttachmentSessionId
    ) return
    if (
      expectedGeneration !== undefined &&
      !this.#scheduler.canDetachGeneration(
        tabId,
        expectedGeneration,
        expectedAttachmentSessionId ?? entry.attachmentSessionId,
      )
    ) return

    if (!initiatedByUs) {
      if (entry.state === 'connected') this.downgradeToVirtual(tabId, reason)
      else if (entry.state === 'attaching') this.#revertAttachingToVirtual(tabId)
      return
    }

    const wasConnected = entry.state === 'connected'
    const wasAttaching = entry.state === 'attaching'
    const pendingAttach = wasAttaching ? this.#pending.get(tabId) : undefined
    if (wasConnected) this.downgradeToVirtual(tabId, reason)
    else if (wasAttaching) this.#revertAttachingToVirtual(tabId)

    const existingBarrier = this.#detaching.get(tabId)
    if (!wasConnected && existingBarrier) return existingBarrier
    const intent = { entry }
    this.#intentionalDetaches.set(tabId, intent)
    const lifecycle = (async () => {
      if (existingBarrier) await existingBarrier
      else if (pendingAttach) await pendingAttach.lifecycle
      try {
        await chrome.debugger.detach({ tabId })
      } catch (error) {
        if (await this.#getRealTargetId(tabId)) throw error
      }
    })().finally(() => {
      if (this.#intentionalDetaches.get(tabId) === intent) this.#intentionalDetaches.delete(tabId)
    })
    this.#holdPhysicalLifecycle(tabId, lifecycle)
    return lifecycle
  }

  /**
   * Record that the relay asked for this tab's removal, before chrome.tabs.remove
   * runs. Callers must clear the mark when the tab survives (a blocked
   * beforeunload, a failed remove), or a later user close of the same reused tab
   * id would be misreported as ours.
   */
  markRelayRequestedClose(tabId) { this.#relayRequestedCloses.add(tabId) }

  clearRelayRequestedClose(tabId) { this.#relayRequestedCloses.delete(tabId) }

  /**
   * Close a tab entry — the tab is confirmed gone (e.g. chrome.tabs.onRemoved).
   * Fully removes entry from all maps, notifies relay, and cleans up debugger.
   * `closedBy` is what the caller knows about the origin; a relay-requested mark
   * still wins over it (see removeTrackedEntry).
   */
  async close(tabId, reason, { closedBy = 'cleanup' } = {}) {
    const t0 = performance.now()
    const entry = this.#tabs.get(tabId)
    log.info('close:', tabId, reason, 'state:', entry?.state)

    const wasPhysical = entry?.state === 'connected' || entry?.state === 'attaching'

    this.removeTrackedEntry(tabId, reason, { closedBy })

    if (wasPhysical) {
      await detachDebugger(tabId)
      log.debug('close: chrome.debugger cleanup', tabId, (performance.now() - t0).toFixed(1), 'ms')
    }
  }

  async clearAll() {
    const t0 = performance.now()
    this.#shuttingDown = true
    this.stopSessionIndicators()

    const physical = []
    const claimedTabIds = []
    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected' || entry.state === 'attaching') physical.push(tabId)
      if (entry.claimedByAgent) claimedTabIds.push(tabId)
    }
    const physicalCleanup = physical.map((tabId) =>
      this.detach(tabId, 'manager-clear-all', { initiatedByUs: true }),
    )
    const activeOperations = [...this.#detaching.values()]
    const physicalResults = Promise.allSettled(physicalCleanup)
    const claimIndicatorCleanup = this.#claimSyncChain
      .catch(() => {})
      .then(() =>
        Promise.allSettled(
          claimedTabIds.map((tabId) => setAgentClaimTabIndicator(tabId, false)),
        ),
      )

    log.info('clearAll:', this.#tabs.size, 'total,', physical.length, 'physically attached')

    this.#scheduler.closeAll('manager_clear_all')
    this.#tabs.clear()
    this.#pendingSourceTabByChildTab.clear()
    this.#sessionRoutes.clear()
    this.#pending.clear()
    this.#group.reset()
    this.#indicators.clear()

    const cleanupStartedAt = Date.now()
    const cleanupContext = createCommandContext({
      method: SHUTDOWN_CLEANUP_METHOD,
      sentAt: cleanupStartedAt,
      deadlineAt: cleanupStartedAt + SHUTDOWN_CLEANUP_TIMEOUT_MS,
    })
    const cleanup = Promise.allSettled([
      ...activeOperations,
      physicalResults,
      claimIndicatorCleanup,
      this.#flushTabsImmediate(),
    ])

    try {
      await awaitWithDeadline(
        cleanupContext,
        'tab_manager.clearAll',
        () => cleanup,
      )
      return await physicalResults
    } catch (error) {
      if (!(error instanceof CommandDeadlineExceededError)) throw error
      log.warn('clearAll: cleanup budget exhausted; physical barriers remain active')
      return []
    } finally {
      this.#shuttingDown = false
      log.info('clearAll: done in', (performance.now() - t0).toFixed(1), 'ms')
    }
  }

  async handleTabReplaced(addedTabId, removedTabId) {
    const previous = this.#tabs.get(removedTabId)
    const selected = this.#scope.current?.tabId === removedTabId
    const cleanup = previous && (previous.state === 'connected' || previous.state === 'attaching')
      ? this.detach(removedTabId, 'tab-replaced', { initiatedByUs: true })
      : Promise.resolve()
    void cleanup.catch(() => {})
    const pendingRelations = [...this.#pendingSourceTabByChildTab].filter(([child, source]) =>
      child === removedTabId || source === removedTabId)
    const tab = await chrome.tabs.get(addedTabId).catch(() => null)
    this.removeTrackedEntry(removedTabId, 'tab-replaced')
    for (const [child, source] of pendingRelations) {
      this.#pendingSourceTabByChildTab.set(
        child === removedTabId ? addedTabId : child,
        source === removedTabId ? addedTabId : source,
      )
    }
    if (!tab) { await cleanup; return }
    const existing = this.#tabs.get(addedTabId)
    if (!existing && !isDebuggableUrl(tab.url) && !previous) { await cleanup; return }
    const entry = this.#createVirtualEntry(addedTabId, {
      url: tab.url, title: tab.title, windowId: tab.windowId, active: tab.active,
      openerVtabId: previous?.openerVtabId,
      createdByAgent: previous?.createdByAgent,
      createdBy: previous?.createdBy,
      claimedBy: previous?.claimedBy,
      sessionGroupId: previous?.sessionGroupId,
      retained: previous?.retained,
      attachPermission: previous?.attachPermission,
    })
    if (existing?.state === 'connected' || existing?.state === 'attaching') {
      await this.detach(addedTabId, 'tab-replaced', { initiatedByUs: true })
    }
    this.#storeEntry(addedTabId, entry)
    this.#notifyDiscovered(addedTabId, entry)
    for (const [childTabId, child] of this.#tabs) {
      if (child.openerVtabId !== toVtabId(removedTabId)) continue
      child.openerVtabId = toVtabId(addedTabId)
      this.#notifyOpenerUpdated(childTabId, child.openerVtabId)
    }
    this.#persistTabs()
    await cleanup
    if (selected && isDebuggableUrl(tab.url)) await this.applyExecutionScope(addedTabId)
  }

  async performHealthCheck() {
    if (this.#shuttingDown || this.#healthCheckRunning) return
    this.#healthCheckRunning = true
    try {
      for (const [tabId, entry] of this.#tabs) {
        if (!this.isInExecutionScope(tabId) || entry.attachPermission === 'user_denied') continue
        if (this.#scope.enabled && this.#scope.current?.tabId !== tabId) continue
        if (!this.#scope.enabled && entry.state !== 'connected') continue
        const outcome = await this.ensureAttached(tabId)
        if (!outcome.ok) log.warn('health check attach failed:', tabId, outcome.code)
      }
    } finally {
      this.#healthCheckRunning = false
    }
  }

  // ── Debugger event handlers ──

  onDebuggerEvent(source, method, params) {
    const tabId = source.tabId
    if (!tabId) return
    const tab = this.#tabs.get(tabId)
    if (!tab?.attachmentSessionId || tab.state === 'virtual') return
    if (source.sessionId && !tab.childSessionIds.has(source.sessionId)) return

    if (method === 'Target.targetInfoChanged' && params?.targetInfo?.targetId === tab.realTargetId) {
      this.updateTab(tabId, params.targetInfo.url, params.targetInfo.title)
      params = { ...params, ...this.#tabMetadata(tabId, tab) }
    }
    const result = interceptEvent(method, tabId, params, {
      debuggee: source.sessionId ? { tabId, sessionId: source.sessionId } : { tabId },
      addChildSession: (childSessionId) => this.#addChildSession(
        tabId, childSessionId, source.sessionId || tab.attachmentSessionId, params,
      ),
      removeChildSession: (childSessionId) => this.#removeChildSession(tabId, childSessionId),
      log,
    })

    if (result.suppress) return

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: { sessionId: source.sessionId || tab.attachmentSessionId, method, params },
    })
  }

  async onDebuggerDetach(source, reason, { recover = true } = {}) {
    const tabId = source.tabId
    const entry = tabId ? this.#tabs.get(tabId) : undefined
    log.info('onDebuggerDetach:', tabId, reason, 'state:', entry?.state)
    if (!tabId || !entry) return false
    if (entry.state === 'virtual') {
      log.info('onDebuggerDetach: entry already virtual, skipping stale event', tabId)
      return false
    }

    const intentional = this.#intentionalDetaches.get(tabId)?.entry === entry
    const observedSessionId = entry.attachmentSessionId
    if (source.sessionId && source.sessionId !== observedSessionId) {
      log.info('onDebuggerDetach: source session is stale, skipping', tabId)
      return false
    }
    const wasAttaching = entry.state === 'attaching'
    const pendingAttach = wasAttaching ? this.#pending.get(tabId) : undefined
    if (pendingAttach) await pendingAttach.lifecycle

    let realTargetId
    try {
      realTargetId = await this.#getRealTargetId(tabId)
    } catch (error) {
      // A later command reconciles the debugger state in ensureAttached(). Failing open here
      // prevents an ambiguous old detach event from retiring a replacement attachment.
      log.warn('onDebuggerDetach: getRealTargetId failed, leaving state unchanged', tabId, error)
      return false
    }

    const current = this.#tabs.get(tabId)
    if (current !== entry || current.attachmentSessionId !== observedSessionId) {
      log.info('onDebuggerDetach: attachment changed while confirming, skipping', tabId)
      return false
    }
    if (realTargetId) {
      log.info('onDebuggerDetach: debugger is currently attached, ignoring stale event', tabId)
      return false
    }

    // Chrome is still detached for the exact attachment observed by this event.
    // If the tab truly closed, chrome.tabs.onRemoved will call close() to fully remove it.
    if (reason === 'canceled_by_user') {
      current.attachPermission = 'user_denied'
      this.#persistTabs()
    }
    if (current.state === 'connected') await this.detach(tabId, reason)
    else if (current.state === 'attaching') this.#revertAttachingToVirtual(tabId)
    else if (!wasAttaching) return false
    const shouldRecover = typeof recover === 'function' ? recover() : recover
    if (shouldRecover && !intentional && !this.#shuttingDown && this.#scope.enabled
      && reason !== 'canceled_by_user' && this.isInExecutionScope(tabId)) {
      await this.ensureAttached(tabId)
    }
    return true
  }

  // ── Private helpers ──

  #removeEntry(tabId, queueReason = 'tab_closed', { persist = true, removeNavigationTargets = true } = {}) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return false

    this.#scheduler.closeTab(tabId, queueReason)
    this.#unindexEntry(tabId, entry)
    this.#tabs.delete(tabId)
    if (removeNavigationTargets) this.#removeNavigationTargetRelations(tabId)
    this.#indicators.removeTab(tabId)
    if (persist) this.#persistTabs()
    return true
  }

  /**
   * Remove a tracked tab entry and notify relay with the appropriate event.
   * - virtual / attaching (never successfully attached) → Extension.tabRemoved
   * - connected (real physical target) → Target.detachedFromTarget
   *   For tab-closed specifically, also send Extension.tabRemoved(vtabId) as
   *   a belt-and-suspenders authoritative close signal so the relay can
   *   unconditionally delete the vtab entry even if reason field drifts.
   * After notification, the local entry is fully deleted.
   */
  removeTrackedEntry(tabId, reason, { persist = true, closedBy = 'cleanup', removeNavigationTargets = true } = {}) {
    // Consume the mark even for an untracked tab, so it cannot outlive this close
    // and attach itself to a future tab that reuses the id.
    const relayRequested = this.#relayRequestedCloses.delete(tabId)
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    // Ownership must be read while the entry still exists — this is the only
    // first-hand answer to "was the tab the agent's".
    const attribution = {
      closedBy: relayRequested ? 'relay' : closedBy,
      agentTab: entry.createdByAgent === true || entry.claimedByAgent === true,
    }
    // Only 'connected' is truly physical (has a real targetId from Chrome debugger).
    // 'attaching' is still mid-handshake with a vtab-* targetId — never broadcast
    // as attached, so should not broadcast detached either.
    const wasPhysical = entry.state === 'connected'
    const targetId = this.#currentTargetId(tabId, entry)
    if (wasPhysical) {
      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: entry.attachmentSessionId, targetId, reason },
        },
      })
      // True close: also send Extension.tabRemoved(vtabId) as authoritative signal.
      if (reason === 'tab-closed' || reason === 'tab-replaced') {
        this.#notifyRemoved(entry.attachmentSessionId, toVtabId(tabId), attribution)
      }
    } else {
      this.#notifyRemoved(entry.attachmentSessionId, targetId, attribution)
    }
    this.#removeEntry(tabId, String(reason || 'tab_closed').replaceAll('-', '_'), { persist, removeNavigationTargets })
  }

  /**
   * Downgrade a physical entry back to virtual and notify relay.
   * Sends Target.detachedFromTarget for the old physical, then
   * Extension.tabDiscovered to re-register as virtual.
   * The local entry is updated in-place (not deleted).
   */
  downgradeToVirtual(
    tabId,
    reason,
    { queueReason = 'debugger_detached', persist = true } = {},
  ) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    if (entry.state !== 'connected') {
      log.info('downgradeToVirtual: skipping, entry not connected', tabId, entry.state)
      return
    }
    const oldTargetId = this.#currentTargetId(tabId, entry)
    const oldSessionId = entry.attachmentSessionId
    this.#scheduler.closeTab(tabId, queueReason, {
      expectedAttachmentSessionId: oldSessionId,
    })
    // Notify relay: old physical is gone
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: oldSessionId, targetId: oldTargetId, reason },
      },
    })
    // Update local state back to virtual. This also clears child-session routes.
    this.#setVirtual(tabId, entry, { rotateSession: true })
    this.#notifyDiscovered(tabId, entry)
    if (persist) this.#persistTabs()
  }

  /**
   * Revert an 'attaching' entry back to virtual.
   * Since 'attaching' is a local-only transitional state (relay was never notified
   * of a physical attach), no relay notification is needed — just fix local state.
   */
  #revertAttachingToVirtual(tabId) {
    const entry = this.#tabs.get(tabId)
    if (!entry || entry.state !== 'attaching') return
    this.#setVirtual(tabId, entry)
    log.info('revertAttachingToVirtual:', tabId)
    void this.#persistTabs()
  }

  /**
   * Notify relay that a target/session it sent us is stale (route miss).
   * Called for a target-only route miss — we have no local entry,
   * so we use the relay-provided sessionId/targetId to send the right cleanup event.
   * Explicit stale-session errors must never call this method.
   */
  notifyStaleTarget(sessionId, targetId) {
    if (!sessionId && !targetId) return
    const isKnownVirtual = targetId && targetId.startsWith('vtab-')
    if (isKnownVirtual) {
      // Definitely virtual — tabRemoved is sufficient
      this.#notifyRemoved(sessionId, targetId)
    } else {
      // Either physical (has real targetId) or unknown (no targetId, only sessionId).
      // Send Target.detachedFromTarget so CDP clients get the detach broadcast,
      // then also send Extension.tabRemoved as belt-and-suspenders cleanup for
      // any virtual-only entries relay might hold under the same session/target.
      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId, reason: 'stale-route-miss' },
        },
      })
      this.#notifyRemoved(sessionId, targetId)
    }
    log.info('notifyStaleTarget: sent cleanup event for', { sessionId, targetId, isKnownVirtual })
  }

  /**
   * @param {{closedBy: 'relay' | 'external' | 'cleanup', agentTab: boolean}} [attribution]
   *   How the tab left. Absent means the caller cannot tell — reported as
   *   'cleanup' rather than guessed, because a wrong attribution is worse for
   *   diagnosis than a missing one.
   */
  #notifyRemoved(sessionId, targetId, attribution) {
    if (!sessionId && !targetId) return
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabRemoved',
        params: {
          sessionId,
          targetId,
          closedBy: attribution?.closedBy ?? 'cleanup',
          ...(attribution ? { agentTab: attribution.agentTab } : {}),
        },
      },
    })
  }
}
