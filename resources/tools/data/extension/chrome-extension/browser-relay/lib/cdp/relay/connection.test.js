import { afterAll, describe, expect, test } from 'bun:test'

import { decryptMessage } from '../../crypto.js'
import { CommandDeadlineExceededError } from '../commands/deadline.js'

let importId = 0
let helloAckMode = 'auto-ok'
const realCrypto = globalThis.crypto
const realChrome = globalThis.chrome
const realWebSocket = globalThis.WebSocket
const realFetch = globalThis.fetch
const LOCAL_FAILURE_DISABLE_THRESHOLD = 3

// loadConnection replaces browser globals for every test; restore them so the
// file cannot leak its fakes into other suites in the same bun process (P2-A).
afterAll(() => {
  globalThis.chrome = realChrome
  globalThis.crypto = realCrypto
  globalThis.WebSocket = realWebSocket
  globalThis.fetch = realFetch
})

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  static instances = []

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(raw) {
    this.sent.push(raw)
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.method !== 'Extension.hello') return
    if (helloAckMode === 'manual') return
    queueMicrotask(() => {
      this.serverAck(
        helloAckMode === 'reject'
          ? { status: 'version_mismatch' }
          : { status: 'ok', encrypted: true },
      )
    })
  }

  serverAck(params) {
    this.serverMessage({
      method: 'Extension.helloAck',
      params,
    })
  }

  serverMessage(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.())
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for test condition')
}

async function settleAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function decodeSentMessage(raw) {
  return JSON.parse(await decryptMessage(raw))
}

function createDeferred() {
  /** @type {(value?: any) => void} */
  let resolve = () => {}
  /** @type {(reason?: any) => void} */
  let reject = () => {}
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function createCryptoOverride(onAesEncrypt) {
  const realEncrypt = realCrypto.subtle.encrypt.bind(realCrypto.subtle)
  let aesEncryptCalls = 0
  return {
    crypto: {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: realCrypto.subtle.generateKey.bind(realCrypto.subtle),
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: async (...args) => {
          if (args[0]?.name === 'AES-GCM') await onAesEncrypt(++aesEncryptCalls)
          return await realEncrypt(...args)
        },
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    },
    aesEncryptCalls: () => aesEncryptCalls,
  }
}

async function loadConnection({
  enabled = true,
  relayReachable = true,
  ackMode = 'auto-ok',
  cryptoOverride = realCrypto,
  fetchImpl = null,
  installDebuggerListeners = () => {},
  initialStorage = null,
  storageGetImpl = null,
  storageRemoveImpl = null,
  storageSetImpl = null,
  onMessage = async () => null,
  onShutdown = () => {},
  userAgent = 'Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36',
} = {}) {
  const storage = initialStorage || { relayEnabled: enabled, controlPort: 9240 }
  const alarms = new Map()
  const alarmCreates = []
  const notifications = []
  let reachable = relayReachable
  helloAckMode = ackMode

  globalThis.chrome = {
    action: {
      setBadgeText: async () => {},
      setIcon: async () => {},
      setTitle: async () => {},
    },
    alarms: {
      async get(name) {
        return alarms.get(name)
      },
      create(name, info) {
        alarmCreates.push({ name, info })
        alarms.set(name, { name, ...info })
      },
      async clear(name) {
        return alarms.delete(name)
      },
    },
    notifications: {
      create(id, options, callback) {
        notifications.push({ id, options })
        callback?.()
      },
    },
    runtime: {
      getManifest: () => ({ version: '0.2.3' }),
      getURL: (path) => `chrome-extension://test/${path}`,
      lastError: null,
      reload: () => {},
    },
    storage: {
      local: {
        async get(keys) {
          if (storageGetImpl) return await storageGetImpl(keys, storage)
          return Object.fromEntries(
            keys.filter((key) => key in storage).map((key) => [key, storage[key]]),
          )
        },
        async remove(keys) {
          if (storageRemoveImpl) return await storageRemoveImpl(keys, storage)
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]
        },
        async set(values) {
          if (storageSetImpl) return await storageSetImpl(values, storage)
          Object.assign(storage, values)
        },
      },
    },
  }

  FakeWebSocket.instances = []
  globalThis.crypto = cryptoOverride
  globalThis.WebSocket = FakeWebSocket
  globalThis.fetch = async (input) => {
    if (fetchImpl) return await fetchImpl(input)
    if (!String(input).startsWith('http://127.0.0.1:')) {
      throw new Error('Icon loading is not available in this test')
    }
    if (!reachable) throw new Error('ECONNREFUSED')
    return { ok: true }
  }

  const previousNavigator = globalThis.navigator
  let connection
  try {
    globalThis.navigator = { userAgent }
    connection = await import(`./connection.js?test=${importId++}`)
  } finally {
    globalThis.navigator = previousNavigator
  }
  let connectedCallbacks = 0
  connection.initRelay({
    onMessage,
    onConnected: () => {
      connectedCallbacks++
    },
    onShutdown,
    installDebuggerListeners,
  })

  return {
    alarmCreates,
    alarms,
    connection,
    notifications,
    storage,
    connectedCallbacks: () => connectedCallbacks,
    setRelayReachable(value) {
      reachable = value
    },
  }
}

describe('relay connection recovery', () => {
  test('reports the cached Chrome major in Extension.hello', async () => {
    const { connection } = await loadConnection({
      userAgent: 'Mozilla/5.0 Chrome/108.0.5359.125 Safari/537.36',
    })

    await connection.bootstrapRelayConnection()
    const hello = FakeWebSocket.instances[0].sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.method === 'Extension.hello')

    expect(hello.params.chromeMajorVersion).toBe(108)
    FakeWebSocket.instances[0].close()
    await settleAsyncWork()
    await connection.reconnectNow()
    const reconnectedHello = FakeWebSocket.instances[1].sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.method === 'Extension.hello')
    expect(reconnectedHello.params.chromeMajorVersion).toBe(108)
  })

  test('omits Chrome major when the runtime user agent is not Chrome', async () => {
    const { connection } = await loadConnection({ userAgent: 'Bun/1.3.14' })

    await connection.bootstrapRelayConnection()
    const hello = FakeWebSocket.instances[0].sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.method === 'Extension.hello')

    expect(hello.params).not.toHaveProperty('chromeMajorVersion')
  })

  test('does not replace an existing keep-alive alarm', async () => {
    const { alarmCreates, connection } = await loadConnection()

    await connection.ensureKeepAliveAlarm()
    await connection.ensureKeepAliveAlarm()

    expect(alarmCreates).toEqual([{ name: 'relayKeepAlive', info: { periodInMinutes: 0.5 } }])
  })

  test('connects immediately when an enabled worker instance boots', async () => {
    const { connection, connectedCallbacks } = await loadConnection()

    expect(await connection.bootstrapRelayConnection()).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)
    expect(connectedCallbacks()).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(1)

    expect(await connection.bootstrapRelayConnection()).toBe(true)
    expect(connectedCallbacks()).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(1)

    await connection.disconnect()
  })

  test('does not let success cleanup failure block connected callbacks', async () => {
    const { connection, connectedCallbacks } = await loadConnection({
      storageRemoveImpl: async () => {
        throw new Error('storage remove failed')
      },
    })

    expect(await connection.connectAndAttach()).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)
    expect(connectedCallbacks()).toBe(1)

    await settleAsyncWork()
    await connection.disconnect()
  })

  test('does not connect when relay is disabled', async () => {
    const { alarmCreates, connection, connectedCallbacks } = await loadConnection({
      enabled: false,
    })

    expect(await connection.bootstrapRelayConnection()).toBe(false)
    expect(connection.isRelayConnected()).toBe(false)
    expect(connectedCallbacks()).toBe(0)
    expect(alarmCreates).toHaveLength(0)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  test('runs connection success callbacks once for concurrent callers', async () => {
    const { connection, connectedCallbacks } = await loadConnection()

    expect(
      await Promise.all([connection.connectAndAttach(), connection.connectAndAttach()]),
    ).toEqual([true, true])
    expect(connectedCallbacks()).toBe(1)

    await connection.initFromStorage()
    expect(connection.getRelayState()).toBe('connected')

    await connection.disconnect()
  })

  test('uses a watchdog wake-up even when a delayed reconnect is pending', async () => {
    const { alarms, connection, setRelayReachable } = await loadConnection({
      relayReachable: false,
    })

    expect(await connection.connectAndAttach()).toBe(false)
    expect(alarms.has('relayReconnect')).toBe(true)
    expect(await connection.hasPendingReconnectAlarm()).toBe(true)
    expect(alarms.get('relayReconnect')?.delayInMinutes).toBe(0.5)
    expect(connection.getRelayState()).toBe('disconnected')

    setRelayReachable(true)
    expect(await connection.reconnectNow()).toBe(true)
    expect(alarms.has('relayReconnect')).toBe(false)
    expect(connection.isRelayConnected()).toBe(true)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: true,
      reconnecting: false,
    })

    await connection.disconnect()
  })

  test('retries on a flat alarm-floor cadence without backing off', async () => {
    const { alarmCreates, connection } = await loadConnection({ relayReachable: false })

    expect(await connection.connectAndAttach()).toBe(false)
    for (let i = 0; i < 4; i++) {
      expect(await connection.reconnectNow()).toBe(false)
    }

    const reconnects = alarmCreates.filter((entry) => entry.name === 'relayReconnect')
    expect(reconnects).toHaveLength(5)
    expect(reconnects.every((entry) => entry.info.delayInMinutes === 0.5)).toBe(true)
  })

  test('retries a rejected handshake on the same flat cadence', async () => {
    const { alarms, connection } = await loadConnection({ ackMode: 'reject' })

    expect(await connection.connectAndAttach()).toBe(false)

    expect(alarms.get('relayReconnect')?.delayInMinutes).toBe(0.5)
  })

  test('delays disconnect notification until after the first reconnect window', async () => {
    const { alarms, connection } = await loadConnection()

    expect(await connection.connectAndAttach()).toBe(true)

    FakeWebSocket.instances[0].close()
    await waitFor(() => alarms.has('relayReconnect') && alarms.has('relayDisconnectNotify'))

    expect(alarms.get('relayReconnect')?.delayInMinutes).toBeGreaterThanOrEqual(0.5)
    expect(alarms.get('relayDisconnectNotify')?.delayInMinutes).toBe(1)
    expect(alarms.get('relayDisconnectNotify')?.delayInMinutes).toBeGreaterThan(
      alarms.get('relayReconnect')?.delayInMinutes || 0,
    )

    await connection.disconnect()
  })

  test('does not let stale close cleanup rewrite disabled state', async () => {
    const closeStarted = createDeferred()
    const relayEnabledRead = createDeferred()
    const disableWrite = createDeferred()
    let blockCloseEnabledRead = false
    let closeEnabledReadBlocked = false
    const { alarms, connection, storage } = await loadConnection({
      onShutdown: (reason) => {
        if (reason === 'connectionLost') {
          blockCloseEnabledRead = true
          closeStarted.resolve()
        }
      },
      storageGetImpl: async (keys, targetStorage) => {
        const requestedKeys = Array.isArray(keys) ? keys : [keys]
        if (
          blockCloseEnabledRead &&
          requestedKeys.includes('relayEnabled') &&
          !closeEnabledReadBlocked
        ) {
          closeEnabledReadBlocked = true
          await relayEnabledRead.promise
        }
        return Object.fromEntries(
          requestedKeys
            .filter((key) => key in targetStorage)
            .map((key) => [key, targetStorage[key]]),
        )
      },
      storageSetImpl: async (values, targetStorage) => {
        if (values.relayEnabled === false) await disableWrite.promise
        Object.assign(targetStorage, values)
      },
    })

    expect(await connection.connectAndAttach()).toBe(true)

    FakeWebSocket.instances[0].close()
    await closeStarted.promise
    expect(closeEnabledReadBlocked).toBe(true)

    const disconnectPromise = connection.disconnect()
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })

    relayEnabledRead.resolve()
    await settleAsyncWork()

    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })
    expect(storage._relayState).toBe('disabled')
    expect(alarms.has('relayReconnect')).toBe(false)

    disableWrite.resolve()
    await disconnectPromise
    expect(storage.relayEnabled).toBe(false)
  })

  test('does not let stale close cleanup rewrite a freshly reconnected transport', async () => {
    const closeStarted = createDeferred()
    const closeEnabledRead = createDeferred()
    let blockCloseEnabledRead = false
    let closeEnabledReadBlocked = false
    const { alarms, connection } = await loadConnection({
      onShutdown: (reason) => {
        if (reason === 'connectionLost') {
          blockCloseEnabledRead = true
          closeStarted.resolve()
        }
      },
      storageGetImpl: async (keys, targetStorage) => {
        const requestedKeys = Array.isArray(keys) ? keys : [keys]
        if (
          blockCloseEnabledRead &&
          requestedKeys.includes('relayEnabled') &&
          !closeEnabledReadBlocked
        ) {
          closeEnabledReadBlocked = true
          await closeEnabledRead.promise
        }
        return Object.fromEntries(
          requestedKeys
            .filter((key) => key in targetStorage)
            .map((key) => [key, targetStorage[key]]),
        )
      },
    })

    expect(await connection.connectAndAttach()).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)

    // Drop the live socket; its close continuation parks on the gated
    // relayEnabled read, standing in for a slow storage read in production.
    FakeWebSocket.instances[0].close()
    await closeStarted.promise
    expect(closeEnabledReadBlocked).toBe(true)

    // A newer transport reconnects and completes its handshake while that stale
    // continuation is still parked. Its relayEnabled reads pass the gate.
    expect(await connection.connectAndAttach()).toBe(true)
    expect(connection.getRelayState()).toBe('connected')

    // Releasing the stale continuation must not clobber the live connection —
    // without the transport-generation guard it would write disconnected here.
    closeEnabledRead.resolve()
    await settleAsyncWork()

    expect(connection.getRelayState()).toBe('connected')
    expect(connection.isRelayConnected()).toBe(true)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: true,
      reconnecting: false,
    })
    expect(alarms.has('relayDisconnectNotify')).toBe(false)

    await connection.disconnect()
  })

  test('toggle uses persisted enabled intent rather than the UI state mirror', async () => {
    const { connection, storage } = await loadConnection({ enabled: true })

    await connection.toggle()

    expect(storage.relayEnabled).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      active: false,
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  test('starts a fresh attempt immediately after disconnecting an in-flight connect', async () => {
    const firstPreflight = createDeferred()
    const fetchCalls = []
    const { connection } = await loadConnection({
      ackMode: 'manual',
      fetchImpl: async (input) => {
        const url = String(input)
        if (!url.startsWith('http://127.0.0.1:')) return { ok: true }
        fetchCalls.push(url)
        if (fetchCalls.length === 1) return await firstPreflight.promise
        return { ok: true }
      },
    })

    const firstConnect = connection.connectAndAttach()
    await waitFor(() => fetchCalls.length === 1)

    await connection.disconnect()
    await connection.setRelayEnabled(true)

    const secondConnect = connection.connectAndAttach()
    await waitFor(() => fetchCalls.length === 2)

    const secondWs = FakeWebSocket.instances[0]
    secondWs.serverAck({ status: 'ok', encrypted: true })
    expect(await secondConnect).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)

    firstPreflight.reject(new Error('aborted late'))
    expect(await firstConnect).toBe(false)

    await connection.disconnect()
  })

  test('does not let a stale in-flight connect rewrite disabled state', async () => {
    const firstPreflight = createDeferred()
    const disableWrite = createDeferred()
    const fetchCalls = []
    const { alarms, connection, storage } = await loadConnection({
      ackMode: 'manual',
      fetchImpl: async (input) => {
        const url = String(input)
        if (!url.startsWith('http://127.0.0.1:')) return { ok: true }
        fetchCalls.push(url)
        return await firstPreflight.promise
      },
      storageSetImpl: async (values, targetStorage) => {
        if (values.relayEnabled === false) await disableWrite.promise
        Object.assign(targetStorage, values)
      },
    })

    const connectPromise = connection.connectAndAttach()
    await waitFor(() => fetchCalls.length === 1)

    const disconnectPromise = connection.disconnect()
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })

    firstPreflight.reject(new Error('aborted late'))
    expect(await connectPromise).toBe(false)
    await settleAsyncWork()

    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })
    expect(storage._relayState).toBe('disabled')
    expect(alarms.has('relayReconnect')).toBe(false)

    disableWrite.resolve()
    await disconnectPromise
    expect(storage.relayEnabled).toBe(false)
  })

  test('reports a local session-key failure without mislabeling server encryption support', async () => {
    const failingCrypto = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: async () => {
          throw new Error('generateKey failed')
        },
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: realCrypto.subtle.encrypt.bind(realCrypto.subtle),
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    }
    const { connection, storage } = await loadConnection({ cryptoOverride: failingCrypto })

    expect(await connection.connectAndAttach()).toBe(false)
    expect(storage._relayError).toBe('session_key_failed')
    expect(storage._relayErrorSeverity).toBe('retrying')
    expect(storage.relayLocalFailureState).toMatchObject({
      code: 'session_key_failed',
      count: 1,
    })
    expect(connection.isRelayConnected()).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disconnected',
      connected: false,
      handshakeReady: false,
    })

    await connection.disconnect()
  })

  test('disables relay after repeated session-key failures and keeps the local error', async () => {
    const failingCrypto = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: async () => {
          throw new Error('generateKey failed')
        },
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: realCrypto.subtle.encrypt.bind(realCrypto.subtle),
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    }
    const { connection, notifications, storage } = await loadConnection({ cryptoOverride: failingCrypto })

    for (let i = 0; i < LOCAL_FAILURE_DISABLE_THRESHOLD; i++) {
      expect(await connection.reconnectNow()).toBe(false)
    }

    expect(storage.relayEnabled).toBe(false)
    expect(storage._relayError).toBe('session_key_failed')
    expect(storage._relayErrorSeverity).toBe('terminal')
    expect(storage.relayLocalFailureState).toBeUndefined()
    expect(notifications.at(-1)?.options).toMatchObject({
      title: 'Accio Relay: Relay Disabled',
    })
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })
  })

  test('counts repeated local failures across service worker restarts', async () => {
    const failingCrypto = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: async () => {
          throw new Error('generateKey failed')
        },
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: realCrypto.subtle.encrypt.bind(realCrypto.subtle),
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    }
    const sharedStorage = { relayEnabled: true, controlPort: 9240 }

    for (let i = 0; i < LOCAL_FAILURE_DISABLE_THRESHOLD; i++) {
      const { connection } = await loadConnection({
        cryptoOverride: failingCrypto,
        initialStorage: sharedStorage,
      })
      expect(await connection.reconnectNow()).toBe(false)
    }

    expect(sharedStorage.relayEnabled).toBe(false)
    expect(sharedStorage._relayError).toBe('session_key_failed')
    expect(sharedStorage._relayErrorSeverity).toBe('terminal')
    expect(sharedStorage.relayLocalFailureState).toBeUndefined()
  })

  test('clears stale local relay errors when the next failure has a different cause', async () => {
    const failingCrypto = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: async () => {
          throw new Error('generateKey failed')
        },
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: realCrypto.subtle.encrypt.bind(realCrypto.subtle),
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    }
    const { connection, setRelayReachable, storage } = await loadConnection({
      cryptoOverride: failingCrypto,
    })

    expect(await connection.connectAndAttach()).toBe(false)
    expect(storage._relayError).toBe('session_key_failed')

    globalThis.crypto = realCrypto
    setRelayReachable(false)

    expect(await connection.reconnectNow()).toBe(false)

    expect(storage._relayError).toBeUndefined()
    expect(storage._relayErrorSeverity).toBeUndefined()
    expect(storage.relayLocalFailureState).toBeUndefined()
  })
})

describe('relay connected semantics', () => {
  test('sends pong without waiting for queued business encryption', async () => {
    const releaseBusinessEncryption = createDeferred()
    const realEncrypt = realCrypto.subtle.encrypt.bind(realCrypto.subtle)
    let aesEncryptCalls = 0
    const blockingCrypto = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: realCrypto.subtle.importKey.bind(realCrypto.subtle),
        generateKey: realCrypto.subtle.generateKey.bind(realCrypto.subtle),
        exportKey: realCrypto.subtle.exportKey.bind(realCrypto.subtle),
        encrypt: async (...args) => {
          if (args[0]?.name === 'AES-GCM') {
            aesEncryptCalls++
            if (aesEncryptCalls === 1) await releaseBusinessEncryption.promise
          }
          return await realEncrypt(...args)
        },
        decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
      },
    }
    const { connection } = await loadConnection({ cryptoOverride: blockingCrypto })

    expect(await connection.connectAndAttach()).toBe(true)
    const ws = FakeWebSocket.instances[0]
    const sentAfterHandshake = ws.sent.length

    connection.sendToRelay({ method: 'forwardCDPEvent', params: { method: 'test' } })
    await waitFor(() => aesEncryptCalls === 1)

    ws.serverMessage({ method: 'ping' })
    await waitFor(() => aesEncryptCalls === 2)
    await waitFor(() => ws.sent.length === sentAfterHandshake + 1)

    expect(ws.sent.at(-1)?.startsWith('E:')).toBe(true)
    expect(connection.getLogBuffer().at(-1)?.method).toBe('pong')

    releaseBusinessEncryption.resolve()
    await waitFor(() => ws.sent.length === sentAfterHandshake + 2)
    await connection.disconnect()
  })

  test('logs and sends a structured deadline response outside the business send chain', async () => {
    const releaseBusinessEncryption = createDeferred()
    const cryptoOverride = createCryptoOverride(async (call) => {
      if (call === 1) await releaseBusinessEncryption.promise
    })
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    const { connection } = await loadConnection({
      cryptoOverride: cryptoOverride.crypto,
      onMessage: async (_msg, commandContext) => {
        throw new CommandDeadlineExceededError({
          context: commandContext,
          stage: 'chrome.debugger.sendCommand:Runtime.evaluate',
          operationElapsedMs: 10_000,
          timeoutSource: 'operation_limit',
        })
      },
    })

    try {
      expect(await connection.connectAndAttach()).toBe(true)
      const ws = FakeWebSocket.instances[0]
      const sentAfterHandshake = ws.sent.length
      connection.sendToRelay({ method: 'forwardCDPEvent', params: { method: 'test' } })
      await waitFor(() => cryptoOverride.aesEncryptCalls() === 1)

      const sentAt = Date.now()
      ws.serverMessage({
        id: 102,
        ts: sentAt,
        method: 'forwardCDPCommand',
        params: {
          method: 'Runtime.evaluate',
          deadlineAt: sentAt + 30_000,
        },
      })

      await waitFor(() => cryptoOverride.aesEncryptCalls() === 2)
      await waitFor(() => ws.sent.length === sentAfterHandshake + 1)
      const response = await decodeSentMessage(ws.sent.at(-1))
      expect(response).toMatchObject({
        id: 102,
        error: 'Command Runtime.evaluate timed out at chrome.debugger.sendCommand:Runtime.evaluate',
        errorDetail: {
          code: 'COMMAND_DEADLINE_EXCEEDED',
          requestId: 102,
          method: 'Runtime.evaluate',
          stage: 'chrome.debugger.sendCommand:Runtime.evaluate',
          operationElapsedMs: 10_000,
          deadlineSource: 'relay',
          timeoutSource: 'operation_limit',
          outcome: 'unknown',
          retryable: false,
        },
      })
      const failureWarnings = warnings.filter((args) => args.includes('command.failed'))
      expect(failureWarnings).toHaveLength(1)
      expect(failureWarnings[0]).toContain('code=COMMAND_DEADLINE_EXCEEDED')
      expect(failureWarnings[0]).toContain(
        'stage=chrome.debugger.sendCommand:Runtime.evaluate',
      )

      releaseBusinessEncryption.resolve()
      await waitFor(() => ws.sent.length === sentAfterHandshake + 2)
    } finally {
      console.warn = originalWarn
      await connection.disconnect()
    }
  })

  test('does not add another command warning when the deadline response cannot be sent', async () => {
    const cryptoOverride = createCryptoOverride(async () => {
      throw new Error('encrypt failed')
    })
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    const { connection } = await loadConnection({
      cryptoOverride: cryptoOverride.crypto,
      onMessage: async (_msg, commandContext) => {
        throw new CommandDeadlineExceededError({
          context: commandContext,
          stage: 'chrome.tabs.get',
          operationElapsedMs: 30_000,
          timeoutSource: 'command_deadline',
        })
      },
    })

    try {
      expect(await connection.connectAndAttach()).toBe(true)
      const ws = FakeWebSocket.instances[0]
      const sentBeforeCommand = ws.sent.length
      ws.serverMessage({
        id: 105,
        method: 'forwardCDPCommand',
        params: { method: 'Runtime.evaluate' },
      })
      await waitFor(() => cryptoOverride.aesEncryptCalls() === 1)
      await settleAsyncWork()

      expect(ws.sent).toHaveLength(sentBeforeCommand)
      expect(warnings.filter((args) => args.includes('command.failed'))).toHaveLength(1)
      expect(warnings.filter((args) => args.includes('send deadline error failed:'))).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      await connection.disconnect()
    }
  })

  test('logs one terminal event and keeps ordinary errors as string responses', async () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    const { connection } = await loadConnection({
      onMessage: async () => {
        throw new Error('ordinary failure')
      },
    })

    try {
      expect(await connection.connectAndAttach()).toBe(true)
      const ws = FakeWebSocket.instances[0]
      const sentBeforeCommand = ws.sent.length
      ws.serverMessage({
        id: 103,
        method: 'forwardCDPCommand',
        params: { method: 'Runtime.evaluate' },
      })

      await waitFor(() => ws.sent.length === sentBeforeCommand + 1)
      expect(await decodeSentMessage(ws.sent.at(-1))).toEqual({
        id: 103,
        error: 'ordinary failure',
      })
      const failureWarnings = warnings.filter((args) => args.includes('command.failed'))
      expect(failureWarnings).toHaveLength(1)
      expect(failureWarnings[0]).toContain('code=COMMAND_FAILED')
      expect(failureWarnings[0]).toContain('stage=unknown')
      expect(connection.getLogBuffer().at(-1)).toMatchObject({
        method: 'id:103',
        detail: 'error:COMMAND_FAILED',
      })
    } finally {
      console.warn = originalWarn
      await connection.disconnect()
    }
  })

  test('does not send a delayed deadline control frame through a replacement transport', async () => {
    const releaseDeadlineEncryption = createDeferred()
    const cryptoOverride = createCryptoOverride(async (call) => {
      if (call === 1) await releaseDeadlineEncryption.promise
    })
    const { connection } = await loadConnection({
      ackMode: 'manual',
      cryptoOverride: cryptoOverride.crypto,
      onMessage: async (_msg, commandContext) => {
        throw new CommandDeadlineExceededError({
          context: commandContext,
          stage: 'chrome.tabs.get',
          operationElapsedMs: 30_000,
          timeoutSource: 'command_deadline',
        })
      },
    })

    const firstConnect = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)
    const staleWs = FakeWebSocket.instances[0]
    staleWs.serverAck({ status: 'ok', encrypted: true })
    expect(await firstConnect).toBe(true)
    staleWs.serverMessage({
      id: 104,
      method: 'forwardCDPCommand',
      params: { method: 'Runtime.evaluate' },
    })
    await waitFor(() => cryptoOverride.aesEncryptCalls() === 1)

    await connection.disconnect()
    await connection.setRelayEnabled(true)
    const secondConnect = connection.reconnectNow()
    await waitFor(() => FakeWebSocket.instances[1]?.sent.length > 0)
    const currentWs = FakeWebSocket.instances[1]
    currentWs.serverAck({ status: 'ok', encrypted: true })
    expect(await secondConnect).toBe(true)

    const sentBeforeRelease = currentWs.sent.length
    releaseDeadlineEncryption.resolve()
    await settleAsyncWork()
    expect(currentWs.sent).toHaveLength(sentBeforeRelease)
    await connection.disconnect()
  })

  test('does not report connected before helloAck completes the handshake', async () => {
    const { connection } = await loadConnection({ ackMode: 'manual' })

    const connectPromise = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)

    expect(connection.isRelayConnected()).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: false,
      transportOpen: true,
      handshakeReady: false,
      active: true,
    })
    expect(() => connection.sendToRelay({ method: 'ping' })).toThrow('Relay not connected')

    FakeWebSocket.instances[0].serverAck({ status: 'ok', encrypted: true })
    expect(await connectPromise).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: true,
      transportOpen: true,
      handshakeReady: true,
      active: true,
    })

    await connection.disconnect()
  })

  test('ignores duplicate helloAck after the handshake is complete', async () => {
    const { connection } = await loadConnection({ ackMode: 'manual' })

    const connectPromise = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)

    FakeWebSocket.instances[0].serverAck({ status: 'ok', encrypted: true })
    expect(await connectPromise).toBe(true)

    FakeWebSocket.instances[0].serverAck({ status: 'version_mismatch' })
    await settleAsyncWork()

    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'connected',
      connected: true,
      transportOpen: true,
      handshakeReady: true,
    })

    await connection.disconnect()
  })

  test('does not mark debugger listeners installed when installation throws', async () => {
    let installed = 0
    const { connection } = await loadConnection({
      installDebuggerListeners: () => {
        throw new Error('listener install failed')
      },
    })

    expect(await connection.connectAndAttach()).toBe(false)
    expect(connection.isRelayConnected()).toBe(false)

    connection.initRelay({
      installDebuggerListeners: () => {
        installed++
      },
    })

    expect(await connection.reconnectNow()).toBe(true)
    expect(installed).toBe(1)

    await connection.disconnect()
  })

  test('disables relay after repeated debugger listener failures and keeps the local error', async () => {
    const { connection, notifications, storage } = await loadConnection({
      installDebuggerListeners: () => {
        throw new Error('listener install failed')
      },
    })

    for (let i = 0; i < LOCAL_FAILURE_DISABLE_THRESHOLD; i++) {
      expect(await connection.reconnectNow()).toBe(false)
    }

    expect(storage.relayEnabled).toBe(false)
    expect(storage._relayError).toBe('debugger_listener_failed')
    expect(storage._relayErrorSeverity).toBe('terminal')
    expect(storage.relayLocalFailureState).toBeUndefined()
    expect(notifications.at(-1)?.options).toMatchObject({
      title: 'Accio Relay: Relay Disabled',
    })
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      reconnecting: false,
    })
  })

  test('preserves encryption unsupported error after server-forced disconnect', async () => {
    const { connection, storage } = await loadConnection({ ackMode: 'manual' })

    const connectPromise = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)
    FakeWebSocket.instances[0].serverAck({ status: 'ok', encrypted: false })

    expect(await connectPromise).toBe(false)
    await settleAsyncWork()

    expect(storage.relayEnabled).toBe(false)
    expect(storage._relayError).toBe('encryption_unsupported')
    expect(storage._relayErrorSeverity).toBe('terminal')
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
    })
  })

  test('clears encryption unsupported error when the user enables relay again', async () => {
    const { connection, setRelayReachable, storage } = await loadConnection({ ackMode: 'manual' })

    const connectPromise = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)
    FakeWebSocket.instances[0].serverAck({ status: 'ok', encrypted: false })

    expect(await connectPromise).toBe(false)
    await settleAsyncWork()
    expect(storage._relayError).toBe('encryption_unsupported')

    setRelayReachable(false)
    await connection.toggle()

    expect(storage.relayEnabled).toBe(true)
    expect(storage._relayError).toBeUndefined()
    expect(storage._relayErrorSeverity).toBeUndefined()
  })

  test('keeps connected false when helloAck rejects the handshake', async () => {
    const { connection } = await loadConnection({ ackMode: 'reject' })

    expect(await connection.connectAndAttach()).toBe(false)
    expect(connection.isRelayConnected()).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: false,
      handshakeReady: false,
    })
    expect(() => connection.sendToRelay({ method: 'ping' })).toThrow('Relay not connected')
  })

  test('clears connected state after disconnect', async () => {
    const { connection } = await loadConnection()

    expect(await connection.connectAndAttach()).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)

    await connection.disconnect()

    expect(connection.isRelayConnected()).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      transportOpen: false,
      handshakeReady: false,
      active: false,
    })
  })

  test('marks disabled synchronously while disconnect cleanup is still pending', async () => {
    const shutdown = createDeferred()
    const { connection } = await loadConnection({
      onShutdown: () => shutdown.promise,
    })

    expect(await connection.connectAndAttach()).toBe(true)

    const disconnectPromise = connection.disconnect()

    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      transportOpen: false,
      handshakeReady: false,
      active: false,
    })

    shutdown.resolve()
    await disconnectPromise
  })

  test('ignores helloAck from a stale WebSocket after disconnect and reconnect', async () => {
    const { connection } = await loadConnection({ ackMode: 'manual' })

    const firstConnect = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)
    const staleWs = FakeWebSocket.instances[0]

    await connection.disconnect()
    expect(await firstConnect).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      transportOpen: false,
      handshakeReady: false,
    })

    staleWs.serverAck({ status: 'ok', encrypted: true })
    await settleAsyncWork()

    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      state: 'disabled',
      connected: false,
      transportOpen: false,
      handshakeReady: false,
    })

    await connection.setRelayEnabled(true)
    const secondConnect = connection.reconnectNow()
    await waitFor(() => FakeWebSocket.instances[1]?.sent.length > 0)

    let secondSettled = false
    secondConnect.finally(() => {
      secondSettled = true
    })

    staleWs.serverAck({ status: 'ok', encrypted: true })
    await settleAsyncWork()

    expect(secondSettled).toBe(false)
    expect(connection.getRelayConnectionSnapshot()).toMatchObject({
      connected: false,
      transportOpen: true,
      handshakeReady: false,
    })

    FakeWebSocket.instances[1].serverAck({ status: 'ok', encrypted: true })
    expect(await secondConnect).toBe(true)
    expect(connection.isRelayConnected()).toBe(true)

    await connection.disconnect()
  })

  test('provides bounded command contexts for new and old Relay payloads', async () => {
    const receivedContexts = []
    const { connection } = await loadConnection({
      onMessage: async (_msg, commandContext) => {
        receivedContexts.push(commandContext)
        return { ok: true }
      },
    })

    expect(await connection.connectAndAttach()).toBe(true)
    const ws = FakeWebSocket.instances[0]
    const sentAt = Date.now()

    ws.serverMessage({
      id: 99,
      ts: sentAt,
      method: 'forwardCDPCommand',
      params: {
        method: 'Runtime.evaluate',
        deadlineAt: sentAt + 20_000,
      },
    })
    ws.serverMessage({
      id: 100,
      ts: sentAt,
      method: 'forwardCDPCommand',
      params: { method: 'Page.captureScreenshot' },
    })

    await waitFor(() => receivedContexts.length === 2)
    expect(receivedContexts[0]).toMatchObject({
      requestId: 99,
      method: 'Runtime.evaluate',
      deadlineAt: sentAt + 20_000,
      deadlineSource: 'relay',
    })
    expect(receivedContexts[1]).toMatchObject({
      requestId: 100,
      method: 'Page.captureScreenshot',
      deadlineAt: sentAt + 60_000,
      deadlineSource: 'local_fallback',
    })

    await connection.disconnect()
  })

  test('returns the unified deadline response for a command already expired before dispatch', async () => {
    let handlerCalled = false
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    const { connection } = await loadConnection({
      onMessage: async () => {
        handlerCalled = true
      },
    })

    try {
      expect(await connection.connectAndAttach()).toBe(true)
      const ws = FakeWebSocket.instances[0]
      const sentBeforeCommand = ws.sent.length
      ws.serverMessage({
        id: 106,
        ts: Date.now() - 131_000,
        method: 'forwardCDPCommand',
        params: { method: 'Runtime.evaluate' },
      })

      await waitFor(() => ws.sent.length === sentBeforeCommand + 1)
      expect(await decodeSentMessage(ws.sent.at(-1))).toMatchObject({
        id: 106,
        error: 'Command Runtime.evaluate timed out at command_dispatch',
        errorDetail: {
          code: 'COMMAND_DEADLINE_EXCEEDED',
          requestId: 106,
          method: 'Runtime.evaluate',
          stage: 'command_dispatch',
        },
      })
      expect(handlerCalled).toBe(false)
      expect(warnings.filter((args) => args.includes('command.failed'))).toHaveLength(1)
      expect(warnings.some((args) => args.includes('dropping expired message:'))).toBe(false)
    } finally {
      console.warn = originalWarn
      await connection.disconnect()
    }
  })

  test('does not send a stale CDP response to a new WebSocket after reconnect', async () => {
    const cdpResult = createDeferred()
    const receivedMessages = []
    const { connection } = await loadConnection({
      ackMode: 'manual',
      onMessage: async (msg) => {
        receivedMessages.push(msg)
        return await cdpResult.promise
      },
    })

    const firstConnect = connection.connectAndAttach()
    await waitFor(() => FakeWebSocket.instances[0]?.sent.length > 0)
    const firstWs = FakeWebSocket.instances[0]
    firstWs.serverAck({ status: 'ok', encrypted: true })
    expect(await firstConnect).toBe(true)

    firstWs.serverMessage({
      id: 101,
      method: 'forwardCDPCommand',
      params: { method: 'Page.navigate' },
    })
    await waitFor(() => receivedMessages.length === 1)

    await connection.disconnect()
    await connection.setRelayEnabled(true)

    const secondConnect = connection.reconnectNow()
    await waitFor(() => FakeWebSocket.instances[1]?.sent.length > 0)
    const secondWs = FakeWebSocket.instances[1]
    secondWs.serverAck({ status: 'ok', encrypted: true })
    expect(await secondConnect).toBe(true)

    const sentBeforeStaleResult = secondWs.sent.length
    cdpResult.resolve({ ok: true })
    await settleAsyncWork()

    expect(secondWs.sent).toHaveLength(sentBeforeStaleResult)

    await connection.disconnect()
  })
})

test('screenshot progress sends only bounded stage metadata on the active relay transport', async () => {
  const { connection } = await loadConnection({
    onMessage: async (_msg, context) => {
      context.reportProgress?.('queued')
      context.reportProgress?.('dequeued')
      context.reportProgress?.('send_command_started')
      return { data: 'image-pixels-must-stay-in-result' }
    },
  })
  try {
    expect(await connection.connectAndAttach()).toBe(true)
    const ws = FakeWebSocket.instances[0]
    const sentAt = Date.now()
    ws.serverMessage({
      id: 503,
      ts: sentAt,
      method: 'forwardCDPCommand',
      params: { method: 'Page.captureScreenshot', deadlineAt: sentAt + 60_000 },
    })
    await waitFor(() => connection.getLogBuffer().some((entry) => entry.method === 'id:503'))
    await settleAsyncWork()
    const decoded = await Promise.all(ws.sent.filter((raw) => raw.startsWith('E:')).map(decodeSentMessage))
    const stages = decoded.filter((frame) => frame.method === 'Extension.commandProgress')
    expect(stages.map((frame) => frame.params.stage).sort()).toEqual(
      ['received', 'queued', 'dequeued', 'send_command_started', 'response_ready'].sort(),
    )
    for (const frame of stages) {
      expect(frame).toEqual({
        method: 'Extension.commandProgress',
        params: {
          requestId: 503,
          stage: expect.any(String),
          elapsedMs: expect.any(Number),
        },
      })
      expect(JSON.stringify(frame)).not.toContain('image-pixels')
      // The server drops non-finite/negative elapsedMs (server.ts:909-910), so
      // the emitted frames must be real non-negative numbers, not just typeof number.
      expect(Number.isFinite(frame.params.elapsedMs) && frame.params.elapsedMs >= 0).toBe(true)
    }
    expect(decoded.find((frame) => frame.id === 503)?.result.data).toBe('image-pixels-must-stay-in-result')
  } finally {
    await connection.disconnect()
  }
})

test('screenshot deadline keeps the last execution stage instead of reporting response_ready', async () => {
  const { connection } = await loadConnection({
    onMessage: async (_msg, context) => {
      context.reportProgress?.('send_command_started')
      context.reportProgress?.('send_command_timeout')
      throw new CommandDeadlineExceededError({
        context,
        stage: 'chrome.debugger.sendCommand:Page.captureScreenshot',
        operationElapsedMs: 60_000,
        timeoutSource: 'command_deadline',
      })
    },
  })
  try {
    expect(await connection.connectAndAttach()).toBe(true)
    const ws = FakeWebSocket.instances[0]
    const sentAt = Date.now()
    ws.serverMessage({
      id: 504,
      ts: sentAt,
      method: 'forwardCDPCommand',
      params: { method: 'Page.captureScreenshot', deadlineAt: sentAt + 60_000 },
    })
    await waitFor(() => connection.getLogBuffer().some((entry) => entry.method === 'id:504'))
    await settleAsyncWork()
    const decoded = await Promise.all(ws.sent.filter((raw) => raw.startsWith('E:')).map(decodeSentMessage))
    const stages = decoded.filter((frame) => frame.method === 'Extension.commandProgress').map((frame) => frame.params.stage)
    expect(stages).toContain('send_command_timeout')
    expect(stages).not.toContain('response_ready')
    expect(decoded.find((frame) => frame.id === 504)?.errorDetail.code).toBe('COMMAND_DEADLINE_EXCEEDED')
  } finally {
    await connection.disconnect()
  }
})
