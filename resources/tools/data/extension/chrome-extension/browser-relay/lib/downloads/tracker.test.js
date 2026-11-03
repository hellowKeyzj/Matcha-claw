import { beforeEach, describe, expect, test } from 'bun:test'

let createdListener
let changedListener
let downloadItems = []
let sessionStore = {}
let sessionGetImpl
let sessionSetImpl

function setSearchResult(items) {
  downloadItems = items
}

globalThis.chrome = {
  downloads: {
    onCreated: {
      addListener(listener) {
        createdListener = listener
      },
    },
    onChanged: {
      addListener(listener) {
        changedListener = listener
      },
    },
    async search(query) {
      if (typeof query?.id === 'number') {
        return downloadItems.filter((item) => item.id === query.id)
      }
      if (typeof query?.startedAfter === 'string') {
        const after = Date.parse(query.startedAfter)
        return downloadItems.filter((item) => Date.parse(item.startTime) > after)
      }
      return downloadItems
    },
  },
  storage: {
    session: {
      get: (...args) => sessionGetImpl(...args),
      set: (...args) => sessionSetImpl(...args),
    },
  },
}

const { createCommandContext } = await import('../cdp/commands/deadline.js')
const { initDownloadTracker, armDownloadWatch, disarmDownloadWatch } = await import('./tracker.js')

const WATCH_STORE_KEY = 'accioDownloadWatches'

function makeItem(overrides) {
  const startTime = new Date(Date.now()).toISOString()
  return {
    id: 7,
    url: 'https://example.com/report.csv',
    filename: '/downloads/report.csv',
    state: 'complete',
    startTime,
    endTime: new Date(Date.now() + 1000).toISOString(),
    ...overrides,
  }
}

/** 收集本次上报的所有事件；未上报时数组为空。 */
function startTracker() {
  const sent = []
  const tracker = initDownloadTracker((msg) => sent.push(msg))
  return { sent, tracker }
}

function payloadsOf(sent, method) {
  return sent.filter((msg) => msg.params.method === method).map((msg) => msg.params.params)
}

beforeEach(() => {
  createdListener = undefined
  changedListener = undefined
  downloadItems = []
  sessionStore = {}
  sessionGetImpl = async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {})
  sessionSetImpl = async (entries) => {
    Object.assign(sessionStore, entries)
  }
})

async function armNow(watchId, ttlMs = 60_000) {
  await armDownloadWatch({ watchId, sinceTs: Date.now() - 1, expiresAtMs: Date.now() + ttlMs })
}

async function reportComplete(item) {
  setSearchResult([item])
  changedListener({ id: item.id, state: { current: item.state } })
  // onChanged 处理是异步的（search + 归属判定），让微任务队列跑完。
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deadlineContext(requestId, method, timeoutMs = 20) {
  const sentAt = Date.now()
  return createCommandContext({
    requestId,
    method,
    sentAt,
    deadlineAt: sentAt + timeoutMs,
  })
}

describe('download watch ownership', () => {
  test('bounds arm and disarm storage stages by the command deadline', async () => {
    const armParams = {
      watchId: 'watch-a',
      sinceTs: Date.now() - 1,
      expiresAtMs: Date.now() + 60_000,
    }

    sessionGetImpl = () => new Promise(() => {})
    await expect(
      armDownloadWatch(
        armParams,
        deadlineContext(1, 'Extension.armDownloadWatch'),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.storage.session.get:downloadWatch',
    })

    sessionGetImpl = async () => ({})
    sessionSetImpl = () => new Promise(() => {})
    await expect(
      armDownloadWatch(
        armParams,
        deadlineContext(2, 'Extension.armDownloadWatch'),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.storage.session.set:armDownloadWatch',
    })

    sessionStore[WATCH_STORE_KEY] = {
      'watch-a': { sinceTs: Date.now() - 1, expiresAtMs: Date.now() + 60_000 },
    }
    await expect(
      disarmDownloadWatch(
        { watchId: 'watch-a' },
        deadlineContext(3, 'Extension.disarmDownloadWatch'),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.storage.session.set:disarmDownloadWatch',
    })
  })

  test('reports nothing when no watch is armed', async () => {
    const { sent } = startTracker()

    createdListener(makeItem({ state: 'in_progress' }))
    await reportComplete(makeItem())

    expect(sent).toEqual([])
  })

  test('reports created and completed while a watch is armed', async () => {
    const { sent } = startTracker()
    await armNow('watch-a')

    const item = makeItem()
    createdListener(item)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await reportComplete(item)

    expect(payloadsOf(sent, 'Extension.downloadCreated')).toEqual([
      expect.objectContaining({ downloadId: 7, watchIds: ['watch-a'] }),
    ])
    expect(payloadsOf(sent, 'Extension.downloadCompleted')).toEqual([
      expect.objectContaining({
        downloadId: 7,
        watchIds: ['watch-a'],
        filePath: '/downloads/report.csv',
      }),
    ])
  })

  test('never reports the referrer', async () => {
    const { sent } = startTracker()
    await armNow('watch-a')

    await reportComplete(makeItem({ referrer: 'https://internal.example.com/private' }))

    expect(payloadsOf(sent, 'Extension.downloadCompleted')[0]).not.toHaveProperty('referrer')
  })

  test('reports interrupted downloads with the failure reason', async () => {
    const { sent } = startTracker()
    await armNow('watch-a')

    await reportComplete(makeItem({ state: 'interrupted', error: 'NETWORK_FAILED' }))

    expect(payloadsOf(sent, 'Extension.downloadInterrupted')).toEqual([
      expect.objectContaining({ watchIds: ['watch-a'], error: 'NETWORK_FAILED' }),
    ])
  })

  test('stops reporting after the watch is disarmed', async () => {
    const { sent } = startTracker()
    await armNow('watch-a')
    await disarmDownloadWatch({ watchId: 'watch-a' })

    await reportComplete(makeItem())

    expect(sent).toEqual([])
  })

  test('stops reporting after the watch expires', async () => {
    const { sent } = startTracker()
    sessionStore[WATCH_STORE_KEY] = {
      'watch-a': { sinceTs: Date.now() - 5_000, expiresAtMs: Date.now() - 1 },
    }

    await reportComplete(makeItem())

    expect(sent).toEqual([])
  })

  test('ignores downloads that started before the watch was armed', async () => {
    const { sent } = startTracker()
    const armedAt = Date.now()
    await armDownloadWatch({
      watchId: 'watch-a',
      sinceTs: armedAt,
      expiresAtMs: armedAt + 60_000,
    })

    await reportComplete(makeItem({ startTime: new Date(armedAt - 10_000).toISOString() }))

    expect(sent).toEqual([])
  })

  test('keeps the armed watch across a service worker restart', async () => {
    await armNow('watch-a')
    // SW 被回收：模块状态清零，只剩 chrome.storage.session。
    const { sent } = startTracker()

    await reportComplete(makeItem())

    expect(payloadsOf(sent, 'Extension.downloadCompleted')).toHaveLength(1)
  })

  test('flags downloads that fall into two concurrent watches', async () => {
    const { sent } = startTracker()
    await armNow('watch-a')
    await armNow('watch-b')

    await reportComplete(makeItem())

    expect(payloadsOf(sent, 'Extension.downloadCompleted')[0].watchIds).toEqual([
      'watch-a',
      'watch-b',
    ])
  })

  test('rejects an arm request that is missing its window bounds', async () => {
    await expect(armDownloadWatch({ watchId: 'watch-a' })).rejects.toThrow('armDownloadWatch')
    await expect(
      armDownloadWatch({ watchId: 'watch-a', sinceTs: Date.now(), expiresAtMs: Date.now() - 1 }),
    ).rejects.toThrow('already in the past')
  })
})

describe('download terminal state resync', () => {
  test('replays terminal states inside an armed window after reconnect', async () => {
    const { sent, tracker } = startTracker()
    await armNow('watch-a')
    // 断线期间 Chrome 发出的终态：发送失败，事件没有排队。
    setSearchResult([makeItem(), makeItem({ id: 8, state: 'in_progress' })])

    await tracker.resyncDownloads()

    expect(payloadsOf(sent, 'Extension.downloadCompleted')).toEqual([
      expect.objectContaining({ downloadId: 7, watchIds: ['watch-a'] }),
    ])
  })

  test('replays nothing when no watch is armed', async () => {
    const { sent, tracker } = startTracker()
    setSearchResult([makeItem()])

    await tracker.resyncDownloads()

    expect(sent).toEqual([])
  })

  test('replays nothing for downloads outside the armed window', async () => {
    const { sent, tracker } = startTracker()
    const armedAt = Date.now()
    await armDownloadWatch({
      watchId: 'watch-a',
      sinceTs: armedAt,
      expiresAtMs: armedAt + 60_000,
    })
    setSearchResult([makeItem({ startTime: new Date(armedAt - 30_000).toISOString() })])

    await tracker.resyncDownloads()

    expect(sent).toEqual([])
  })
})

describe('download tracker completion payload', () => {
  async function completedPayload(fileSize) {
    const { sent } = startTracker()
    await armNow('watch-a')
    await reportComplete(makeItem(fileSize === undefined ? {} : { fileSize }))
    return payloadsOf(sent, 'Extension.downloadCompleted')[0]
  }

  test('reports a known positive file size', async () => {
    expect(await completedPayload(42)).toEqual(expect.objectContaining({ fileSizeBytes: 42 }))
  })

  test('preserves zero as a known empty-file size', async () => {
    expect(await completedPayload(0)).toEqual(expect.objectContaining({ fileSizeBytes: 0 }))
  })

  test('omits fileSizeBytes when Chrome reports an unknown size', async () => {
    expect(await completedPayload(-1)).not.toHaveProperty('fileSizeBytes')
  })
})
