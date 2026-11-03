/**
 * Relay connection management.
 *
 * 3-state UI / persisted model:
 *   disabled     — relay off, badge empty
 *   disconnected — user enabled relay but link is not usable, badge …, auto-reconnecting
 *   connected    — relay enabled + WS open + encrypted helloAck received, badge ON
 *
 * Timer strategy (MV3 compatible):
 *   All deferred work uses chrome.alarms instead of setTimeout/setInterval
 *   so that timers survive Service Worker suspension.
 *
 *   Alarm names:
 *     relayKeepAlive        — 30-s heartbeat/watchdog, created when relay is enabled
 *     relayReconnect        — flat 30-s retry (the chrome.alarms floor)
 *     relayDisconnectNotify — delayed disconnect notification (1 min; after first reconnect window)
 *
 *   Reconnect is deliberately NOT backed off exponentially. The peer is always
 *   the relay on 127.0.0.1, so there is no remote server to protect and no
 *   thundering herd — the only question a retry answers is "is that local
 *   process up yet", and the answer changes on a human timescale. Growing the
 *   delay only means a relay that just started stays unnoticed for minutes.
 */

import { RelayState, STATE_UI, DEFAULT_CONTROL_PORT, RELAY_PORT_OFFSET, clampPort, computeRelayPort } from '../../constants.js'
import { setIconWithDot } from '../../icon-badge.js'
import { createLogger, setTraceEnabled } from '../../logger.js'
import { prepareSessionKey, activateEncryption, resetEncryption, encryptMessage, decryptMessage, isEncryptedWireMessage } from '../../crypto.js'
import { getBrowserInstanceId } from '../../browser-instance.js'
import {
  CommandDeadlineExceededError,
  createCommandContext,
  serializeCommandDeadlineError,
} from '../commands/deadline.js'
import {
  CdpCommandRouteError,
  serializeCommandRouteError,
} from '../commands/route-error.js'
import {
  LOCAL_RELAY_ERROR_CODES,
  RELAY_ERROR_CLEAR_REASON,
  RELAY_ERROR_CODES,
  RELAY_ERROR_SEVERITY,
  clearRelayError,
  getRelayErrorMessage,
  setRelayError,
} from './error-state.js'

const log = createLogger('relay')

// Service Worker 启动时缓存版本号，避免运行期间磁盘 manifest 变化导致不一致
const LOADED_VERSION = chrome.runtime.getManifest().version

function parseChromeMajorVersion(userAgent) {
  if (typeof userAgent !== 'string') return null
  const match = /\bChrome\/(\d+)(?:\.|\s|$)/.exec(userAgent)
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) && major > 0 ? major : null
}

// Read once per Service Worker lifetime. Relay reconnects reuse this cached value.
const CHROME_MAJOR_VERSION = parseChromeMajorVersion(globalThis.navigator?.userAgent)

const WS_CONNECT_TIMEOUT = 5000
const PREFLIGHT_TIMEOUT = 2000
const HANDSHAKE_TIMEOUT = 5000
const CONTROL_FRAME_ENCRYPT_TIMEOUT_MS = 1000
// Packaged Chrome extensions clamp chrome.alarms shorter than 0.5 minutes to 30s.
// Use the production floor explicitly so dev (unpacked) and release behave alike.
const CHROME_ALARM_MIN_DELAY_MINUTES = 0.5
// Keep this after the first reconnect alarm so transient disconnects get one
// full reconnect attempt before we notify the user.
const DISCONNECT_NOTIFY_DELAY_MIN = CHROME_ALARM_MIN_DELAY_MINUTES * 2
const LOCAL_FAILURE_DISABLE_THRESHOLD = 3
const LOCAL_FAILURE_STORAGE_KEY = 'relayLocalFailureState'
const LOCAL_FAILURE_WINDOW_MS = 10 * 60 * 1000

// ── Alarm names (centralized) ──

const ALARM_KEEP_ALIVE = 'relayKeepAlive'
const ALARM_RECONNECT = 'relayReconnect'
const ALARM_DISCONNECT_NOTIFY = 'relayDisconnectNotify'
const KEEP_ALIVE_PERIOD_MINUTES = 0.5

// ── Operation log ring buffer (O(1) push, O(n) read) ──
const LOG_BUFFER_MAX = 200
const _logRing = new Array(LOG_BUFFER_MAX)
let _logHead = 0   // next write position
let _logCount = 0   // total entries written (clamped to max)

function pushLog(direction, method, detail) {
  _logRing[_logHead] = { ts: Date.now(), dir: direction, method, detail }
  _logHead = (_logHead + 1) % LOG_BUFFER_MAX
  if (_logCount < LOG_BUFFER_MAX) _logCount++
}

export function getLogBuffer(limit = 100) {
  const n = Math.min(limit, _logCount)
  const result = new Array(n)
  // read oldest-first: start = (head - count) mod max, then advance
  let idx = (_logHead - _logCount + LOG_BUFFER_MAX) % LOG_BUFFER_MAX
  const skip = _logCount - n
  idx = (idx + skip) % LOG_BUFFER_MAX
  for (let i = 0; i < n; i++) {
    result[i] = _logRing[idx]
    idx = (idx + 1) % LOG_BUFFER_MAX
  }
  return result
}

// ── Module state ──

// UI / persisted state mirror
let _state = RelayState.DISABLED

// Self-reload guard
let _reloadScheduled = false

// Transport
/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {AbortController|null} */
let connectAbortCtrl = null

// Handshake gate: ensureConnection waits for helloAck before resolving,
// so that onConnected callbacks only fire after encryption is active.
/** @type {((value?: any) => void)|null} */
let _handshakeResolve = null
/** @type {((reason?: any) => void)|null} */
let _handshakeReject = null
let relayHandshakeReady = false

// Public connect lifecycle
/** @type {Promise<boolean>|null} */
let connectAndAttachPromise = null
/** @type {unknown} */
let lastConnectionError = null

// Reconnect / alarms
let _reconnectPending = false
// Incremented synchronously by disconnect(); in-flight connect attempts must
// not write disconnected/connected state after a newer disable intent.
let disableGeneration = 0
// Incremented synchronously by attachRelayTransport() for every new transport.
// disableGeneration only catches a user disable; this catches the case where a
// newer transport attached (and possibly reconnected) while an older socket's
// close continuation was suspended on an await, so that stale continuation must
// not rewrite the model back to disconnected.
let transportGeneration = 0
// Socket-owned resources outlive the connection attempt and abort on transport loss.
const transportControllers = new WeakMap()

// Messaging
let _sendChain = Promise.resolve()

/**
 * Callbacks injected by background.js at init time.
 *
 * onShutdown(reason) merges the old onClosed + onDisabled into a single
 * atomic callback so callers can handle group dissolution and tab cleanup
 * in one place, avoiding ordering bugs.
 *
 * @type {{ onMessage: (msg: any, commandContext?: any) => Promise<any>, onControlMessage: (msg: any) => Promise<any>|void, onShutdown: (reason: 'connectionLost'|'disabled') => Promise<any>|void, onConnected: () => Promise<any>|void }}
 */
let callbacks = {
  onMessage: async () => null,
  onControlMessage: async () => {},
  onShutdown: async (_reason) => {},
  onConnected: () => {},
}

function setState(newState) {
  _state = newState
  const ui = STATE_UI[newState]
  void setIconWithDot(ui.dotColor).catch(() => {})
  void chrome.action.setTitle({ title: ui.title })
  void chrome.storage.local.set({ _relayState: newState })
}

export function getRelayState() {
  return _state
}

// ── State mutation helpers ──

function markHandshakePending() {
  relayHandshakeReady = false
  setTraceEnabled(false)
}

function markHandshakeReady() {
  relayHandshakeReady = true
}

function clearHandshakeGate() {
  _handshakeResolve = null
  _handshakeReject = null
}

function hasPendingHandshakeGate() {
  return _handshakeReject !== null
}

function resolveHandshakeGate(message) {
  const resolve = _handshakeResolve
  if (!resolve) return false
  resolve(message)
  clearHandshakeGate()
  return true
}

function rejectHandshakeGate(error) {
  markHandshakePending()
  const reject = _handshakeReject
  if (!reject) return false
  clearHandshakeGate()
  reject(error)
  return true
}

function rejectHandshakeGateIfCurrent(reject, error) {
  if (_handshakeReject !== reject) return false
  return rejectHandshakeGate(error)
}

function waitForHelloAck(ws) {
  return new Promise((resolve, reject) => {
    let timeoutId = null
    const resolveGate = (message) => {
      if (timeoutId !== null) clearTimeout(timeoutId)
      resolve(message)
    }
    const rejectGate = (error) => {
      if (timeoutId !== null) clearTimeout(timeoutId)
      reject(error)
    }
    _handshakeResolve = resolveGate
    _handshakeReject = rejectGate
    timeoutId = setTimeout(() => {
      if (!rejectHandshakeGateIfCurrent(
        rejectGate,
        new Error('Handshake timeout — no helloAck received'),
      )) {
        return
      }
      try { ws.close(4002, 'Handshake timeout') } catch { /* ignore */ }
    }, HANDSHAKE_TIMEOUT)
  })
}

function attachRelayTransport(ws) {
  if (relayWs) transportControllers.get(relayWs)?.abort()
  transportControllers.set(ws, new AbortController())
  relayWs = ws
  transportGeneration++
  markHandshakePending()
}

function isCurrentRelayTransport(ws, signal) {
  return relayWs === ws && signal.aborted !== true
}

function closeStaleTransport(ws) {
  try { ws.close() } catch { /* ignore */ }
}

function failCurrentRelayTransport(ws) {
  closeStaleTransport(ws)
  if (relayWs === ws) clearTransportState()
}

async function assertCanUseRelayTransport(ws, signal) {
  // Keep signal.aborted as the first operand: abort cancellation must
  // short-circuit synchronously before any await creates a race window.
  if (signal.aborted || !(await isRelayEnabled()) || !isCurrentRelayTransport(ws, signal)
    || ws.readyState !== WebSocket.OPEN) {
    failCurrentRelayTransport(ws)
    throw new Error('Connection cancelled')
  }
}

function clearTransportState() {
  if (relayWs) transportControllers.get(relayWs)?.abort()
  markHandshakePending()
  relayWs = null
  resetEncryption()
  _sendChain = Promise.resolve()
}

function clearPendingTransportConnect(currentAbortCtrl, currentConnectPromise) {
  if (connectAbortCtrl === currentAbortCtrl) connectAbortCtrl = null
  if (relayConnectPromise === currentConnectPromise) relayConnectPromise = null
}

function abortPendingTransportConnect() {
  if (connectAbortCtrl) {
    connectAbortCtrl.abort()
    connectAbortCtrl = null
  }
  relayConnectPromise = null
}

function abortPendingConnectionAttempt() {
  abortPendingConnectAndAttach()
  abortPendingTransportConnect()
}

function markReconnectIdle() {
  _reconnectPending = false
}

function markReconnectScheduled() {
  _reconnectPending = true
}

function clearConnectAndAttachIfCurrent(currentPromise) {
  if (connectAndAttachPromise === currentPromise) connectAndAttachPromise = null
}

function abortPendingConnectAndAttach() {
  connectAndAttachPromise = null
}

function isGenerationCurrent(generation) {
  return generation === disableGeneration
}

function isTransportGenerationCurrent(generation) {
  return generation === transportGeneration
}

function markRelayEnabledDisconnected() {
  if (_state !== RelayState.DISCONNECTED) setState(RelayState.DISCONNECTED)
}

function createLocalFailureError(message, code, cause) {
  const err = new Error(message, { cause })
  err.relayErrorCode = code
  return err
}

function getLocalFailureCode(err) {
  const code = err && typeof err === 'object' ? err.relayErrorCode : null
  return LOCAL_RELAY_ERROR_CODES.has(code) ? code : null
}

let localFailureStateMayExist = true

async function clearLocalFailureTracking({
  clearErrorReason = RELAY_ERROR_CLEAR_REASON.CAUSE_GONE,
} = {}) {
  const shouldCheckRelayError =
    clearErrorReason !== RELAY_ERROR_CLEAR_REASON.CAUSE_GONE || localFailureStateMayExist
  if (localFailureStateMayExist) {
    await chrome.storage.local.remove(LOCAL_FAILURE_STORAGE_KEY)
    localFailureStateMayExist = false
  }
  if (clearErrorReason && shouldCheckRelayError) await clearRelayError(clearErrorReason)
}

async function recordLocalFailure(code) {
  const now = Date.now()
  const stored = await chrome.storage.local.get([LOCAL_FAILURE_STORAGE_KEY])
  const prev = stored[LOCAL_FAILURE_STORAGE_KEY]
  const prevCount =
    prev &&
    prev.code === code &&
    typeof prev.count === 'number' &&
    typeof prev.at === 'number' &&
    now - prev.at < LOCAL_FAILURE_WINDOW_MS
      ? prev.count
      : 0
  const count = prevCount + 1
  await chrome.storage.local.set({
    [LOCAL_FAILURE_STORAGE_KEY]: { code, count, at: now },
  })
  localFailureStateMayExist = true
  await setRelayError(code, { severity: RELAY_ERROR_SEVERITY.RETRYING })
  return count
}

async function handleLocalFailureLimit(err) {
  const code = getLocalFailureCode(err)
  if (!code) {
    await clearLocalFailureTracking({ clearErrorReason: RELAY_ERROR_CLEAR_REASON.CAUSE_GONE })
    return false
  }

  const count = await recordLocalFailure(code)
  if (count < LOCAL_FAILURE_DISABLE_THRESHOLD) return false

  log.warn(
    `connectAndAttach: disabling relay after ${count} consecutive local failures: ${code}`,
  )
  await setRelayError(code, { severity: RELAY_ERROR_SEVERITY.TERMINAL })
  notifyError('Relay Disabled', getRelayErrorMessage(code, RELAY_ERROR_SEVERITY.TERMINAL))
  await disconnect({ preserveRelayError: true })
  return true
}

// ── Self-reload (auto-update support) ──
//
// 桌面端在 Extension.helloAck 里下发 { action: 'reload', reloadTargetKey }
// 来请求扩展调用 chrome.runtime.reload() 拾取磁盘上的新版文件。
//
// 守卫策略（防 reload 循环）：
//   chrome.storage.local.relayReloadState = { targetKey, at }
//   - 如果上次 reload 针对同一个 targetKey 且距今 < RELOAD_COOLDOWN_MS，跳过
//   - 否则写入新 state 然后 reload（500ms 延迟给 storage flush 留时间）
//
// targetKey 格式：
//   'ext:<version>'  — extensionVersion 不一致
//   'proto:<n>'      — protocolVersion 不兼容
const RELOAD_STORAGE_KEY = 'relayReloadState'
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000 // 10 分钟，避免磁盘未更新时无限 reload
const RELOAD_DEBOUNCE_MS = 500             // 给日志/storage 写入 flush 的缓冲

async function maybeSelfReload(targetKey) {
  log.info('maybeSelfReload: in')
  if (_reloadScheduled) return

  // 防御：ext:<version> 类型用启动时缓存的版本号自验证，
  // 避免运行期间磁盘 manifest 已更新但 Service Worker 还是旧代码的误判
  if (targetKey.startsWith('ext:')) {
    const wanted = targetKey.slice(4)
    if (LOADED_VERSION === wanted) {
      log.info(`maybeSelfReload: loaded version ${LOADED_VERSION} already matches target, skip`)
      return
    }
  }

  try {
    const store = await chrome.storage.local.get([RELOAD_STORAGE_KEY])
    const prev = store[RELOAD_STORAGE_KEY]
    if (
      prev &&
      prev.targetKey === targetKey &&
      typeof prev.at === 'number' &&
      Date.now() - prev.at < RELOAD_COOLDOWN_MS
    ) {
      const ageMin = ((Date.now() - prev.at) / 60000).toFixed(1)
      log.warn(
        `maybeSelfReload: cooldown active for targetKey=${targetKey} (last attempt ${ageMin}min ago) — skip`,
      )
      return
    }

    await chrome.storage.local.set({
      [RELOAD_STORAGE_KEY]: { targetKey, at: Date.now() },
    })
  } catch (err) {
    log.warn('maybeSelfReload: storage failed, aborting', err)
    return
  }

  _reloadScheduled = true
  log.info(`maybeSelfReload: scheduling chrome.runtime.reload() for targetKey=${targetKey}`)
  setTimeout(() => {
    try {
      chrome.runtime.reload()
    } catch (err) {
      log.error('maybeSelfReload: chrome.runtime.reload() threw', err)
      _reloadScheduled = false
    }
  }, RELOAD_DEBOUNCE_MS)
}

// ── Notifications ──

function notifyError(title, message) {
  chrome.notifications.create('matchaclaw-relay-error', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `MatchaClaw Relay: ${title}`,
    message,
    priority: 2,
  }, () => {
    if (chrome.runtime.lastError) {
      log.warn('notification create failed:', chrome.runtime.lastError.message)
    }
  })
}

// ── Port helpers ──

async function getControlPort() {
  const stored = await chrome.storage.local.get(['controlPort', 'relayPort'])
  const raw = Number.parseInt(String(stored.controlPort || ''), 10)
  if (Number.isFinite(raw) && raw > 0 && raw <= 65535) return raw
  const relayRaw = Number.parseInt(String(stored.relayPort || ''), 10)
  if (Number.isFinite(relayRaw) && relayRaw > 0 && relayRaw <= 65535) {
    const inferred = clampPort(relayRaw - RELAY_PORT_OFFSET)
    void chrome.storage.local.set({ controlPort: inferred })
    return inferred
  }
  return DEFAULT_CONTROL_PORT
}

// ── Multi-port auto-detect ──

// Alternate relay port to probe alongside the default
const ALT_RELAY_PORT = DEFAULT_CONTROL_PORT + 1 + RELAY_PORT_OFFSET

async function getRelayPort() {
  return computeRelayPort(await getControlPort())
}

/**
 * Whether to race multiple candidate ports.
 * Returns true only when the user hasn't manually configured a port.
 */
async function shouldProbeMultiplePorts() {
  return (await getControlPort()) === DEFAULT_CONTROL_PORT
}

// ── Relay enabled persistence ──

export async function setRelayEnabled(enabled) {
  await chrome.storage.local.set({ relayEnabled: enabled })
}

export async function isRelayEnabled() {
  const stored = await chrome.storage.local.get(['relayEnabled'])
  return stored.relayEnabled === true
}

export function initRelay(cbs) {
  callbacks = { ...callbacks, ...cbs }
}

// ── Derived state queries ──

function isRelayTransportOpen() {
  return relayWs !== null && relayWs.readyState === WebSocket.OPEN
}

export function isRelayConnected() {
  return isRelayTransportOpen() && relayHandshakeReady
}

export function isRelayActive() {
  return (
    isRelayTransportOpen() ||
    connectAndAttachPromise !== null ||
    relayConnectPromise !== null ||
    (relayWs !== null && relayWs.readyState === WebSocket.CONNECTING)
  )
}

export function isReconnecting() {
  return _reconnectPending
}

export function getRelayConnectionSnapshot() {
  return {
    state: _state,
    connected: isRelayConnected(),
    transportOpen: isRelayTransportOpen(),
    transportGeneration,
    handshakeReady: relayHandshakeReady,
    active: isRelayActive(),
    reconnecting: isReconnecting(),
  }
}

// ── Messaging ──

function outboundLogDetail(payload) {
  if (payload.params?.method) return payload.params.method
  if (payload.error != null) {
    const code = typeof payload.error === 'object' ? payload.error.code : undefined
    return `error:${typeof code === 'string' ? code : 'COMMAND_FAILED'}`
  }
  return ''
}

// Sequential send chain to ensure message ordering when encryption is active.
// Web Crypto API is always async; chaining ensures encrypted messages
// are sent in the same order as the corresponding sendToRelay calls.
export function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || !isRelayConnected()) {
    throw new Error('Relay not connected')
  }
  pushLog('↑', payload.method || `id:${payload.id}`, outboundLogDetail(payload))
  const raw = JSON.stringify(payload)
  _sendChain = _sendChain.then(async () => {
    if (relayWs !== ws || !isRelayConnected()) return
    const encrypted = await encryptMessage(raw)
    if (relayWs === ws && isRelayConnected()) ws.send(encrypted)
  }).catch(() => {})
}

export function trySendToRelay(payload) {
  try {
    sendToRelay(payload)
  } catch (err) {
    log.debug('trySendToRelay failed:', err)
  }
}

/**
 * Responses to inbound request ids must use this transport-bound helper so
 * stale transports cannot answer on a newer WebSocket. The exported
 * trySendToRelay is identity-blind and only for extension-initiated reports.
 */
function trySendToCurrentRelay(ws, signal, payload) {
  if (!isCurrentRelayTransport(ws, signal)) return false
  try {
    sendToRelay(payload)
    return true
  } catch (err) {
    log.debug('trySendToCurrentRelay failed:', err)
    return false
  }
}

async function sendControlFrameToCurrentRelay(
  ws,
  signal,
  payload,
  { label, logFailure = true },
) {
  if (!isCurrentRelayTransport(ws, signal) || !isRelayConnected()) return false
  pushLog('↑', payload.method || `id:${payload.id}`, label)

  let timer
  try {
    const wireMessage = await Promise.race([
      encryptMessage(JSON.stringify(payload)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('control frame encryption timed out')),
          CONTROL_FRAME_ENCRYPT_TIMEOUT_MS,
        )
      }),
    ])
    if (!isCurrentRelayTransport(ws, signal) || ws.readyState !== WebSocket.OPEN) return false
    ws.send(wireMessage)
    return true
  } catch (err) {
    if (logFailure) log.warn(`send ${label} failed:`, err)
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function sendPongToCurrentRelay(ws, signal) {
  return sendControlFrameToCurrentRelay(
    ws,
    signal,
    { method: 'pong' },
    { label: 'pong' },
  )
}

// ── Alarm-based timer management ──

/**
 * Ensure the keep-alive alarm exists without replacing its next scheduled tick.
 */
export async function ensureKeepAliveAlarm() {
  const existing = await chrome.alarms.get(ALARM_KEEP_ALIVE)
  if (!existing || existing.periodInMinutes !== KEEP_ALIVE_PERIOD_MINUTES) {
    chrome.alarms.create(ALARM_KEEP_ALIVE, { periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES })
  }
}

function clearKeepAliveAlarm() {
  chrome.alarms.clear(ALARM_KEEP_ALIVE)
}

function cancelReconnect() {
  markReconnectIdle()
  chrome.alarms.clear(ALARM_RECONNECT)
}

function cancelDisconnectNotify() {
  chrome.alarms.clear(ALARM_DISCONNECT_NOTIFY)
}

/**
 * Schedule the next reconnect attempt. The delay is always the chrome.alarms
 * floor: see the file header for why a localhost peer must not be backed off.
 * Every failure class retries on the same cadence, so no caller has to classify
 * the error to get a timely retry.
 */
function scheduleReconnect() {
  if (_reconnectPending) return
  markReconnectScheduled()
  chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes: CHROME_ALARM_MIN_DELAY_MINUTES })
}

export async function hasPendingReconnectAlarm() {
  return _reconnectPending || Boolean(await chrome.alarms.get(ALARM_RECONNECT))
}

/**
 * Handle alarm events relevant to relay connection.
 * Called from background.js onAlarm listener.
 * Returns true if the alarm was handled.
 */
export function handleConnectionAlarm(alarmName) {
  if (alarmName === ALARM_RECONNECT) {
    markReconnectIdle()
    // connectAndAttach auto-schedules reconnect on failure
    void connectAndAttach()
    return true
  }

  if (alarmName === ALARM_DISCONNECT_NOTIFY) {
    void (async () => {
      if ((await isRelayEnabled()) && !isRelayConnected()) {
        notifyError('Disconnected', 'Relay connection lost. Auto-reconnecting…')
      }
    })().catch((err) => {
      log.warn('handleConnectionAlarm: disconnect notify check failed:', err)
    })
    return true
  }

  return false
}

// ── WebSocket connection ──

/**
 * Connect to a single relay port: HEAD preflight → WebSocket open.
 * @param {number} port
 * @param {AbortSignal} signal - allows the caller to cancel (e.g. when another port wins the race)
 * @returns {Promise<WebSocket>}
 */
function connectToPort(port, signal) {
  if (signal.aborted) return Promise.reject(new Error('Connection cancelled'))

  const httpBase = `http://127.0.0.1:${port}`
  const wsUrl = `ws://127.0.0.1:${port}/extension`

  return (async () => {
    const preflightCtrl = new AbortController()
    const preflightTimer = setTimeout(() => preflightCtrl.abort(), PREFLIGHT_TIMEOUT)
    signal.addEventListener('abort', () => preflightCtrl.abort(), { once: true })
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: preflightCtrl.signal })
        .catch((err) => {
          if (signal.aborted) throw new Error('Connection cancelled')
          throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
        })
    } finally {
      clearTimeout(preflightTimer)
    }

    if (signal.aborted) throw new Error('Connection cancelled')

    const ws = new WebSocket(wsUrl)

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), WS_CONNECT_TIMEOUT)
        const cleanup = () => { clearTimeout(t); signal.removeEventListener('abort', onAbort) }
        const onAbort = () => { cleanup(); reject(new Error('Connection cancelled')) }
        signal.addEventListener('abort', onAbort, { once: true })
        ws.onopen = () => { cleanup(); resolve() }
        ws.onerror = () => { cleanup(); reject(new Error('WebSocket connect failed')) }
        ws.onclose = (ev) => { cleanup(); reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`)) }
      })
    } catch (err) {
      try { ws.close() } catch { /* already closing */ }
      throw err
    }

    if (signal.aborted) {
      try { ws.close() } catch { /* noop */ }
      throw new Error('Connection cancelled')
    }

    return ws
  })()
}

/**
 * Race multiple candidate ports in parallel via Promise.any.
 * First port to complete preflight + WS open wins; losers are aborted and closed.
 * Falls back to single-port connect when only one candidate.
 *
 * @param {number[]} ports
 * @param {AbortSignal} signal
 * @returns {Promise<WebSocket>}
 */
async function raceConnectPorts(ports, signal) {
  if (signal.aborted) throw new Error('Connection cancelled')
  if (ports.length === 1) return connectToPort(ports[0], signal)

  const perPort = ports.map((port) => {
    const ctrl = new AbortController()
    signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    return { port, ctrl, promise: connectToPort(port, ctrl.signal) }
  })

  const winner = await Promise.any(perPort.map(async (entry) => {
    const ws = await entry.promise
    return { ws, port: entry.port }
  }))

  for (const entry of perPort) {
    if (entry.port !== winner.port) {
      entry.ctrl.abort()
      entry.promise.then((ws) => { try { ws.close() } catch {} }).catch(() => {})
    }
  }

  log.info('connected to relay port', winner.port)
  return winner.ws
}

async function ensureConnection() {
  if (isRelayConnected()) return
  if (relayConnectPromise) return await relayConnectPromise

  const currentAbortCtrl = new AbortController()
  connectAbortCtrl = currentAbortCtrl
  const { signal } = currentAbortCtrl

  const currentConnectPromise = (async () => {
    const browserInstanceId = await getBrowserInstanceId()
    const defaultPort = await getRelayPort()
    const multiProbe = await shouldProbeMultiplePorts()
    const ports = multiProbe && ALT_RELAY_PORT !== defaultPort
      ? [ALT_RELAY_PORT, defaultPort]
      : [defaultPort]

    const ws = await raceConnectPorts(ports, signal)

    if (signal.aborted || !(await isRelayEnabled())) {
      closeStaleTransport(ws)
      throw new Error('Connection cancelled')
    }

    attachRelayTransport(ws)
    // From attach to the first checkpoint below, do not insert an await:
    // relayWs must either be usable or cleared synchronously if the attempt was aborted.
    ws.onmessage = (event) => {
      if (!isCurrentRelayTransport(ws, signal)) return
      void onRelayMessage(String(event.data || ''), ws, signal).catch((err) => {
        log.warn('relay message handling failed:', err)
      })
    }
    // close/error intentionally use the raw identity check: only the current
    // transport may advance connection-lost cleanup; aborted stale transports are ignored.
    ws.onclose = () => { if (relayWs === ws) onRelayClosed('closed') }
    ws.onerror = () => { if (relayWs === ws) onRelayClosed('error') }
    await assertCanUseRelayTransport(ws, signal)

    // Handshake: send Extension.hello so the server knows our protocol version.
    //
    // protocolVersion: 桌面端与扩展之间的通信协议兼容性标识（整数），
    //   与 manifest.json 中的 version（展示版本号）是两个独立概念。
    //   仅在通信协议发生不兼容变更时才递增。
    //
    // extensionVersion: 从 manifest.json 读取的展示版本号，
    //   仅用于 mismatch 时桌面端展示给用户，不参与兼容性判断。
    //
    // encryptedSessionKey: AES-256 session key encrypted with the embedded RSA public key.
    //   The encrypted helloAck is required before the transport becomes usable.
    //
    // ⚠️ 如果升级 protocolVersion，必须同步修改以下位置：
    //   1. 此处的 protocolVersion 值
    //   2. 桌面端 server.ts — 搜索 `protocolVersion !== 1` 和 `requiredProtocol: 1`
    //      路径: packages/sdk/src/browser/relay/server.ts
    const helloParams = {
      protocolVersion: 1,
      extensionVersion: LOADED_VERSION,
      browserInstanceId,
      browserName: 'Chrome',
      extensionId: chrome.runtime.id,
      ...(CHROME_MAJOR_VERSION == null ? {} : { chromeMajorVersion: CHROME_MAJOR_VERSION }),
    }
    try {
      const { encryptedSessionKey } = await prepareSessionKey()
      helloParams.encryptedSessionKey = encryptedSessionKey
      log.info('Prepared encrypted session key for handshake')
    } catch (err) {
      log.warn('Failed to prepare session key:', err)
      failCurrentRelayTransport(ws)
      throw createLocalFailureError(
        'Failed to prepare session key',
        RELAY_ERROR_CODES.SESSION_KEY_FAILED,
        err,
      )
    }
    await assertCanUseRelayTransport(ws, signal)
    const helloAckPromise = waitForHelloAck(ws)
    try {
      ws.send(JSON.stringify({
        method: 'Extension.hello',
        params: helloParams,
      }))
    } catch (err) {
      rejectHandshakeGate(err)
      failCurrentRelayTransport(ws)
    }

    // Mirror selection after transport readiness, before onConnected starts resync.
    const helloAck = await helloAckPromise
    await assertCanUseRelayTransport(ws, signal)
    try {
      await callbacks.onControlMessage(helloAck)
    } catch (err) {
      failCurrentRelayTransport(ws)
      throw err
    }
    await assertCanUseRelayTransport(ws, signal)
  })()
  relayConnectPromise = currentConnectPromise

  try {
    await currentConnectPromise
  } finally {
    clearPendingTransportConnect(currentAbortCtrl, currentConnectPromise)
  }
}

function onRelayClosed(reason) {
  const closedGeneration = disableGeneration
  const closedTransportGeneration = transportGeneration
  log.info('onRelayClosed:', reason)
  rejectHandshakeGate(new Error(`Connection closed during handshake: ${reason}`))
  clearTransportState()
  if (_state !== RelayState.DISABLED) markRelayEnabledDisconnected()

  // Resource cleanup is independent of the user's enabled intent; only
  // disconnected UI, notify alarm, and reconnect scheduling are gated below.
  void Promise.resolve(callbacks.onShutdown('connectionLost')).catch((err) => {
    log.warn('onRelayClosed: onShutdown error:', err)
  })
  cancelDisconnectNotify()

  void (async () => {
    if (!(await isRelayEnabled())) return
    if (!isGenerationCurrent(closedGeneration)) return
    // A newer transport attached while we awaited above — it may already have
    // reconnected and marked the model connected. Writing disconnected here would
    // recreate the "connected but state unavailable" split this whole model exists
    // to prevent, so the stale continuation must yield to the live transport.
    if (!isTransportGenerationCurrent(closedTransportGeneration)) return
    markRelayEnabledDisconnected()
    chrome.alarms.create(ALARM_DISCONNECT_NOTIFY, { delayInMinutes: DISCONNECT_NOTIFY_DELAY_MIN })
    scheduleReconnect()
  })().catch((err) => {
    log.warn('onRelayClosed: reconnect scheduling failed:', err)
  })
}

async function onRelayMessage(rawText, ws, signal) {
  if (!isCurrentRelayTransport(ws, signal)) return
  let text = rawText
  try {
    text = await decryptMessage(rawText)
  } catch (err) {
    log.warn('decryptMessage failed, dropping:', err)
    return
  }
  if (!isCurrentRelayTransport(ws, signal)) return

  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg?.method === 'ping') {
    void sendPongToCurrentRelay(ws, signal)
    return
  }

  // 处理桌面端对 Extension.hello 的应答。
  // status === 'ok' 表示协议版本匹配，连接可正常使用；
  // 其他状态（如 'version_mismatch'）表示桌面端判定协议或扩展 major 不兼容，
  // 此时桌面端会主动关闭 WebSocket（4001），扩展侧触发 onRelayClosed 重连。
  //
  // 自动升级：当 params.action === 'reload' 且带上 reloadTargetKey 时，
  // 扩展尝试 chrome.runtime.reload()（unpacked 模式会重新读磁盘上的新版文件）。
  // 两种触发来源统一走 maybeSelfReload：
  //   - protocolVersion/major 不匹配 → reloadTargetKey = 'proto:<n>' 或 'ext:<version>'（随后 ws 会被关闭）
  //   - extensionVersion 不一致但协议兼容 → reloadTargetKey = 'ext:<version>'（连接保持可用）
  // 桌面端主动要求扩展 reload（独立于 helloAck 的显式指令）
  if (msg?.method === 'Extension.reload') {
    if (!isRelayConnected() || !isEncryptedWireMessage(rawText)) return
    log.info('Extension.reload: received reload command from desktop')
    void maybeSelfReload(msg.params?.reloadTargetKey || 'ext:forced')
    return
  }

  if (msg?.method === 'Extension.helloAck') {
    if (!isCurrentRelayTransport(ws, signal)) return
    const p = msg.params || {}
    if (isEncryptedWireMessage(rawText) && p.action === 'reload'
      && typeof p.reloadTargetKey === 'string' && p.reloadTargetKey.length > 0) {
      void maybeSelfReload(p.reloadTargetKey)
    }
    if (!hasPendingHandshakeGate() || relayHandshakeReady) {
      log.warn('Extension.helloAck: ignoring duplicate or late helloAck')
      return
    }
    if (p.status === 'ok') {
      if (p.encrypted === true && isEncryptedWireMessage(rawText)) {
        try {
          activateEncryption()
        } catch (err) {
          log.warn('Extension.helloAck: failed to activate encryption:', err)
          rejectHandshakeGate(createLocalFailureError(
            'Failed to activate encryption',
            RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED,
            err,
          ))
          failCurrentRelayTransport(ws)
          return
        }
        markHandshakeReady()
        setTraceEnabled(p.traceEnabled === true)
        void clearRelayError(RELAY_ERROR_CLEAR_REASON.SUCCESS).catch((err) => {
          log.warn('Extension.helloAck: clear relay error failed:', err)
        })
        log.info('Extension.helloAck: handshake OK — transport encryption activated (AES-256-GCM)')
        resolveHandshakeGate(msg)
      } else {
        log.warn('Extension.helloAck: server does not support encryption — disconnecting')
        void setRelayError(RELAY_ERROR_CODES.ENCRYPTION_UNSUPPORTED).catch((err) => {
          log.warn('Extension.helloAck: set relay error failed:', err)
        })
        rejectHandshakeGate(new Error('Server does not support encryption'))
        void disconnect({ preserveRelayError: true }).catch((err) => {
          log.warn('Extension.helloAck: disconnect after encryption rejection failed:', err)
        })
        return
      }
    } else {
      log.warn('Extension.helloAck: server rejected —', p.status)
      rejectHandshakeGate(new Error(`Server rejected handshake: ${p.status}`))
      failCurrentRelayTransport(ws)
    }
    return
  }

  if (!isRelayConnected() || !isEncryptedWireMessage(rawText)) return

  if (msg?.method === 'Extension.selectionChanged') {
    try {
      await relayConnectPromise
      if (!isCurrentRelayTransport(ws, signal) || !isRelayConnected()) return
      await callbacks.onControlMessage(msg)
    } catch (err) {
      log.warn('Extension.selectionChanged: onControlMessage failed:', err)
    }
    return
  }

  if (msg?.method === 'Extension.disconnectRelay') {
    void disconnect().catch((err) => {
      log.warn('Extension.disconnectRelay failed:', err)
    })
    return
  }

  const MESSAGE_EXPIRE_MS = 130_000
  if (msg?.method !== 'forwardCDPCommand' && typeof msg?.ts === 'number') {
    const age = Date.now() - msg.ts
    if (age > MESSAGE_EXPIRE_MS) {
      log.warn('dropping expired message:', msg.method || msg.id, 'age:', age, 'ms')
      if (typeof msg.id === 'number') {
        trySendToCurrentRelay(
          ws,
          signal,
          { id: msg.id, error: `Message expired (age ${age}ms > ${MESSAGE_EXPIRE_MS}ms)` },
        )
      }
      return
    }
  }

  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    const cdpMethod = msg.params?.method || ''
    const commandContext = createCommandContext({
      requestId: msg.id,
      method: cdpMethod,
      sentAt: msg.sentAt,
      deadlineAt: msg.deadlineAt,
    })
    commandContext.transportSignal = transportControllers.get(ws)?.signal
    pushLog('↓', msg.method, cdpMethod)
    // Screenshot phase probes are transport-bound control frames. They contain
    // only request correlation and timings, never page URLs or image bytes.
    // Send outside the business encryption chain so a stalled response cannot
    // conceal the last stage reached by the extension.
    if (cdpMethod === 'Page.captureScreenshot') {
      commandContext.reportProgress = (stage) => {
        void sendControlFrameToCurrentRelay(
          ws,
          signal,
          {
            method: 'Extension.commandProgress',
            params: {
              requestId: msg.id,
              stage,
              elapsedMs: Math.max(0, Date.now() - commandContext.receivedAt),
            },
          },
          { label: 'screenshot progress', logFailure: false },
        )
      }
      commandContext.reportProgress('received')
    }
    try {
      if (!isCurrentRelayTransport(ws, signal) || !isRelayConnected()) return
      if (commandContext.isExpired()) {
        throw new CommandDeadlineExceededError({
          context: commandContext,
          stage: 'command_dispatch',
          operationElapsedMs: 0,
          timeoutSource: 'command_deadline',
        })
      }
      const result = await callbacks.onMessage(msg, commandContext)
      commandContext.reportProgress?.('response_ready')
      trySendToCurrentRelay(ws, signal, { id: msg.id, result })
    } catch (err) {
      const deadlineError = err instanceof CommandDeadlineExceededError
        ? serializeCommandDeadlineError(err)
        : null
      const routeError = err instanceof CdpCommandRouteError
        ? serializeCommandRouteError(err, { requestId: msg.id })
        : null
      const errorDetail = deadlineError || routeError || (
        err?.errorDetail && typeof err.errorDetail === 'object' && !Array.isArray(err.errorDetail)
          ? err.errorDetail
          : typeof err?.code === 'string' && err?.outcome === 'unknown' && err?.retryable === false
            ? { code: err.code, message: err.message, outcome: err.outcome, retryable: false }
            : null
      )
      const diagnostics = [
        `requestId=${msg.id}`,
        `method=${cdpMethod}`,
        `code=${errorDetail?.routeCode || errorDetail?.code || 'COMMAND_FAILED'}`,
        `stage=${errorDetail?.stage || 'unknown'}`,
        `outcome=${errorDetail?.outcome || 'failed'}`,
      ]
      if (deadlineError) {
        diagnostics.push(
          `commandAgeMs=${deadlineError.commandAgeMs}`,
          `operationElapsedMs=${deadlineError.operationElapsedMs}`,
          `deadlineSource=${deadlineError.deadlineSource}`,
          `timeoutSource=${deadlineError.timeoutSource}`,
        )
      }
      log.warn('command.failed', ...diagnostics)
      // Preserve the last execution stage on failure. Reporting response_ready
      // here would hide send_command_timeout in the relay's monotonic stage log.

      if (deadlineError) {
        await sendControlFrameToCurrentRelay(
          ws,
          signal,
          { id: msg.id, error: deadlineError.message, errorDetail: deadlineError },
          { label: 'deadline error', logFailure: false },
        )
        return
      }
      trySendToCurrentRelay(ws, signal, {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
        ...(errorDetail ? { errorDetail } : {}),
      })
    }
  }
}

// ── Public lifecycle methods ──

/**
 * Attempt to connect. On failure, automatically schedules reconnect
 * if relay is still enabled — callers do NOT need to call scheduleReconnect.
 */
export async function connectAndAttach() {
  const t0 = performance.now()
  log.debug(
    'connectAndAttach: begin, connected:',
    isRelayConnected(),
    'reconnecting:',
    _reconnectPending,
  )
  if (isRelayConnected()) {
    lastConnectionError = null
    return true
  }
  if (connectAndAttachPromise) return await connectAndAttachPromise

  const currentConnectAndAttachPromise = (async () => {
    const connectGeneration = disableGeneration
    if (!(await isRelayEnabled())) {
      lastConnectionError = new Error('Relay disabled')
      log.debug('connectAndAttach: relay not enabled')
      return false
    }
    if (!isGenerationCurrent(connectGeneration)) {
      lastConnectionError = new Error('Relay disabled while connect was starting')
      log.debug('connectAndAttach: stale connect after relay disabled')
      return false
    }
    if (isRelayConnected()) {
      lastConnectionError = null
      return true
    }
    markRelayEnabledDisconnected()
    if (_reconnectPending) {
      lastConnectionError = new Error('Reconnect already scheduled')
      log.debug('connectAndAttach: reconnect already scheduled, skip')
      return false
    }
    lastConnectionError = null
    try {
      await ensureConnection()
      if (!isGenerationCurrent(connectGeneration)) {
        lastConnectionError = new Error('Relay disabled while connect was in flight')
        throw lastConnectionError
      }
      log.info('connectAndAttach: connected in', (performance.now() - t0).toFixed(1), 'ms')
      cancelReconnect()
      cancelDisconnectNotify()
      if (!isRelayConnected()) {
        lastConnectionError = new Error('Relay handshake was not ready after connect')
        throw lastConnectionError
      }
      setState(RelayState.CONNECTED)
      try {
        void Promise.resolve(callbacks.onConnected()).catch((err) => {
          log.warn('connectAndAttach: onConnected failed:', err)
        })
      } catch (err) {
        log.warn('connectAndAttach: onConnected failed:', err)
      }
      void clearLocalFailureTracking({ clearErrorReason: RELAY_ERROR_CLEAR_REASON.SUCCESS }).catch((err) => {
        log.warn('connectAndAttach: clear local failure tracking failed:', err)
      })
      return true
    } catch (err) {
      lastConnectionError = err
      log.warn('connectAndAttach: failed in', (performance.now() - t0).toFixed(1), 'ms', err)
      if (!isGenerationCurrent(connectGeneration)) {
        log.debug('connectAndAttach: ignoring stale failure after relay disabled')
        return false
      }
      try {
        if (await handleLocalFailureLimit(err)) return false
      } catch (localFailureErr) {
        log.warn('connectAndAttach: local failure handling failed:', localFailureErr)
      }
      if ((await isRelayEnabled()) && !isRelayConnected()) {
        markRelayEnabledDisconnected()
        scheduleReconnect()
      }
      return false
    }
  })()
  connectAndAttachPromise = currentConnectAndAttachPromise

  try {
    return await currentConnectAndAttachPromise
  } finally {
    clearConnectAndAttachIfCurrent(currentConnectAndAttachPromise)
  }
}

/** Cancel a possibly stale delayed retry and use the current wake-up to reconnect now. */
export function reconnectNow() {
  cancelReconnect()
  return connectAndAttach()
}

/**
 * Disable relay: close WS, cancel timers, set state to disabled.
 *
 * The sync neutralization block (relayWs = null, state = disabled, cancel
 * timers, abort connect) runs BEFORE any await so that snapshots stop
 * reporting usable/connected UI immediately.
 *
 * onShutdown('disabled') handles both group dissolution and tab cleanup
 * atomically — the callback decides internally what to do based on the reason.
 */
export async function disconnect({ preserveRelayError = false } = {}) {
  const t0 = performance.now()
  log.info('disconnect: begin, current state:', _state, 'ws:', relayWs ? 'open' : 'null')

  rejectHandshakeGate(new Error('Relay disabled during handshake'))

  const wsToClose = relayWs
  clearTransportState()

  cancelReconnect()
  cancelDisconnectNotify()
  clearKeepAliveAlarm()

  abortPendingConnectionAttempt()
  disableGeneration++
  setState(RelayState.DISABLED)

  if (wsToClose) {
    log.debug('disconnect: closing WebSocket')
    try { wsToClose.close() } catch { /* ignore */ }
  }

  log.debug('disconnect: awaiting storage write + shutdown...')
  await Promise.all([
    clearLocalFailureTracking({
      clearErrorReason: preserveRelayError ? null : RELAY_ERROR_CLEAR_REASON.USER_DISABLE,
    }).catch((err) => {
      log.warn('disconnect: clear local failure tracking failed:', err)
    }),
    setRelayEnabled(false),
    Promise.resolve(callbacks.onShutdown('disabled')).catch((err) => {
      log.warn('disconnect: onShutdown(disabled) failed:', err)
    }),
  ])

  log.info('disconnect: done in', (performance.now() - t0).toFixed(1), 'ms')
}

export async function toggle() {
  const t0 = performance.now()
  if (await isRelayEnabled()) {
    await disconnect()
    log.info('toggle: disconnect done in', (performance.now() - t0).toFixed(1), 'ms')
    return
  }

  await setRelayEnabled(true)
  await clearRelayError(RELAY_ERROR_CLEAR_REASON.USER_ENABLE).catch((err) => {
    log.warn('toggle: clear previous relay error failed:', err)
  })
  await ensureKeepAliveAlarm()
  setState(RelayState.DISCONNECTED)

  if (!(await reconnectNow())) {
    if (!(await isRelayEnabled())) return
    const message =
      lastConnectionError instanceof Error
        ? lastConnectionError.message
        : String(lastConnectionError ?? 'Relay server is unavailable')
    if (message.includes('cancelled')) return
    log.warn('initial connect failed:', message)
    notifyError('Connection Failed', `${message}\n\nRetrying automatically…`)
  }
}

export async function initFromStorage() {
  if (!(await isRelayEnabled())) return false
  await ensureKeepAliveAlarm()
  if (!isRelayConnected()) markRelayEnabledDisconnected()
  return true
}

/** Reconcile persisted state whenever a new MV3 Service Worker instance starts. */
export async function bootstrapRelayConnection() {
  if (!(await initFromStorage())) return false
  if (isRelayActive()) return isRelayConnected()
  return await connectAndAttach()
}
