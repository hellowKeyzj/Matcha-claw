/**
 * CDP command dispatch — main routing logic.
 *
 * Routes incoming forwardCDPCommand messages to the appropriate handler:
 *   Target.*     → target-ops.js   (tab creation, closing, activation)
 *   Extension.*  → content_script/extension-ops.js (viewport, content, elements, actions)
 *   Other CDP    → chrome.debugger.sendCommand (transparent forwarding)
 *
 * @param {import('../tabs/manager.js').TabManager} mgr
 * @returns {(msg: any, commandContext?: any) => Promise<any>}
 */

import { createTargetOps } from './target-ops.js'
import { extGetCookies, extSetCookies, extClearCookies } from './cookie-ops.js'
import {
  extGetViewportInfo,
  extEnsureZoom,
  extCaptureViewport,
  extExtractContent,
  extMarkElements,
  extClick,
  extInput,
} from '../../content_script/extension-ops.js'
import { armDownloadWatch, disarmDownloadWatch, startDownload, queryDownloadWatch } from '../../downloads/tracker.js'
import { createDownloadResourceStore } from '../../downloads/resource-stream.js'
import {
  CommandDeadlineExceededError,
  DEFAULT_CDP_OPERATION_TIMEOUT_MS,
  awaitWithDeadline,
  createCommandContext,
  getCdpOperationTimeoutMs,
} from './deadline.js'
import { RUNTIME_ENABLE_DELAY } from './utils.js'
import { CdpCommandRouteError } from './route-error.js'
import { TabCommandQueueOverloadedError } from './tab-command-scheduler.js'
import { createLogger } from '../../logger.js'
import { recordCommandDiagnostic } from './diagnostics.js'

const log = createLogger('cdp:dispatch')
const SLOW_COMMAND_STAGE_MS = 2_000

const FETCH_UNBLOCK_METHODS = new Set([
  'Fetch.continueRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Runtime.runIfWaitingForDebugger',
])

// Methods scoped to the tab itself rather than to an execution context. For these the
// sessionId is only a lookup key for the tabId — Target.closeTarget executes through
// chrome.tabs.remove and never issues a CDP command — so a replaced session is not a
// reason to refuse: re-resolving by targetId reaches the same tab with the same result.
// Keep this list minimal; anything that reads or mutates page state does not belong here.
const SESSION_AGNOSTIC_METHODS = new Set(['Target.closeTarget'])

export function createDispatcher(mgr, scheduler, { slowCommandStageMs = SLOW_COMMAND_STAGE_MS } = {}) {
  if (!scheduler) throw new TypeError('createDispatcher requires a shared TabCommandScheduler')
  const downloadResources = createDownloadResourceStore()

  const {
    drainSessionCreates,
    cdpCreateTarget,
    cdpCloseTarget,
    cdpCloseAgentTabsByIds,
    cdpCloseAllAgentTabs,
    cdpActivateTarget,
  } = createTargetOps(mgr, scheduler)

  async function cdpRuntimeEnable(debuggee, params, assertCurrent, commandContext) {
    try {
      await awaitWithDeadline(
        commandContext,
        'chrome.debugger.sendCommand:Runtime.disable',
        () => chrome.debugger.sendCommand(debuggee, 'Runtime.disable'),
        { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS, native: true },
      )
    } catch (err) {
      if (err instanceof CommandDeadlineExceededError) throw err
      assertCurrent()
      log.debug('Runtime.disable pre-step failed:', err)
    }

    assertCurrent()
    await awaitWithDeadline(commandContext, 'Runtime.enable:delay',
      () => new Promise((resolve) => setTimeout(resolve, RUNTIME_ENABLE_DELAY)))

    assertCurrent()
    return awaitWithDeadline(
      commandContext,
      'chrome.debugger.sendCommand:Runtime.enable',
      () => chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params),
      { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS, native: true },
    )
  }

  function throwRouteError(route, method, sessionId, targetId) {
    if (route.code === 'target_not_found') {
      mgr.notifyStaleTarget(undefined, targetId)
    }
    throw new CdpCommandRouteError({ code: route.code, method, sessionId, targetId })
  }

  return async function handleForwardCdpCommand(msg, commandContext) {
    const method = String(msg?.params?.method || '').trim()
    const params = msg?.params?.params || undefined
    commandContext ??= createCommandContext({
      requestId: msg?.id,
      method,
      sentAt: msg?.sentAt,
      deadlineAt: msg?.deadlineAt,
    })
    if (commandContext) {
      await awaitWithDeadline(commandContext, 'command_dispatch', () => undefined)
    }
    const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined
    // Target identity can be carried by the routing envelope or command parameters.
    const targetId =
      (typeof msg?.params?.targetId === 'string' ? msg.params.targetId : undefined) ??
      (typeof params?.targetId === 'string' ? params.targetId : undefined)

    // Resource reads bypass renderer queues so cancel can interrupt a pending read.
    if (['Extension.openDownloadResource', 'Extension.readDownloadResource',
      'Extension.cancelDownloadResource'].includes(method)) {
      const route = mgr.resolveCommandRoute(sessionId, targetId, { allowTargetFallback: false })
      if (method !== 'Extension.cancelDownloadResource' && !route.ok) {
        throwRouteError(route, method, sessionId, targetId)
      }
      if (method !== 'Extension.cancelDownloadResource' && !mgr.isInExecutionScope(route.tabId)) {
        throw new CdpCommandRouteError({ code: 'outside_scope', method, sessionId, targetId })
      }
      const resourceContext = { ...commandContext, targetId, tabId: route.tabId ?? -1 }
      if (method === 'Extension.openDownloadResource') return downloadResources.open(params, resourceContext)
      if (method === 'Extension.readDownloadResource') return downloadResources.read(params, resourceContext)
      return downloadResources.cancel(params, resourceContext)
    }

    // Global: must run BEFORE resolveTabId — these commands don't target a specific tab.
    if (method === 'Extension.syncAgentClaimedUserTabs') {
      if (
        !Array.isArray(params?.claims) ||
        params.claims.some((claim) => typeof claim?.targetId !== 'string' || !claim.targetId
          || typeof claim.principalId !== 'string' || !claim.principalId.trim()
          || (claim.sessionGroupId !== null
            && (typeof claim.sessionGroupId !== 'string' || !claim.sessionGroupId.trim())))
      ) {
        throw new TypeError('Extension.syncAgentClaimedUserTabs requires claims with targetId, principalId and sessionGroupId (string or null)')
      }
      const cleanup = params.cleanup
      if (cleanup !== undefined) {
        if (!cleanup || (cleanup.scope !== 'executor' && cleanup.scope !== 'group')
          || typeof cleanup.principalId !== 'string' || !cleanup.principalId.trim()
          || typeof cleanup.sessionGroupId !== 'string' || !cleanup.sessionGroupId.trim()) {
          throw new TypeError('cleanup requires scope, principalId and sessionGroupId')
        }
        await drainSessionCreates(cleanup)
        const matches = (tab) => cleanup.scope === 'group'
          ? tab.sessionGroupId === cleanup.sessionGroupId
          : tab.claimedBy === cleanup.principalId
        await scheduler.drainTabs(mgr.listTabSnapshots().filter(matches).map((tab) => tab.tabId))
        const claims = params.claims.filter((claim) => cleanup.scope === 'group'
          ? claim.sessionGroupId !== cleanup.sessionGroupId
          : claim.principalId !== cleanup.principalId)
        return mgr.syncAgentClaimedUserTabs(claims, commandContext)
      }
      return mgr.syncAgentClaimedUserTabs(params.claims, commandContext)
    }
    // 下载归属窗口：chrome.downloads 是浏览器全局的，不绑定 tab。
    if (method === 'Extension.armDownloadWatch') {
      return armDownloadWatch(params, commandContext)
    }
    if (method === 'Extension.queryDownloadWatch') {
      return queryDownloadWatch(params, commandContext)
    }
    if (method === 'Extension.disarmDownloadWatch') {
      return disarmDownloadWatch(params, commandContext)
    }
    if (method === 'Extension.startDownload') {
      return startDownload(params, commandContext)
    }
    // Ground-truth reconcile driven from the SDK/relay side. A TabNotFound raised
    // at the top layer (stale SDK registry / relay ghost) never sends a per-tab
    // command down here, so the dispatch-level self-heal below can't fire. This
    // lets the SDK actively drive the same Chrome reconcile + full relay resync,
    // then re-read the corrected relay state and compensate-retry once.
    if (method === 'Extension.reconcile') {
      const reconcile = () => mgr.reconcileFromChrome()
      if (commandContext) {
        await awaitWithDeadline(commandContext, 'reconcileFromChrome', reconcile)
      } else {
        await reconcile()
      }
      return { ok: true }
    }
    if (method === 'Target.createTarget') return cdpCreateTarget(params, commandContext)
    if (method === 'Target.closeAgentTabsByIds') return cdpCloseAgentTabsByIds(params, commandContext)
    if (method === 'Target.closeAllAgentTabs') return cdpCloseAllAgentTabs(params, commandContext)

    const routeOptions = { allowTargetFallback: SESSION_AGNOSTIC_METHODS.has(method) }
    let route = mgr.resolveCommandRoute(sessionId, targetId, routeOptions)
    if (route.degradedFromSession) {
      // warn, not info: info/debug are DEBUG-gated and invisible in released builds, and
      // this is the only evidence that the fallback carried a command that would have failed.
      log.warn(
        'route degraded from stale session to targetId:',
        `method=${method}`,
        `staleSessionId=${sessionId}`,
        `targetId=${targetId}`,
        `tabId=${route.tabId}`,
      )
    }

    // ── Route-miss self-heal ──
    // A target_not_found miss means we no longer track this tab at all — our
    // in-memory view may have drifted from Chrome. Reconcile against Chrome ground
    // truth (which also resyncs relay, pruning ghosts) and re-resolve once.
    //
    // A stale_session miss is deliberately NOT reconciled: the tab is still
    // tracked, only its CDP session was replaced. resolveCommandRoute is
    // session-keyed with no targetId fallback, so a re-resolve would still miss,
    // and redirecting a session-bound command (a child/OOPIF session above all) to
    // a fresh session is not semantically safe. Let the existing branches handle it
    // (getAttachState → {attached:false}, others → stale_session).
    //
    // Global commands have already returned above.
    if (
      route.code === 'target_not_found' &&
      method !== 'Extension.getAttachState'
    ) {
      const reconcile = () => mgr.reconcileFromChrome()
      try {
        if (commandContext) {
          await awaitWithDeadline(commandContext, 'reconcileFromChrome', reconcile)
        } else {
          await reconcile()
        }
        route = mgr.resolveCommandRoute(sessionId, targetId, routeOptions)
      } catch (err) {
        // Self-heal is an optimization and must not become a new failure source: letting
        // this bubble would skip throwRouteError, losing both the relay ghost cleanup it
        // performs via notifyStaleTarget and the typed target_not_found classification.
        // Keep the pre-reconcile route and let the normal miss handling below run.
        if (err instanceof CommandDeadlineExceededError) throw err
        log.warn('route-miss self-heal failed, falling back to route error:', method, err)
      }
    }

    // ── Tab activation: bypass the per-tab queue ──
    // These commands use Chrome extension APIs (chrome.windows.update, chrome.tabs.update)
    // that don't require the renderer to respond. They must NOT be queued behind
    // renderer-blocking CDP commands (e.g. Runtime.callFunctionOn, Page.screenshot)
    // because when a tab is minimized/backgrounded, those commands hang and the queue
    // never reaches the activation command — creating a deadlock.
    if (method === 'Target.activateTarget' || method === 'Page.bringToFront') {
      if (!route.ok) return throwRouteError(route, method, sessionId, targetId)
      if (!mgr.validateCommandRoute(route)) {
        throw new CdpCommandRouteError({ code: 'stale_session', method, sessionId, targetId })
      }
      const activationContext = Object.create(commandContext)
      activationContext.onNativeOperation = (operation) => scheduler.holdNativeSettlement(route.tabId, operation)
      const activation = cdpActivateTarget(params, route.tabId, activationContext)
      scheduler.holdNativeSettlement(route.tabId, activation)
      return activation
    }

    if (!route.ok) {
      // This readonly V1 compatibility probe historically treated a replaced session as
      // "not attached", allowing older SDKs to continue their reattach recovery path.
      if (method === 'Extension.getAttachState' && route.code === 'stale_session') {
        return { attached: false }
      }
      return throwRouteError(route, method, sessionId, targetId)
    }

    const lane = FETCH_UNBLOCK_METHODS.has(method) ? 'unblock' : 'normal'
    commandContext?.reportProgress?.('queued')
    const scheduled = scheduler.schedule(route.tabId, {
      lane,
      method,
      attachmentSessionId: route.attachmentSessionId,
      commandSessionId: route.commandSessionId,
      commandContext: Object.create(commandContext),
      completesAfterOwnTabClose: method === 'Target.closeTarget',
      task: async ({ signal, generation, commandContext, queuedAt, queueWaitMs }) => {
        commandContext?.reportProgress?.('dequeued')
        const tabId = route.tabId
        const isCurrent = () =>
          !signal.aborted &&
          scheduler.isCurrent(tabId, generation, route.attachmentSessionId) &&
          mgr.validateCommandRoute(route)
        const assertCurrent = () => {
          if (!isCurrent()) {
            throw new CdpCommandRouteError({
              code: 'stale_session',
              method,
              sessionId,
              targetId,
            })
          }
        }

        const assertExecutionScope = () => {
          assertCurrent()
          if (method !== 'Target.closeTarget' && method !== 'Extension.getAttachState'
            && !mgr.isInExecutionScope(tabId)) {
            throw new CdpCommandRouteError({ code: 'outside_scope', method, sessionId, targetId })
          }
        }
        assertExecutionScope()
        if (commandContext) {
          await awaitWithDeadline(commandContext, 'tab_command.queue_wait', () => undefined)
        }

        commandContext.assertCurrent = method === 'Target.closeTarget'
          ? () => {
              if (signal.reason === 'tab_closed' && !mgr.has(tabId) && !scheduler.getSnapshot(tabId)) return
              assertCurrent()
            }
          : assertExecutionScope
        mgr.onCdpCommand?.(tabId)

        if (method === 'Target.closeTarget') {
          return cdpCloseTarget(params, tabId, commandContext)
        }

        // ── Extension.* virtual commands ──
        if (method === 'Extension.getCookies') return extGetCookies(tabId, commandContext)
        if (method === 'Extension.setCookies') return extSetCookies(tabId, params, commandContext)
        if (method === 'Extension.clearCookies') return extClearCookies(tabId, commandContext)
        if (method === 'Extension.getViewportInfo') {
          // Best-effort attach (original semantics): only user_denied blocks; other failures
          // proceed — the debugger may still be attached (reused-debugger path) and the
          // downstream sendCommand reports its own error otherwise.
          const r = await mgr.ensureAttached(tabId, commandContext)
          if (!r.ok && r.code === 'user_denied') throw new Error(r.message)
          assertCurrent()
          return extGetViewportInfo(tabId, commandContext)
        }
        if (method === 'Extension.ensureZoom') {
          return extEnsureZoom(tabId, params, commandContext)
        }
        if (method === 'Extension.captureViewport') {
          // Best-effort attach (original semantics): only user_denied blocks, see getViewportInfo.
          const r = await mgr.ensureAttached(tabId, commandContext)
          if (!r.ok && r.code === 'user_denied') throw new Error(r.message)
          assertCurrent()
          return extCaptureViewport(tabId, params, commandContext)
        }
        if (method === 'Extension.extractContent') {
          return extExtractContent(tabId, commandContext)
        }
        if (method === 'Extension.markElements') {
          return extMarkElements(tabId, params, commandContext)
        }
        if (method === 'Extension.click') return extClick(tabId, params, commandContext)
        if (method === 'Extension.input') return extInput(tabId, params, commandContext)
        // vtab 自动附加：桌面端 browser tool 发现 targetId 是虚拟标签页（vtab-*）时，
        // 通过 relay 调用此命令让扩展执行 chrome.debugger.attach，将虚拟标签页升级为物理附加。
        // 返回附加后的真实 targetId 和 sessionId，供后续 CDP 命令使用。
        // 调用链：browser.ts autoAttachVtab() → relay ensureTargetAttached() → 此处
        if (method === 'Extension.ensureAttach') {
          const res = await mgr.ensureAttached(tabId, commandContext)
          if (!res.ok) {
            // Wire protocol stays throw-based (flat error string) for version-skew compatibility.
            // The [attachError ...] token is OUR stable format for new SDKs to parse; the original
            // message text is kept so old SDKs' substring matching keeps working.
            const ids = res.conflictExtensionIds?.length
              ? ` ids=${res.conflictExtensionIds.join(',')}`
              : ''
            throw new Error(
              `Failed to attach tab ${tabId}: ${res.message} [attachError code=${res.code}${ids}]`,
            )
          }
          assertCurrent()
          const entry = mgr.get(tabId)
          return {
            targetId: mgr.getCurrentTargetId(tabId),
            sessionId: entry?.attachmentSessionId,
          }
        }

        // 只读 attach 状态查询：relay 在 Playwright 找不到 Page 时，
        // 通过此命令确认扩展侧 chrome.debugger 是否仍 attached。
        // 不调用 ensureAttached — 纯粹读取当前状态。
        // 调用链：pw-session resolveMissingRelayPage() → relay confirmVtabDebuggerAttached() → 此处
        if (method === 'Extension.getAttachState') {
          if (!tabId) return { attached: false }
          const entry = mgr.get(tabId)
          if (!entry) return { attached: false }
          // Manager state 'connected' means chrome.debugger is attached.
          // For authoritative check, also verify via chrome.debugger.getTargets().
          if (entry.state !== 'connected') return { attached: false }
          const getTargets = async () => {
            try {
              return await chrome.debugger.getTargets()
            } catch {
              return null
            }
          }
          const dbgTargets = commandContext
            ? await awaitWithDeadline(
                commandContext,
                'chrome.debugger.getTargets:getAttachState',
                getTargets,
              )
            : await getTargets()
          // If chrome.debugger API fails, trust local state (already confirmed 'connected')
          if (!dbgTargets) return { attached: true }
          assertCurrent()
          const stillAttached = dbgTargets.some((t) => t.tabId === tabId && t.attached)
          return { attached: stillAttached }
        }

        // ── Standard CDP forwarding (requires debugger attach) ──
        const executionStartedAt = performance.now()
        const stages = {
          requestId: commandContext.requestId,
          tabId,
          method,
          lane,
          preQueueMs: Number.isFinite(queuedAt) && Number.isFinite(commandContext.receivedAt)
            ? Math.max(0, queuedAt - commandContext.receivedAt)
            : 0,
          queueWaitMs: Number.isFinite(queueWaitMs) ? queueWaitMs : 0,
          attachMs: 0,
          chromeCommandMs: 0,
          failureDiagnosisMs: 0,
          outcome: 'success',
          stage: 'ensureAttached',
          deadlineSource: commandContext.deadlineSource,
        }
        let commandStartedAt
        let commandTimedOut = false
        let cdpCommandStarted = false
        try {
          const attachStartedAt = performance.now()
          let attachRes
          try {
            attachRes = await mgr.ensureAttached(tabId, commandContext)
          } finally {
            stages.attachMs = performance.now() - attachStartedAt
          }
          if (!attachRes.ok) {
            throw new Error(
              `Failed to attach debugger to tab ${tabId} for ${method}: ${attachRes.message}`,
            )
          }
          assertCurrent()

          /** @type {chrome.debugger.DebuggerSession} */
          const debuggee = { tabId }
          const tabState = mgr.get(tabId)
          const debuggerSession =
            route.sessionKind === 'child'
              ? { ...debuggee, sessionId: route.commandSessionId }
              : debuggee

          stages.stage = method === 'Runtime.enable'
            ? 'Runtime.enable:sequence'
            : `chrome.debugger.sendCommand:${method}`
          try {
            if (method === 'Runtime.enable') {
              const enableStartedAt = performance.now()
              try {
                return await cdpRuntimeEnable(debuggerSession, params, assertCurrent, commandContext)
              } finally {
                stages.runtimeEnableMs = performance.now() - enableStartedAt
              }
            }

            assertCurrent()
            commandStartedAt = performance.now()
            const sendRaw = () => {
              let raw
              try {
                cdpCommandStarted = true
                commandContext.reportProgress?.('send_command_started')
                raw = Promise.resolve(chrome.debugger.sendCommand(debuggerSession, method, params))
              } catch (error) {
                raw = Promise.reject(error)
              }
              void raw.then(
                () => {
                  if (commandTimedOut) {
                    const entry = recordCommandDiagnostic({
                      ...stages, outcome: 'late_success',
                      lateSettlementMs: performance.now() - commandStartedAt,
                    })
                    log.warn('slow debugger command', entry.method, entry.fields)
                  }
                },
                () => {
                  if (commandTimedOut) {
                    const entry = recordCommandDiagnostic({
                      ...stages, outcome: 'late_failure',
                      lateSettlementMs: performance.now() - commandStartedAt,
                    })
                    log.warn('slow debugger command', entry.method, entry.fields)
                  }
                },
              )
              return raw
            }
            try {
              const result = await awaitWithDeadline(
                commandContext,
                stages.stage,
                sendRaw,
                { maxWaitMs: getCdpOperationTimeoutMs(method) },
              )
              commandContext.reportProgress?.('send_command_resolved')
              return result
            } finally {
              stages.chromeCommandMs = performance.now() - commandStartedAt
            }
          } catch (cmdErr) {
            if (cdpCommandStarted) {
              commandContext.reportProgress?.(
                cmdErr instanceof CommandDeadlineExceededError ? 'send_command_timeout' : 'send_command_failed',
              )
            }
            if (cmdErr instanceof CommandDeadlineExceededError) throw cmdErr
            if (!isCurrent()) throw cmdErr
            // Diagnosis is best-effort and must not replace the original CDP error.
            const diagnosisStartedAt = performance.now()
            try {
              const getTab = async () => {
                try {
                  await chrome.tabs.get(tabId)
                  return true
                } catch {
                  return false
                }
              }
              const tabStillExists = await awaitWithDeadline(
                commandContext,
                'chrome.tabs.get:commandFailureDiagnosis',
                getTab,
              )
              if (!isCurrent()) throw cmdErr
              if (!tabStillExists) {
                void mgr.close(tabId, 'tab-closed')
              } else {
                const dbgTargets = await awaitWithDeadline(
                  commandContext,
                  'chrome.debugger.getTargets:commandFailureDiagnosis',
                  () => chrome.debugger.getTargets(),
                )
                if (!isCurrent()) throw cmdErr
                const stillAttached = dbgTargets.some((t) => t.tabId === tabId && t.attached)
                if (!stillAttached && tabState?.state === 'connected') {
                  void mgr.detach(tabId, 'debugger-gone')
                }
              }
            } catch {
              // Best-effort: don't mask the original error.
            } finally {
              stages.failureDiagnosisMs = performance.now() - diagnosisStartedAt
            }
            throw cmdErr
          }
        } catch (error) {
          stages.outcome = error instanceof CommandDeadlineExceededError ? 'timeout' : 'failure'
          stages.stage = error?.stage || stages.stage
          stages.timeoutSource = error?.timeoutSource
          commandTimedOut = stages.outcome === 'timeout' &&
            stages.stage === `chrome.debugger.sendCommand:${method}` &&
            commandStartedAt !== undefined
          throw error
        } finally {
          stages.extensionTotalMs = stages.preQueueMs + stages.queueWaitMs +
            (performance.now() - executionStartedAt)
          if (stages.outcome !== 'success' || stages.extensionTotalMs >= slowCommandStageMs) {
            const entry = recordCommandDiagnostic(stages)
            log.warn('slow debugger command', entry.method, entry.fields)
          }
        }
      },
    })

    return scheduled.catch((error) => {
      if (error instanceof TabCommandQueueOverloadedError && error.lane === 'unblock') {
        void mgr.detach(route.tabId, 'unblock-overflow', {
          initiatedByUs: true,
          expectedGeneration: error.generation,
          expectedAttachmentSessionId: route.attachmentSessionId,
        })
      }
      throw error
    })
  }
}
