/**
 * Target.* CDP command handlers.
 *
 * Handles tab creation, closing, activation, and agent tab lifecycle
 * through Chrome extension APIs rather than raw CDP.
 *
 * @param {import('../tabs/manager.js').TabManager} mgr
 */

import { TARGET_CREATE_DELAY, TAB_REMOVE_TIMEOUT, RUNTIME_ENABLE_DELAY } from './utils.js'
import {
  CommandDeadlineExceededError,
  DEFAULT_CDP_OPERATION_TIMEOUT_MS,
  awaitWithDeadline,
  createCommandContext,
} from './deadline.js'
import { CdpCommandRouteError } from './route-error.js'

const OPEN_TARGET_READY_TIMEOUT_MS = 15_000
const OPEN_TARGET_READY_POLL_INTERVAL_MS = 100

function awaitOperation(commandContext, stage, operation, options) {
  return commandContext
    ? awaitWithDeadline(commandContext, stage, operation, options)
    : operation()
}

function isMissingTabError(error) {
  return /No tab with id|Invalid tab ID/i.test(error?.message || String(error))
}

async function navigateAttachedTab(tabId, requestedUrl, commandContext, assertCurrent) {
  const send = (method, params, context = commandContext) => awaitOperation(
    context,
    `chrome.debugger.sendCommand:${method}`,
    () => {
      assertCurrent()
      return chrome.debugger.sendCommand({ tabId }, method, params)
    },
    { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS },
  )
  await send('Page.enable')
  await send('Page.setLifecycleEventsEnabled', { enabled: true })
  try {
    await send('Runtime.disable')
  } catch (error) {
    if (error instanceof CommandDeadlineExceededError || error instanceof CdpCommandRouteError) throw error
    // Runtime may not have been enabled on this fresh attachment yet.
  }
  await awaitOperation(commandContext, 'target_create.runtime_enable_delay', () =>
    new Promise((resolve) => setTimeout(resolve, RUNTIME_ENABLE_DELAY)))
  await send('Runtime.enable')
  if (requestedUrl !== 'about:blank') {
    const navigation = await send('Page.navigate', { url: requestedUrl })
    if (navigation?.errorText) throw new Error(`Page.navigate failed: ${navigation.errorText}`)
  }

  const readyDeadlineAt = Math.min(commandContext.deadlineAt, Date.now() + OPEN_TARGET_READY_TIMEOUT_MS)
  const readyContext = Object.assign(Object.create(commandContext), {
    deadlineAt: readyDeadlineAt,
    remainingMs: () => Math.max(0, readyDeadlineAt - Date.now()),
    isExpired: () => Date.now() >= readyDeadlineAt,
  })
  let mainFrameUrl = ''
  let readyState = ''
  let lastError = ''
  while (!readyContext.isExpired()) {
    try {
      const frameTree = await send('Page.getFrameTree', undefined, readyContext)
      mainFrameUrl = frameTree?.frameTree?.frame?.url || ''
      const evaluation = await send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, readyContext)
      if (evaluation?.exceptionDetails) throw new Error('Failed to read document.readyState')
      readyState = evaluation?.result?.value || ''
      if (
        (requestedUrl === 'about:blank' ? mainFrameUrl === 'about:blank' : mainFrameUrl && mainFrameUrl !== 'about:blank')
        && (readyState === 'interactive' || readyState === 'complete')
      ) {
        return { mainFrameUrl, readyState }
      }
    } catch (error) {
      if (error instanceof CommandDeadlineExceededError || error instanceof CdpCommandRouteError) throw error
      lastError = error?.message || String(error)
    }
    await awaitOperation(readyContext, 'target_create.ready_poll', () =>
      new Promise((resolve) => setTimeout(resolve, OPEN_TARGET_READY_POLL_INTERVAL_MS)))
  }
  const error = new CommandDeadlineExceededError({
    context: readyContext,
    stage: 'target_create.ready',
    operationElapsedMs: OPEN_TARGET_READY_TIMEOUT_MS,
    timeoutSource: readyDeadlineAt < commandContext.deadlineAt ? 'operation_limit' : 'command_deadline',
  })
  error.message += ` url="${requestedUrl}" mainFrameUrl="${mainFrameUrl}" readyState="${readyState}" lastError="${lastError}"`
  commandContext.markTimedOut(error)
  throw error
}

export function createTargetOps(mgr, scheduler) {
  if (!scheduler) throw new TypeError('createTargetOps requires the shared TabCommandScheduler')
  let createTargetLock = Promise.resolve()
  const pendingRemovals = new Map()
  const pendingCreates = new Map()

  function reserveTargetSlot(task, commandContext, owner) {
    const previous = createTargetLock
    const reservation = (async () => {
      await awaitWithDeadline(commandContext, 'target_create.lock_wait', () => previous)
      return task()
    })()
    // ponytail: one execution scope; serialize full opens, including late native settlement.
    const release = () => commandContext.waitForNativeSettlement()
    const settlement = reservation.then(release, release)
    createTargetLock = Promise.allSettled([previous, settlement]).then(() => undefined)
    pendingCreates.set(settlement, owner)
    const settled = () => { pendingCreates.delete(settlement) }
    void settlement.then(settled, settled)
    return reservation
  }

  async function drainSessionCreates({ principalId, sessionGroupId, scope }) {
    const pending = [...pendingCreates].filter(([, owner]) => scope === 'group'
      ? owner.sessionGroupId === sessionGroupId
      : owner.principalId === principalId).map(([settlement]) => settlement)
    await Promise.allSettled(pending)
  }

  function assertExecutionScope(windowId, method) {
    if (
      mgr.executionScopeEnabled && (
        !mgr.isCurrentBrowserSelected || !Number.isInteger(windowId)
        || windowId !== mgr.selectedWindowId
      )
    ) {
      throw new CdpCommandRouteError({ code: 'outside_scope', method })
    }
  }

  function assertAttached(tabId, attachmentSessionId, method) {
    const entry = mgr.get(tabId)
    if (entry?.state !== 'connected' || entry.attachmentSessionId !== attachmentSessionId) {
      throw new CdpCommandRouteError({ code: 'stale_session', method, targetId: `vtab-${tabId}` })
    }
    if (!mgr.isInExecutionScope(tabId)) {
      throw new CdpCommandRouteError({ code: 'outside_scope', method, targetId: `vtab-${tabId}` })
    }
  }

  async function focusTab(tab, commandContext, assertCurrent) {
    await awaitOperation(commandContext, 'chrome.tabs.update:activateTarget', () => {
      assertCurrent()
      return chrome.tabs.update(tab.id, { active: true })
    })
    mgr.setActiveTab(tab.id, tab.windowId)
    mgr.updateTab(tab.id, undefined, undefined, { windowId: tab.windowId, active: true })
    await awaitOperation(commandContext, 'chrome.windows.update:activateTarget', () => {
      assertCurrent()
      return chrome.windows.update(tab.windowId, { focused: true })
    })
  }

  function startTabRemoval(tabId, principalId, sessionGroupId) {
    const entry = mgr.get(tabId)
    if (sessionGroupId !== undefined) {
      if (!entry?.createdBy || entry.sessionGroupId !== sessionGroupId) {
        return Promise.resolve({ status: 'denied', error: 'Cannot close this tab: it is not an agent page in this session group.' })
      }
    } else if (typeof principalId !== 'string' || !principalId.trim() || entry?.createdBy !== principalId) {
      return Promise.resolve({ status: 'denied', error: 'Cannot close this tab: it was not created by this session.' })
    }
    if (sessionGroupId === undefined && entry.claimedBy && entry.claimedBy !== principalId) {
      return Promise.resolve({ status: 'denied', error: 'Cannot close this tab: it is claimed by another session.' })
    }
    if (entry.retained || mgr.isRetained(tabId)) return Promise.resolve({ status: 'retained' })
    const pending = pendingRemovals.get(tabId)
    if (pending) return pending

    mgr.markRelayRequestedClose(tabId)
    const nativeRemoval = (async () => chrome.tabs.remove(tabId))()
    scheduler.holdNativeSettlement(tabId, nativeRemoval)
    const removal = nativeRemoval.then(
      () => {
        // onRemoved can win this race; both paths consume the same relay attribution.
        void mgr.close(tabId, 'tab-closed', { closedBy: 'relay' }).catch(() => {})
        return { status: 'closed' }
      },
      (error) => {
        mgr.clearRelayRequestedClose(tabId)
        return { status: 'error', error: error?.message || String(error) }
      },
    )
    pendingRemovals.set(tabId, removal)
    void removal.then(() => {
      if (pendingRemovals.get(tabId) === removal) pendingRemovals.delete(tabId)
    })
    return removal
  }

  async function closeAgentTab(tabId, principalId, commandContext, sessionGroupId) {
    let result
    try {
      result = await awaitOperation(
        commandContext,
        'chrome.tabs.remove',
        () => startTabRemoval(tabId, principalId, sessionGroupId),
        { maxWaitMs: TAB_REMOVE_TIMEOUT },
      )
    } catch (error) {
      if (!(error instanceof CommandDeadlineExceededError)) {
        return { status: 'failed', error: error?.message || String(error) }
      }
      // Native remove is still pending. Keep ownership and its relay-close mark until settlement.
      return { status: 'timeout', outcome: 'unknown', retryable: false, error: error.message }
    }
    if (result.status !== 'error') return result
    try {
      await awaitOperation(commandContext, 'chrome.tabs.get:closeTarget', () => chrome.tabs.get(tabId), {
        maxWaitMs: TAB_REMOVE_TIMEOUT,
      })
    } catch (error) {
      if (isMissingTabError(error)) {
        void mgr.close(tabId, 'tab-closed').catch(() => {})
        return { status: 'alreadyClosed' }
      }
    }
    return { status: 'failed', error: result.error }
  }

  async function cdpCreateTarget(params, commandContext) {
    commandContext ??= createCommandContext({ method: 'Target.createTarget' })
    const requestedUrl = typeof params?.url === 'string' ? params.url : 'about:blank'
    const createInWindow = params?.createInWindow === true || params?.type === 'window'
    const retain = params?.retain === true
    const principalId = params?.principalId ?? null
    const sessionGroupId = params?.sessionGroupId ?? null
    if ((principalId !== null || sessionGroupId !== null)
      && (typeof principalId !== 'string' || !principalId.trim()
        || typeof sessionGroupId !== 'string' || !sessionGroupId.trim())) {
      throw new TypeError('principalId and sessionGroupId must both be non-empty strings')
    }

    return reserveTargetSlot(async () => {
      const selectedWindowId = mgr.selectedWindowId
      const assertCreateScope = () => {
        if (createInWindow) {
          if (mgr.executionScopeEnabled
            && (!mgr.isCurrentBrowserSelected || mgr.selectedWindowId !== selectedWindowId)) {
            throw new CdpCommandRouteError({ code: 'outside_scope', method: 'Target.createTarget' })
          }
        } else {
          assertExecutionScope(selectedWindowId, 'Target.createTarget')
        }
      }
      assertCreateScope()
      if (mgr.executionScopeEnabled && !createInWindow) {
        await awaitOperation(commandContext, 'chrome.windows.get:createTarget', () => chrome.windows.get(selectedWindowId))
      }
      const tab = await awaitOperation(commandContext,
        createInWindow ? 'chrome.windows.create' : 'chrome.tabs.create', async () => {
          assertCreateScope()
          const createdTab = createInWindow
            ? (await chrome.windows.create({ url: 'about:blank', focused: false })).tabs?.[0]
            : await chrome.tabs.create({
                url: 'about:blank',
                active: false,
                ...(mgr.executionScopeEnabled ? { windowId: selectedWindowId } : {}),
              })
          if (!createdTab?.id) throw new Error(`Failed to create ${createInWindow ? 'window' : 'tab'}`)
          // Registration is part of native settlement, even after the caller's deadline.
          return mgr.registerAgentTab(createdTab.id, {
            url: createdTab.url ?? 'about:blank',
            title: createdTab.title,
            windowId: createdTab.windowId,
            active: createdTab.active,
            principalId,
            sessionGroupId,
            retained: retain,
          })
        })
      assertCreateScope()
      const entry = mgr.get(tab.tabId)
      const parentAssertCurrent = commandContext.assertCurrent?.bind(commandContext)
      commandContext.assertCurrent = () => {
        parentAssertCurrent?.()
        if (!entry || mgr.get(tab.tabId) !== entry) {
          throw new CdpCommandRouteError({ code: 'stale_session', method: 'Target.createTarget', targetId: tab.vtabId })
        }
      }
      if (createInWindow && mgr.executionScopeEnabled) {
        await mgr.selectExecutionWindow(tab.windowId, commandContext)
      }
      return mgr.withExecutionScope(tab.tabId, commandContext, async () => {
        const attachmentSessionId = mgr.get(tab.tabId)?.attachmentSessionId
        const assertCurrent = () => assertAttached(tab.tabId, attachmentSessionId, 'Target.createTarget')
        const assertEntryCurrent = commandContext.assertCurrent
        commandContext.assertCurrent = () => {
          assertEntryCurrent()
          assertCurrent()
        }
        if (!createInWindow) await mgr.addToAgentGroup(tab.tabId, commandContext)
        await awaitOperation(commandContext, 'target_create.delay', () =>
          new Promise((resolve) => setTimeout(resolve, TARGET_CREATE_DELAY)))
        const ready = await navigateAttachedTab(tab.tabId, requestedUrl, commandContext, assertCurrent)
        const currentTab = await awaitOperation(commandContext, 'chrome.tabs.get:createTarget', () => chrome.tabs.get(tab.tabId))
        assertExecutionScope(currentTab.windowId, 'Target.createTarget')
        mgr.updateTab(tab.tabId, ready.mainFrameUrl, currentTab.title, {
          windowId: currentTab.windowId,
          active: currentTab.active,
        })
        await focusTab(currentTab, commandContext, assertCurrent)
        return {
          targetId: tab.vtabId,
          retained: retain,
          url: ready.mainFrameUrl,
          mainFrameUrl: ready.mainFrameUrl,
          readyState: ready.readyState,
        }
      })
    }, commandContext, { principalId, sessionGroupId })
  }

  async function cdpCloseTarget(params, fallbackTabId, commandContext) {
    commandContext ??= createCommandContext({ method: 'Target.closeTarget' })
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? mgr.getByStableOrRealTargetId(target) : fallbackTabId
    if (!toClose) {
      if (target) {
        // A stale realTargetId must not report success while the routed tab is still alive.
        if (fallbackTabId == null || !mgr.has(fallbackTabId)) {
          return { success: true, alreadyClosed: true }
        }
        return {
          success: false,
          error: `targetId "${target}" no longer matches the routed live tab; re-list tabs and retry.`,
        }
      }
      return { success: false, error: 'No target specified and no fallback tab available.' }
    }
    const result = await closeAgentTab(toClose, params?.principalId, commandContext)
    if (result.status === 'closed' || result.status === 'alreadyClosed') {
      return { success: true, alreadyClosed: result.status === 'alreadyClosed' }
    }
    if (result.status === 'retained') {
      return { success: true, skipped: true, reason: 'Tab is retained — close skipped.' }
    }
    if (result.status === 'timeout') {
      return { success: false, timedOut: true, outcome: 'unknown', retryable: false, error: result.error }
    }
    return { success: false, error: result.error ?? `Failed to remove tab ${toClose}` }
  }

  async function cdpCloseAgentTabsByIds(params, commandContext) {
    commandContext ??= createCommandContext({ method: 'Target.closeAgentTabsByIds' })
    if (!Array.isArray(params?.targetIds)) {
      throw new Error('Target.closeAgentTabsByIds requires a targetIds array')
    }
    const sessionGroupId = params.sessionGroupId
    if (sessionGroupId !== undefined && (typeof sessionGroupId !== 'string' || !sessionGroupId.trim())) {
      throw new TypeError('sessionGroupId must be a non-empty string')
    }
    const targetIds = [...new Set(params.targetIds)].filter(
      (targetId) => typeof targetId === 'string' && targetId.length > 0,
    )
    const outcomes = await Promise.all(targetIds.map(async (targetId) => {
      const tabId = mgr.getByStableOrRealTargetId(targetId)
      if (tabId === null) {
        return { targetId, status: 'failed', error: 'Target is not registered by the extension' }
      }
      return { targetId, ...(await closeAgentTab(tabId, params?.principalId, commandContext, sessionGroupId)) }
    }))
    const response = {
      success: true,
      closed: [],
      alreadyClosed: [],
      retained: [],
      denied: [],
      timedOut: [],
      failed: [],
      deniedDetails: [],
    }
    for (const outcome of outcomes) {
      if (outcome.status === 'timeout') {
        response.timedOut.push({
          targetId: outcome.targetId,
          outcome: 'unknown',
          retryable: false,
          error: outcome.error,
        })
      } else if (outcome.status === 'failed') {
        response.failed.push({ targetId: outcome.targetId, error: outcome.error || 'Unknown error' })
      } else {
        response[outcome.status].push(outcome.targetId)
        if (outcome.status === 'denied') {
          response.deniedDetails.push({ targetId: outcome.targetId, error: outcome.error })
        }
      }
    }
    response.success = response.denied.length === 0 && response.timedOut.length === 0 && response.failed.length === 0
    if (response.timedOut.length) Object.assign(response, { outcome: 'unknown', retryable: false })
    return response
  }

  async function cdpCloseAllAgentTabs(params, commandContext) {
    commandContext ??= createCommandContext({ method: 'Target.closeAllAgentTabs' })
    const results = await Promise.all(mgr.getAgentTabIds().map(async (tabId) => ({
      tabId,
      ...(await closeAgentTab(tabId, params?.principalId, commandContext)),
    })))
    const response = {
      success: true,
      closed: 0,
      alreadyClosed: 0,
      retained: 0,
      denied: 0,
      failed: 0,
      timedOut: 0,
      discarded: 0,
      closedIds: [],
      alreadyClosedIds: [],
      retainedIds: [],
      deniedIds: [],
      timedOutIds: [],
      failedIds: [],
      failedDetails: [],
      timedOutDetails: [],
      deniedDetails: [],
    }
    for (const result of results) {
      const status = result.status === 'timeout' ? 'timedOut' : result.status
      response[status]++
      response[`${status}Ids`].push(result.tabId)
      if (status === 'denied') response.deniedDetails.push({ tabId: result.tabId, error: result.error })
      if (status === 'failed') response.failedDetails.push({ tabId: result.tabId, error: result.error })
      if (status === 'timedOut') response.timedOutDetails.push({
        tabId: result.tabId, error: result.error, outcome: 'unknown', retryable: false,
      })
    }
    response.success = response.denied === 0 && response.timedOut === 0 && response.failed === 0
    if (response.timedOut) Object.assign(response, { outcome: 'unknown', retryable: false })
    return response
  }

  async function cdpActivateTarget(params, fallbackTabId, commandContext) {
    commandContext ??= createCommandContext({ method: 'Target.activateTarget' })
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? mgr.getByStableOrRealTargetId(target) : fallbackTabId
    if (!toActivate) throw new Error('No target available for Target.activateTarget')
    const entry = mgr.get(toActivate)
    const parentAssertCurrent = commandContext.assertCurrent?.bind(commandContext)
    commandContext.assertCurrent = () => {
      parentAssertCurrent?.()
      if (!entry || mgr.get(toActivate) !== entry) {
        throw new CdpCommandRouteError({ code: 'stale_session', method: commandContext.method, targetId: target })
      }
    }
    let tab
    try {
      tab = await awaitOperation(commandContext, 'chrome.tabs.get:activateTarget', () => chrome.tabs.get(toActivate))
    } catch (error) {
      if (isMissingTabError(error)) void mgr.close(toActivate, 'tab-closed').catch(() => {})
      throw error
    }
    if (target && mgr.executionScopeEnabled) {
      await mgr.selectExecutionWindow(tab.windowId, commandContext)
    }
    assertExecutionScope(tab.windowId, 'Target.activateTarget')
    mgr.updateTab(toActivate, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
    return mgr.withExecutionScope(toActivate, commandContext, async () => {
      const assertEntryCurrent = commandContext.assertCurrent
      commandContext.assertCurrent = () => {
        assertEntryCurrent()
        if (!mgr.isInExecutionScope(toActivate)) {
          throw new CdpCommandRouteError({ code: 'outside_scope', method: commandContext.method, targetId: target })
        }
      }
      if (tab.windowId) {
        await awaitOperation(commandContext, 'chrome.windows.update:activateTarget', async () => {
          try {
            await chrome.windows.update(tab.windowId, { focused: true })
          } catch {
            // Best-effort focus.
          }
        })
      }
      await awaitOperation(commandContext, 'chrome.tabs.update:activateTarget', async () => {
        try {
          await chrome.tabs.update(toActivate, { active: true })
        } catch {
          // Best-effort activation.
        }
      })
      await mgr.applyExecutionScope(toActivate, { commandContext })
      commandContext.assertCurrent()
      return {}
    }, { attach: false })
  }

  return {
    drainSessionCreates,
    cdpCreateTarget,
    cdpCloseTarget,
    cdpCloseAgentTabsByIds,
    cdpCloseAllAgentTabs,
    cdpActivateTarget,
  }
}
