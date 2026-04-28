/**
 * Session activity indicators — idle tab detection.
 *
 * Automatically detaches tabs that haven't received CDP commands for a
 * configurable period.
 *
 * Timer strategy (MV3 compatible):
 *   - Idle check uses chrome.alarms (30 s) to survive SW suspension.
 */

import { createLogger } from '../../logger.js'

const log = createLogger('indicators')

const IDLE_DETACH_MS = 5 * 60 * 1000

const ALARM_IDLE_CHECK = 'relayIdleCheck'

export class SessionIndicators {
  /** @type {Map<number, number>} tabId → last CDP command timestamp */
  #lastCommandTime = new Map()

  /** @type {() => IterableIterator<[number, {state: string}]>} */
  #getTabEntries
  /** @type {(tabId: number, reason: string) => void} */
  #detachTab

  /**
   * @param {object} opts
   * @param {() => IterableIterator<[number, {state: string}]>} opts.getTabEntries — returns iterable of [tabId, entry]
   * @param {(tabId: number, reason: string) => void} opts.detachTab — detach callback
   */
  constructor({ getTabEntries, detachTab }) {
    this.#getTabEntries = getTabEntries
    this.#detachTab = detachTab
  }

  trackCommand(tabId) {
    this.#lastCommandTime.set(tabId, Date.now())
  }

  removeTab(tabId) {
    this.#lastCommandTime.delete(tabId)
  }

  moveTab(fromTabId, toTabId) {
    if (!this.#lastCommandTime.has(fromTabId)) return
    const lastCommand = this.#lastCommandTime.get(fromTabId)
    this.#lastCommandTime.delete(fromTabId)
    if (lastCommand !== undefined) {
      this.#lastCommandTime.set(toTabId, lastCommand)
    }
  }

  clear() {
    this.#lastCommandTime.clear()
  }

  start() {
    this.stop()
    chrome.alarms.create(ALARM_IDLE_CHECK, { periodInMinutes: 0.5 })
  }

  stop() {
    chrome.alarms.clear(ALARM_IDLE_CHECK)
    this.#lastCommandTime.clear()
  }

  /**
   * Handle alarm events relevant to session indicators.
   * Called from background.js onAlarm listener.
   * Returns true if the alarm was handled.
   */
  handleAlarm(alarmName) {
    if (alarmName === ALARM_IDLE_CHECK) {
      this.#checkIdleTabs()
      return true
    }
    return false
  }

  #checkIdleTabs() {
    const now = Date.now()
    const toDetach = []
    for (const [tabId, entry] of this.#getTabEntries()) {
      if (entry.state !== 'connected') continue
      const lastCmd = this.#lastCommandTime.get(tabId)
      if (lastCmd === undefined) continue // never received CDP command, skip (avoid false idle detach)
      if (now - lastCmd > IDLE_DETACH_MS) toDetach.push(tabId)
    }
    for (const tabId of toDetach) {
      log.info('idle timeout: detaching tab', tabId, 'after', IDLE_DETACH_MS / 1000, 's')
      this.#detachTab(tabId, 'idle_timeout')
    }
  }
}
