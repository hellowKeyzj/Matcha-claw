/**
 * CDP command dispatch — main routing logic.
 *
 * Routes incoming forwardCDPCommand messages to the appropriate handler:
 *   Target.*     → target-ops.js   (tab creation, closing, activation)
 *   Extension.*  → content_script/extension-ops.js / cookie-ops.js (viewport, content, elements, cookies)
 *   Other CDP    → chrome.debugger.sendCommand (transparent forwarding)
 *
 * @param {import('../tabs/manager.js').TabManager} mgr
 * @returns {(msg: any) => Promise<any>}
 */

import { createTargetOps } from './target-ops.js'
import {
  extGetViewportInfo, extEnsureZoom, extCaptureViewport,
  extExtractContent, extMarkElements, extClick, extInput,
} from '../../content_script/extension-ops.js'
import { extClearCookies, extGetCookies, extSetCookies } from './cookie-ops.js'
import { RUNTIME_ENABLE_DELAY, CDP_COMMAND_TIMEOUT, withTimeout } from './utils.js'
import { createLogger } from '../../logger.js'

const MAX_QUEUE_DEPTH = 100
const _tabQueues = new Map()
const log = createLogger('dispatch')

function shouldTraceMethod(method) {
  return [
    'Target.createTarget',
    'Target.attachToTarget',
    'Target.getTargetInfo',
    'Target.setAutoAttach',
    'Page.enable',
    'Page.getFrameTree',
    'Page.setLifecycleEventsEnabled',
    'Runtime.enable',
    'Log.enable',
  ].includes(method)
}

function getTabQueue(tabId) {
  if (!tabId) return null
  let q = _tabQueues.get(tabId)
  if (!q) {
    q = { running: false, queue: [] }
    _tabQueues.set(tabId, q)
  }
  return q
}

async function processQueue(q) {
  if (q.running) return
  q.running = true
  try {
    while (q.queue.length > 0) {
      const { task, resolve, reject } = q.queue.shift()
      try {
        resolve(await task())
      } catch (err) {
        reject(err)
      }
    }
  } finally {
    q.running = false
  }
}

function enqueueForTab(tabId, task) {
  const q = getTabQueue(tabId)
  if (!q) return task()
  if (q.queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error(`Tab ${tabId} command queue full (${MAX_QUEUE_DEPTH})`))
  }
  return new Promise((resolve, reject) => {
    q.queue.push({ task, resolve, reject })
    processQueue(q)
  })
}

export function cleanupTabQueue(tabId) {
  _tabQueues.delete(tabId)
}

export function cleanupAllTabQueues() {
  _tabQueues.clear()
}

export function createDispatcher(mgr) {

  const { cdpCreateTarget, cdpCloseTarget, cdpCloseAllAgentTabs, cdpActivateTarget } = createTargetOps(mgr)

  async function cdpRuntimeEnable(debuggerSession, params) {
    try {
      await chrome.debugger.sendCommand(debuggerSession, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, RUNTIME_ENABLE_DELAY))
    } catch (err) {
      console.debug('[matchaclaw-relay] Runtime.disable pre-step failed:', err)
    }
    return withTimeout(
      chrome.debugger.sendCommand(debuggerSession, 'Runtime.enable', params),
      CDP_COMMAND_TIMEOUT,
      'Runtime.enable',
    )
  }

  return async function handleForwardCdpCommand(msg) {
    const method = String(msg?.params?.method || '').trim()
    const params = msg?.params?.params || undefined
    const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined
    const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
    const tabId = mgr.resolveTabId(sessionId, targetId)

    if (shouldTraceMethod(method)) {
      log.info('forwardCDPCommand received', {
        method,
        sessionId: sessionId || null,
        targetId: targetId || null,
        tabId,
        url: typeof params?.url === 'string' ? params.url : null,
      })
    }

    return enqueueForTab(tabId, async () => {
      // ── Target.* commands (no tabId required for createTarget) ──
      if (method === 'Target.createTarget') {
        const result = await cdpCreateTarget(params)
        log.info('forwardCDPCommand Target.createTarget result', result)
        return result
      }
      if (method === 'Target.closeAllAgentTabs') return cdpCloseAllAgentTabs()

      if (!tabId) throw new Error(`No attached tab for method ${method}`)

      mgr.onCdpCommand?.(tabId)

      if (method === 'Target.closeTarget') return cdpCloseTarget(params, tabId)
      if (method === 'Target.activateTarget') return cdpActivateTarget(params, tabId)

      // ── Extension.* virtual commands ──
      if (method === 'Extension.getViewportInfo') {
        await mgr.ensureAttached(tabId)
        return extGetViewportInfo(tabId)
      }
      if (method === 'Extension.ensureZoom') return extEnsureZoom(tabId, params)
      if (method === 'Extension.captureViewport') {
        await mgr.ensureAttached(tabId)
        return extCaptureViewport(tabId, params)
      }
      if (method === 'Extension.extractContent') return extExtractContent(tabId)
      if (method === 'Extension.getCookies') return extGetCookies(tabId)
      if (method === 'Extension.setCookies') return extSetCookies(tabId, params)
      if (method === 'Extension.clearCookies') return extClearCookies(tabId)
      if (method === 'Extension.markElements') return extMarkElements(tabId, params)
      if (method === 'Extension.click') return extClick(tabId, params)
      if (method === 'Extension.input') return extInput(tabId, params)
      // ── Standard CDP forwarding (requires debugger attach) ──
      const ok = await mgr.ensureAttached(tabId)
      if (!ok) throw new Error(`Failed to attach debugger to tab ${tabId} for ${method}`)

      /** @type {chrome.debugger.DebuggerSession} */
      const debuggee = { tabId }
      const tabState = mgr.get(tabId)
      const mainSessionId = tabState?.sessionId
      const debuggerSession =
        sessionId && mainSessionId && sessionId !== mainSessionId
          ? { ...debuggee, sessionId }
          : debuggee

      if (method === 'Runtime.enable') return cdpRuntimeEnable(debuggerSession, params)

      const result = await withTimeout(
        chrome.debugger.sendCommand(debuggerSession, method, params),
        CDP_COMMAND_TIMEOUT,
        method,
      )
      if (shouldTraceMethod(method)) {
        log.info('forwardCDPCommand forwarded result', {
          method,
          sessionId: sessionId || null,
          tabId,
          resultTargetId: typeof result?.targetId === 'string' ? result.targetId : null,
          infoTargetId: typeof result?.targetInfo?.targetId === 'string' ? result.targetInfo.targetId : null,
        })
      }
      return result
    })
  }
}
