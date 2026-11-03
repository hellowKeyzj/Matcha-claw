/**
 * Low-level chrome.debugger API operations.
 *
 * Pure chrome.debugger interactions with no state management or relay awareness.
 * Used by TabManager for the physical attach/detach lifecycle.
 *
 * Domain enable strategy on attach:
 *   Page.enable     — always (dialog handling, page lifecycle events)
 *
 * Domains enabled on-demand by relay via CDP commands (through dispatch.js):
 *   Network.enable  — request lifecycle (high traffic, enable only when needed)
 *   Runtime.enable  — JS contexts, console, exceptions
 *   Security.enable — security state changes, cert errors (deprecated)
 *   Fetch.enable    — request interception (must specify patterns)
 *   Log.enable      — browser-level log entries
 *   Debugger.enable — breakpoints, script parsing (pauses execution)
 *   DOM.enable      — DOM mutation observation
 *
 * See lib/cdp/events/ for comprehensive event handling across all domains.
 */

import { createLogger } from '../../logger.js'
import { recordCommandDiagnostic } from '../commands/diagnostics.js'
import {
  CommandDeadlineExceededError,
  DEFAULT_CDP_OPERATION_TIMEOUT_MS,
  awaitWithDeadline,
} from '../commands/deadline.js'

const log = createLogger('dbg')
const SLOW_PAGE_ENABLE_MS = 2_000

function awaitOperation(commandContext, stage, operation, options) {
  return commandContext
    ? awaitWithDeadline(commandContext, stage, operation, options)
    : operation()
}

function describeError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) || String(error)
  } catch {
    return String(error)
  }
}

function createTargetIdentityError(targetInfoError, fallbackError) {
  const message =
    `Failed to resolve target ID; Target.getTargetInfo: ${describeError(targetInfoError)}; ` +
    `chrome.debugger.getTargets: ${describeError(fallbackError)}`
  const deadlineError =
    fallbackError instanceof CommandDeadlineExceededError
      ? fallbackError
      : targetInfoError instanceof CommandDeadlineExceededError
        ? targetInfoError
        : null
  if (deadlineError) {
    deadlineError.message = message
    return deadlineError
  }
  return new Error(message)
}

async function resolveAttachedPageTargetId(tabId, commandContext) {
  const targets = await awaitOperation(
    commandContext,
    'chrome.debugger.getTargets:resolveTargetIdentity',
    () => chrome.debugger.getTargets(),
    { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS },
  )
  const match = Array.isArray(targets)
    ? targets.find(
        (target) => target?.tabId === tabId && target.attached === true && target.type === 'page',
      )
    : undefined
  const realTargetId = String(match?.id || '').trim()
  if (!realTargetId) {
    throw new Error(`No attached page target was found for tab ${tabId}`)
  }
  return realTargetId
}

function createTrackedOperation(operation) {
  let started = false
  let settled = false
  let resolveSettlement
  const settlement = new Promise((resolve) => { resolveSettlement = resolve })

  const run = () => {
    started = true
    let rawPromise
    try {
      rawPromise = Promise.resolve(operation())
    } catch (error) {
      rawPromise = Promise.reject(error)
    }
    void rawPromise.then(
      (value) => {
        settled = true
        resolveSettlement({ status: 'fulfilled', value })
      },
      (reason) => {
        settled = true
        resolveSettlement({ status: 'rejected', reason })
      },
    )
    return rawPromise
  }

  const finishIfNotStarted = () => {
    if (!started && !settled) {
      settled = true
      resolveSettlement({ status: 'not_started' })
    }
  }

  return { run, settlement, finishIfNotStarted }
}

/**
 * Start a physical debugger attach while retaining the raw Chrome settlement.
 *
 * @param {number} tabId
 * @returns {{ result: Promise<{ realTargetId: string }>, settlement: Promise<object> }}
 */
export function startDebuggerAttach(tabId, commandContext) {
  const t0 = performance.now()
  const debuggee = { tabId }
  const operation = createTrackedOperation(
    () => chrome.debugger.attach(debuggee, '1.3'),
  )

  const result = (async () => {
    try {
      await awaitOperation(
        commandContext,
        'chrome.debugger.attach',
        operation.run,
      )
    } catch (error) {
      operation.finishIfNotStarted()
      throw error
    }
    log.debug('attach took', (performance.now() - t0).toFixed(1), 'ms', tabId)

    try {
      return await initializeAttachedDebugger(tabId, commandContext, t0)
    } catch (err) {
      if (err instanceof CommandDeadlineExceededError) err.debuggerAttached = true
      throw err
    }
  })()

  return { result, settlement: operation.settlement }
}

/**
 * Physically attach the Chrome debugger to a tab.
 *
 * @param {number} tabId
 * @returns {Promise<{ realTargetId: string }>} The real CDP targetId assigned by Chrome
 * @throws {Error} If attachment fails
 */
export function attachDebugger(tabId, commandContext) {
  return startDebuggerAttach(tabId, commandContext).result
}

export async function initializeAttachedDebugger(tabId, commandContext, t0 = performance.now()) {
  const debuggee = { tabId }
  const pageEnableStartedAt = performance.now()
  const remainingMsAtStart = commandContext?.remainingMs()
  let pageEnableTimedOut = false
  let pageEnableStarted = false
  const pageEnableDetails = (outcome, elapsedMs) => ({
    event: 'debugger_page_enable',
    outcome,
    tabId,
    requestId: commandContext?.requestId,
    method: commandContext?.method,
    elapsedMs: Math.round(elapsedMs),
    attachElapsedMs: Math.round(pageEnableStartedAt - t0),
    remainingMsAtStart,
    commandAgeMs: commandContext?.ageMs(),
    deadlineSource: commandContext?.deadlineSource,
  })
  const recordPageEnable = (details) => {
    recordCommandDiagnostic({
      requestId: details.requestId,
      tabId,
      method: 'Page.enable',
      lane: 'attach',
      outcome: details.outcome,
      stage: details.stage || 'chrome.debugger.sendCommand:Page.enable',
      attachMs: details.attachElapsedMs,
      chromeCommandMs: details.elapsedMs,
      extensionTotalMs: details.attachElapsedMs + details.elapsedMs,
      deadlineSource: details.deadlineSource,
      timeoutSource: details.timeoutSource,
      lateSettlementMs: details.outcome.startsWith('late_') ? details.elapsedMs : undefined,
    })
    log.warn('slow debugger operation', details)
  }
  try {
    await awaitOperation(
      commandContext,
      'chrome.debugger.sendCommand:Page.enable',
      () => {
        pageEnableStarted = true
        let raw
        try {
          raw = Promise.resolve(chrome.debugger.sendCommand(debuggee, 'Page.enable'))
        } catch (error) {
          raw = Promise.reject(error)
        }
        // The deadline bounds our wait, not Chrome's underlying command. Record a
        // late settlement so a timeout can be distinguished from a lost response.
        void raw.then(
          () => {
            if (pageEnableTimedOut) {
              recordPageEnable(pageEnableDetails('late_success', performance.now() - pageEnableStartedAt))
            }
          },
          (error) => {
            if (pageEnableTimedOut) recordPageEnable({
              ...pageEnableDetails('late_failure', performance.now() - pageEnableStartedAt),
              error: describeError(error),
            })
          },
        )
        return raw
      },
      { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS },
    )
    const elapsedMs = performance.now() - pageEnableStartedAt
    if (elapsedMs >= SLOW_PAGE_ENABLE_MS) {
      recordPageEnable(pageEnableDetails('slow_success', elapsedMs))
    }
  } catch (err) {
    if (err instanceof CommandDeadlineExceededError) {
      pageEnableTimedOut = pageEnableStarted
      recordPageEnable({
        ...pageEnableDetails('timeout', performance.now() - pageEnableStartedAt),
        timeoutSource: err.timeoutSource,
        stage: err.stage,
        operationStarted: pageEnableStarted,
      })
      throw err
    }
    log.warn('Page.enable failed', tabId, err)
  }

  let targetInfoError
  try {
    const info = /** @type {any} */ (
      await awaitOperation(
        commandContext,
        'chrome.debugger.sendCommand:Target.getTargetInfo',
        () => chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'),
        { maxWaitMs: DEFAULT_CDP_OPERATION_TIMEOUT_MS },
      )
    )
    const realTargetId = String(info?.targetInfo?.targetId || '').trim()
    if (realTargetId) {
      log.debug('attached', tabId, 'targetId:', realTargetId, 'in', (performance.now() - t0).toFixed(1), 'ms')
      return { realTargetId }
    }
    targetInfoError = new Error('Target.getTargetInfo returned no targetId')
  } catch (error) {
    // A command-level deadline leaves no budget for a second identity lookup.
    if (error instanceof CommandDeadlineExceededError && error.timeoutSource === 'command_deadline') {
      throw error
    }
    targetInfoError = error
  }

  try {
    const realTargetId = await resolveAttachedPageTargetId(tabId, commandContext)
    log.debug('attached', tabId, 'targetId:', realTargetId, 'in', (performance.now() - t0).toFixed(1), 'ms')
    return { realTargetId }
  } catch (fallbackError) {
    throw createTargetIdentityError(targetInfoError, fallbackError)
  }
}

/**
 * Start a debugger detach while retaining the raw Chrome settlement.
 * @param {number} tabId
 * @returns {{ result: Promise<void>, settlement: Promise<object> }}
 */
export function startDebuggerDetach(tabId, commandContext) {
  const operation = createTrackedOperation(
    () => chrome.debugger.detach({ tabId }),
  )
  const result = (async () => {
    try {
      await awaitOperation(
        commandContext,
        'chrome.debugger.detach',
        operation.run,
      )
    } catch {
      operation.finishIfNotStarted()
      // Already detached, tab closed, or cleanup budget exhausted.
    }
  })()
  return { result, settlement: operation.settlement }
}

/**
 * Detach the Chrome debugger from a tab. Fails silently.
 * @param {number} tabId
 */
export function detachDebugger(tabId, commandContext) {
  return startDebuggerDetach(tabId, commandContext).result
}

/**
 * Detach multiple tabs in parallel. Returns a settled promise.
 * @param {number[]} tabIds
 */
export function detachAll(tabIds) {
  const promises = tabIds.map(
    (tabId) => chrome.debugger.detach({ tabId })
      .then(() => log.debug('detachAll: OK', tabId))
      .catch((err) => log.debug('detachAll: failed', tabId, err)),
  )
  return Promise.allSettled(promises)
}
