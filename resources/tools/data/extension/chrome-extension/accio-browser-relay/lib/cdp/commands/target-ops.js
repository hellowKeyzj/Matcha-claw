/**
 * Target.* CDP command handlers.
 *
 * Handles tab creation, closing, activation, and agent tab lifecycle
 * through Chrome extension APIs rather than raw CDP.
 *
 * @param {import('../tabs/manager.js').TabManager} mgr
 */

import { TARGET_CREATE_DELAY, DEFAULT_MAX_RETAINED_TABS, CDP_COMMAND_TIMEOUT, RUNTIME_ENABLE_DELAY, withTimeout } from './utils.js'
import { createLogger } from '../../logger.js'

const log = createLogger('target-ops')
const OPEN_TARGET_READY_TIMEOUT_MS = 15_000
const OPEN_TARGET_READY_POLL_INTERVAL_MS = 100

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isInteractiveReadyState(value) {
  return value === 'interactive' || value === 'complete'
}

function isRequestedUrlReady(requestedUrl, currentUrl) {
  if (requestedUrl === 'about:blank') {
    return currentUrl === 'about:blank'
  }
  return Boolean(currentUrl && currentUrl !== 'about:blank')
}

async function enableRuntime(debuggerSession) {
  try {
    await chrome.debugger.sendCommand(debuggerSession, 'Runtime.disable')
    await delay(RUNTIME_ENABLE_DELAY)
  } catch (err) {
    log.debug('Target.createTarget Runtime.disable pre-step failed', err)
  }
  await withTimeout(
    chrome.debugger.sendCommand(debuggerSession, 'Runtime.enable'),
    CDP_COMMAND_TIMEOUT,
    'Runtime.enable',
  )
}

async function readPageReadyState(debuggerSession) {
  const frameTree = await withTimeout(
    chrome.debugger.sendCommand(debuggerSession, 'Page.getFrameTree'),
    CDP_COMMAND_TIMEOUT,
    'Page.getFrameTree',
  )
  const mainFrameUrl = typeof frameTree?.frameTree?.frame?.url === 'string'
    ? frameTree.frameTree.frame.url
    : ''

  let readyState = ''
  try {
    const evaluation = await withTimeout(
      chrome.debugger.sendCommand(debuggerSession, 'Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }),
      CDP_COMMAND_TIMEOUT,
      'Runtime.evaluate',
    )
    readyState = typeof evaluation?.result?.value === 'string'
      ? evaluation.result.value
      : ''
  } catch (error) {
    readyState = ''
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { mainFrameUrl, readyState },
    )
  }

  return { mainFrameUrl, readyState }
}

async function waitForPageReady(debuggerSession, requestedUrl) {
  const deadline = Date.now() + OPEN_TARGET_READY_TIMEOUT_MS
  let lastMainFrameUrl = ''
  let lastReadyState = ''
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const { mainFrameUrl, readyState } = await readPageReadyState(debuggerSession)
      lastMainFrameUrl = mainFrameUrl
      lastReadyState = readyState
      if (isRequestedUrlReady(requestedUrl, mainFrameUrl) && isInteractiveReadyState(readyState)) {
        return { mainFrameUrl, readyState }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastMainFrameUrl = typeof error?.mainFrameUrl === 'string' ? error.mainFrameUrl : lastMainFrameUrl
      lastReadyState = typeof error?.readyState === 'string' ? error.readyState : lastReadyState
    }
    await delay(OPEN_TARGET_READY_POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out waiting for page ready url="${requestedUrl}" mainFrameUrl="${lastMainFrameUrl}" readyState="${lastReadyState}" lastError="${lastError}"`,
  )
}

async function navigateAttachedTab(tabId, requestedUrl) {
  const debuggerSession = { tabId }
  await withTimeout(
    chrome.debugger.sendCommand(debuggerSession, 'Page.enable'),
    CDP_COMMAND_TIMEOUT,
    'Page.enable',
  )
  await withTimeout(
    chrome.debugger.sendCommand(debuggerSession, 'Page.setLifecycleEventsEnabled', { enabled: true }),
    CDP_COMMAND_TIMEOUT,
    'Page.setLifecycleEventsEnabled',
  )
  await enableRuntime(debuggerSession)

  if (requestedUrl !== 'about:blank') {
    const navigateResult = await withTimeout(
      chrome.debugger.sendCommand(debuggerSession, 'Page.navigate', { url: requestedUrl }),
      CDP_COMMAND_TIMEOUT,
      'Page.navigate',
    )
    if (typeof navigateResult?.errorText === 'string' && navigateResult.errorText.trim()) {
      throw new Error(`Page.navigate failed: ${navigateResult.errorText}`)
    }
  }

  return await waitForPageReady(debuggerSession, requestedUrl)
}

export function createTargetOps(mgr) {

  async function cdpCreateTarget(params) {
    const requestedUrl = typeof params?.url === 'string' ? params.url : 'about:blank'
    const creationUrl = 'about:blank'
    const createInWindow = params?.createInWindow === true || params?.type === 'window'
    const retain = params?.retain === true
    const maxRetained = typeof params?.maxRetainedTabs === 'number' ? params.maxRetainedTabs : DEFAULT_MAX_RETAINED_TABS

    if (retain && mgr.retainedTabCount >= maxRetained) {
      throw new Error(`Cannot retain: already at max (${maxRetained}). Close retained tabs or set retain=false.`)
    }

    log.info('Target.createTarget start', {
      requestedUrl,
      creationUrl,
      createInWindow,
      retain,
      maxRetained,
    })

    let tab
    if (createInWindow) {
      const win = await chrome.windows.create({ url: creationUrl, focused: false })
      tab = win.tabs?.[0]
      if (!tab?.id) throw new Error('Failed to create window')
    } else {
      const selectedWindowId = mgr.selectedWindowId
      tab = await chrome.tabs.create({
        url: creationUrl,
        active: false,
        ...(Number.isInteger(selectedWindowId) ? { windowId: selectedWindowId } : {}),
      })
      if (!tab.id) throw new Error('Failed to create tab')
    }
    log.info('Target.createTarget chrome.tabs/windows created', {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      requestedUrl,
      pendingUrl: tab.url ?? creationUrl,
    })
    mgr.markAgent(tab.id, retain)
    if (!createInWindow) {
      await mgr.addToAgentGroup(tab.id)
    }
    await new Promise((r) => setTimeout(r, TARGET_CREATE_DELAY))
    const attached = await mgr.attach(tab.id, { manual: true })
    if (!attached) {
      log.warn('Target.createTarget attach failed', { tabId: tab.id, requestedUrl })
      mgr.deleteAgent(tab.id)
      await chrome.tabs.remove(tab.id).catch(() => {})
      throw new Error('Failed to attach debugger to new tab')
    }
    log.info('Target.createTarget attached', {
      tabId: tab.id,
      sessionId: attached.sessionId,
      targetId: attached.targetId,
      requestedUrl,
      attachedUrl: attached.url ?? creationUrl,
      retain,
    })

    const entry = mgr.get?.(tab.id)
    log.info('Target.createTarget bootstrap start', {
      tabId: tab.id,
      sessionId: entry?.sessionId ?? attached.sessionId,
      targetId: entry?.targetId ?? attached.targetId,
      requestedUrl,
    })

    const ready = await navigateAttachedTab(tab.id, requestedUrl)
    const currentTab = typeof chrome.tabs.get === 'function'
      ? await chrome.tabs.get(tab.id).catch(() => null)
      : null
    mgr.updateTab?.(
      tab.id,
      currentTab?.url ?? ready.mainFrameUrl,
      currentTab?.title ?? entry?.title,
      {
        windowId: currentTab?.windowId ?? entry?.windowId ?? tab.windowId ?? null,
        active: currentTab?.active ?? entry?.active ?? false,
      },
    )
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {})
    const readyWindowId = currentTab?.windowId ?? entry?.windowId ?? tab.windowId ?? null
    if (Number.isInteger(readyWindowId)) {
      await chrome.windows.update(readyWindowId, { focused: true }).catch(() => {})
    }
    mgr.setActiveTab(tab.id, readyWindowId)
    mgr.updateTab?.(
      tab.id,
      currentTab?.url ?? ready.mainFrameUrl,
      currentTab?.title ?? entry?.title,
      {
        windowId: readyWindowId,
        active: true,
      },
    )
    mgr.announceCurrentTarget?.(tab.id)
    log.info('Target.createTarget ready', {
      tabId: tab.id,
      sessionId: entry?.sessionId ?? attached.sessionId,
      targetId: entry?.targetId ?? attached.targetId,
      requestedUrl,
      readyUrl: currentTab?.url ?? ready.mainFrameUrl,
      readyState: ready.readyState,
    })

    return { targetId: attached.targetId, retained: retain }
  }

  async function cdpCloseTarget(params, fallbackTabId) {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? mgr.getByTargetId(target) : fallbackTabId
    if (!toClose) {
      return {
        success: false,
        error: target
          ? `Tab with targetId "${target}" not found. It may have already been closed or detached.`
          : 'No target specified and no fallback tab available.',
      }
    }
    if (!mgr.isAgent(toClose)) {
      return {
        success: false,
        error: 'Cannot close this tab: it was not created by the agent. Only tabs opened via action=open can be closed.',
      }
    }
    if (mgr.isRetained(toClose)) {
      return { success: true, skipped: true, reason: 'Tab is retained — close skipped.' }
    }
    mgr.deleteAgent(toClose)
    try {
      await chrome.tabs.remove(toClose)
      return { success: true }
    } catch (err) {
      return { success: false, error: `Failed to remove tab ${toClose}: ${err?.message || err}` }
    }
  }

  async function cdpCloseAllAgentTabs() {
    const toClose = []
    let retained = 0
    for (const [id] of mgr.agentTabs.entries()) {
      if (mgr.isRetained(id)) { retained++; continue }
      toClose.push(id)
    }
    const results = await Promise.allSettled(toClose.map((id) => chrome.tabs.remove(id)))
    for (let i = 0; i < toClose.length; i++) {
      if (results[i].status === 'fulfilled') mgr.deleteAgent(toClose[i])
    }
    const closed = results.filter((r) => r.status === 'fulfilled').length
    return { success: true, closed, retained }
  }

  async function cdpActivateTarget(params, fallbackTabId) {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? mgr.getByTargetId(target) : fallbackTabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    mgr.setActiveTab(toActivate, tab.windowId ?? null)
    mgr.updateTab(toActivate, tab.url, tab.title, {
      windowId: tab.windowId ?? null,
      active: true,
    })

    // Ensure the tab is physically attached so Playwright can operate on it
    const entry = mgr.get(toActivate)
    if (entry && entry.state !== 'connected') {
      await mgr.ensureAttached(toActivate, { manual: true }).catch(() => {})
    }

    mgr.announceCurrentTarget?.(toActivate)

    return {}
  }

  return { cdpCreateTarget, cdpCloseTarget, cdpCloseAllAgentTabs, cdpActivateTarget }
}
