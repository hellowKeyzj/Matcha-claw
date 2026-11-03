/**
 * Download Tracker — chrome.downloads → relay 事件桥。
 *
 * chrome.downloads 是浏览器全局的，且不暴露发起下载的 tab，无法按 tab 归属。
 * 因此采用 deny-by-default：只有 relay 在发起 RPA 下载前 arm 了归属窗口
 * (Extension.armDownloadWatch)，且下载的 startTime 落在该窗口内时才上报。
 * 没有 armed watch 时一条都不发，用户自己的下载不会离开浏览器。
 *
 * 上报事件：
 *   Extension.downloadCreated     — 下载开始（含 url/mime/startTimeMs）
 *   Extension.downloadCompleted   — 下载完成（含磁盘绝对路径 filePath/fileSizeBytes）
 *   Extension.downloadInterrupted — 下载失败/取消（含 error 原因）
 *
 * 每条事件带 watchIds(命中的归属窗口)，relay 据此把下载归属到具体的 RPA 操作，
 * 并在 disarm 时清理记录。命中多个窗口时由 relay 侧判定为归属不明确。
 *
 * 投递保证：WS 断开时同步发送会失败，事件不排队。重连后由 resyncDownloads()
 * 用 chrome.downloads.search 重新扫描 armed 窗口内的终态并补发 —— Chrome 的下载库
 * 本身就是账本，不需要另建 journal。relay 侧按 downloadId upsert，补发是幂等的。
 */

import { createLogger } from '../logger.js'
import { awaitWithDeadline } from '../cdp/commands/deadline.js'

const log = createLogger('downloads')

function awaitOperation(commandContext, stage, operation) {
  return commandContext
    ? awaitWithDeadline(commandContext, stage, operation)
    : operation()
}

// armed watch 存 chrome.storage.session：arm 与下载终态之间 MV3 SW 可能被回收，
// 模块变量会丢；session 存储随浏览器会话存活且不落盘。
const WATCH_STORE_KEY = 'matchaDownloadWatches'
const WATCH_MAX_TTL_MS = 10 * 60 * 1000
let watchStoreChain = Promise.resolve()

async function withWatchStore(commandContext, operation) {
  const previous = watchStoreChain
  let release
  const settlement = new Promise((resolve) => { release = resolve })
  watchStoreChain = previous.then(() => settlement)
  let nativeWrite
  try {
    await awaitOperation(commandContext, 'downloadWatch.storageQueue', () => previous)
    return await operation((stage, watches) => awaitOperation(commandContext, stage, () => {
      nativeWrite = Promise.resolve().then(() => chrome.storage.session.set({ [WATCH_STORE_KEY]: watches }))
      return nativeWrite
    }))
  } finally {
    // Command timeout does not cancel Chrome's write; later RMW must wait for it.
    if (nativeWrite) void nativeWrite.then(release, release)
    else release()
  }
}

function getActiveWatches(commandContext) {
  return withWatchStore(commandContext, () => readActiveWatches(Date.now(), commandContext))
}

function clearDownloadWatches() {
  return withWatchStore(undefined, (write) => write('chrome.storage.session.set:clearDownloadWatches', {}))
}

function parseTimeMs(value) {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function downloadStartTimeMs(item) {
  return parseTimeMs(item.startTime) ?? NaN
}

/** 读 armed watch，剔除已过期项。返回 { [watchId]: { sinceTs, expiresAtMs } }。 */
async function readActiveWatches(nowMs, commandContext) {
  const stored = await awaitOperation(
    commandContext,
    'chrome.storage.session.get:downloadWatch',
    () => chrome.storage.session.get(WATCH_STORE_KEY),
  )
  const watches = stored?.[WATCH_STORE_KEY]
  if (!watches || typeof watches !== 'object') return {}
  const active = {}
  for (const [watchId, watch] of Object.entries(watches)) {
    if (
      watch
      && Number.isFinite(watch.sinceTs)
      && Number.isFinite(watch.expiresAtMs)
      && watch.sinceTs <= watch.expiresAtMs
      && watch.expiresAtMs > nowMs
      && watch.expiresAtMs <= nowMs + WATCH_MAX_TTL_MS
    ) {
      active[watchId] = watch
    }
  }
  return active
}

/** 命中 startTimeMs 的浏览器全局时间窗，不代表 tab 归属。 */
function matchWatchIds(startTimeMs, active) {
  return Object.entries(active)
    .filter(([, watch]) => startTimeMs >= watch.sinceTs && startTimeMs <= watch.expiresAtMs)
    .map(([watchId]) => watchId)
}

/**
 * 开启一个下载归属窗口。由 relay 在点击下载触发元素前调用。
 * @param {{ watchId: string, sinceTs: number, expiresAtMs: number }} params
 */
export async function armDownloadWatch(params, commandContext) {
  const watchId = typeof params?.watchId === 'string' ? params.watchId : ''
  const sinceTs = params?.sinceTs
  const requestedExpiry = params?.expiresAtMs
  if (!watchId || !Number.isFinite(sinceTs) || !Number.isFinite(requestedExpiry)) {
    throw new Error('armDownloadWatch requires watchId, sinceTs and expiresAtMs')
  }
  return withWatchStore(commandContext, async (write) => {
    const watches = await readActiveWatches(Date.now(), commandContext)
    const now = Date.now()
    const expiresAtMs = Math.min(requestedExpiry, now + WATCH_MAX_TTL_MS)
    if (expiresAtMs <= now) {
      throw new Error('armDownloadWatch expiresAtMs is already in the past')
    }
    if (sinceTs > expiresAtMs) throw new Error('armDownloadWatch requires sinceTs <= expiresAtMs')
    if (Object.keys(watches).some((id) => id !== watchId)) {
      throw new Error('Another download watch is already active in this browser')
    }
    watches[watchId] = { sinceTs, expiresAtMs }
    await write('chrome.storage.session.set:armDownloadWatch', watches)
    log.info('download watch armed:', watchId, 'expires in', expiresAtMs - now, 'ms')
    return { armed: true, watchId, expiresAtMs }
  })
}

/** 关闭归属窗口。relay 在下载操作结束(成功/失败/超时)后调用。 */
export async function disarmDownloadWatch(params, commandContext) {
  const watchId = typeof params?.watchId === 'string' ? params.watchId : ''
  if (!watchId) throw new Error('disarmDownloadWatch requires watchId')
  return withWatchStore(commandContext, async (write) => {
    const watches = await readActiveWatches(Date.now(), commandContext)
    delete watches[watchId]
    await write('chrome.storage.session.set:disarmDownloadWatch', watches)
    log.info('download watch disarmed:', watchId)
    return { disarmed: true, watchId }
  })
}

/** 对显式 http(s) URL 发起浏览器下载；归属仍须调用方预先 arm。 */
export async function startDownload(params, commandContext) {
  const url = typeof params?.url === 'string' ? params.url : ''
  if (!url) throw new Error('startDownload requires a url string')
  if (params.saveAs !== undefined && typeof params.saveAs !== 'boolean') {
    throw new TypeError('startDownload saveAs must be a boolean')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('startDownload url must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`startDownload only supports http and https URLs, got ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('startDownload rejects URLs with embedded credentials')
  }

  const downloadId = await awaitOperation(
    commandContext,
    'chrome.downloads.download:startDownload',
    () => chrome.downloads.download({ url, saveAs: params.saveAs ?? false, conflictAction: 'uniquify' }),
  )
  return { downloadId }
}

/** Chrome 不通过 onChanged 上报字节进度；查询仅返回本次 armed 时间窗。 */
export async function queryDownloadWatch(params, commandContext) {
  const watchId = typeof params?.watchId === 'string' ? params.watchId : ''
  const watches = await getActiveWatches(commandContext)
  const watch = watches[watchId]
  if (!watch) return { records: [] }
  const items = await awaitOperation(commandContext, 'chrome.downloads.search:downloadWatch', () =>
    chrome.downloads.search({ startedAfter: new Date(watch.sinceTs).toISOString(), limit: 50 }))
  const records = []
  for (const item of items) {
    const startTimeMs = downloadStartTimeMs(item)
    const watchIds = matchWatchIds(startTimeMs, watches)
    if (!watchIds.includes(watchId)) continue
    const state = item.state === 'complete' ? 'completed' : item.state === 'interrupted' ? 'interrupted' : 'created'
    records.push({
      downloadId: item.id,
      watchIds,
      url: item.finalUrl || item.url || '',
      startTimeMs,
      state,
      awaitingFilename: state === 'created' && !item.filename,
      receivedBytes: item.bytesReceived,
      totalBytes: item.totalBytes,
      ...(state === 'completed' ? {
        filePath: item.filename,
        fileSizeBytes: item.fileSize,
        endTimeMs: parseTimeMs(item.endTime) ?? Date.now(),
      } : {}),
      ...(item.error ? { error: item.error } : {}),
    })
  }
  return { records }
}

/**
 * 注册 chrome.downloads 监听。必须在 SW 顶层同步调用（MV3 事件唤醒约束）。
 * @param {(msg: object) => void} sendToRelay 与 TabManager 相同的 relay 发送函数
 * @returns {{ resyncDownloads: () => Promise<void>, clearDownloadWatches: () => Promise<void> }}
 */
export function initDownloadTracker(sendToRelay) {
  if (!chrome.downloads?.onCreated) {
    log.warn('chrome.downloads unavailable — downloads permission missing?')
    return { resyncDownloads: async () => {}, clearDownloadWatches }
  }

  const emit = (method, params) => {
    try {
      sendToRelay({ method: 'forwardCDPEvent', params: { method, params } })
    } catch (error) {
      // 不排队；重连后仍从 Chrome 下载账本恢复。
      log.warn('emit failed:', method, error)
    }
  }

  const baseEventPayload = (item, watchIds, startTimeMs) => ({
    downloadId: item.id,
    watchIds,
    url: item.finalUrl || item.url || '',
    mime: item.mime || undefined,
    startTimeMs,
  })

  const emitCreated = (item, active) => {
    const startTimeMs = downloadStartTimeMs(item)
    const watchIds = matchWatchIds(startTimeMs, active)
    if (watchIds.length === 0) return
    log.info('download created:', item.id, item.finalUrl || item.url)
    emit('Extension.downloadCreated', {
      ...baseEventPayload(item, watchIds, startTimeMs),
      awaitingFilename: !item.filename,
      receivedBytes: item.bytesReceived,
      totalBytes: item.totalBytes,
    })
  }

  const emitTerminal = (item, active) => {
    const startTimeMs = downloadStartTimeMs(item)
    const watchIds = matchWatchIds(startTimeMs, active)
    if (watchIds.length === 0) return
    const base = baseEventPayload(item, watchIds, startTimeMs)

    if (item.state === 'complete') {
      log.info('download completed:', item.id, item.filename)
      const fileSizeBytes =
        Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : undefined
      emit('Extension.downloadCompleted', {
        ...base,
        endTimeMs: parseTimeMs(item.endTime) ?? Date.now(),
        filePath: item.filename || '',
        ...(fileSizeBytes === undefined ? {} : { fileSizeBytes }),
      })
    } else if (item.state === 'interrupted') {
      log.info('download interrupted:', item.id, item.error)
      emit('Extension.downloadInterrupted', { ...base, error: item.error || 'unknown' })
    }
  }

  let resyncPromise
  let resyncRequested = false

  // Chrome is the ledger. Announce all matches before any completion can settle a waiter.
  const resyncDownloads = () => {
    resyncRequested = true
    if (resyncPromise) return resyncPromise
    resyncPromise = (async () => {
      try {
        do {
          resyncRequested = false
          const windows = Object.values(await getActiveWatches())
          if (windows.length > 0) {
            const earliestSinceTs = Math.min(...windows.map((watch) => watch.sinceTs))
            const items = await chrome.downloads.search({
              startedAfter: new Date(earliestSinceTs - 1).toISOString(),
            })
            const active = await getActiveWatches()
            for (const item of items) emitCreated(item, active)
            for (const item of items) emitTerminal(item, active)
          }
        } while (resyncRequested)
      } finally {
        resyncPromise = undefined
      }
    })()
    return resyncPromise
  }

  const scheduleResync = () => {
    void resyncDownloads().catch((error) => log.warn('download resync failed:', error))
  }
  chrome.downloads.onCreated.addListener(scheduleResync)
  chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current
    if (state === 'complete' || state === 'interrupted') scheduleResync()
  })

  log.info('download tracker initialized')
  return { resyncDownloads, clearDownloadWatches }
}
