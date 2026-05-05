import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import {
  BrowserRelayServer,
  RELAY_AUTH_HEADER,
  RELAY_PROTOCOL_VERSION,
} from '../../packages/openclaw-browser-relay-plugin/src/relay/server'
import { RELAY_PUBLIC_KEY_PEM } from '../../packages/openclaw-browser-relay-plugin/src/relay/keypair'
import {
  getRelayOwnerFilePath,
  inspectRelayProcess,
  type RelayOwnerRecord,
} from '../../packages/openclaw-browser-relay-plugin/src/relay/ownership'
import { readRelaySelection, writeRelaySelection } from '../../packages/openclaw-browser-relay-plugin/src/relay/selection-state'

const ENCRYPTED_PREFIX = 'E:'
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

type BufferedSocketState = {
  messages: string[]
  waiters: Array<{
    resolve: (message: string) => void
    reject: (error: Error) => void
  }>
}

const bufferedSocketStates = new WeakMap<WebSocket, BufferedSocketState>()

function ensureBufferedSocket(ws: WebSocket): BufferedSocketState {
  const existing = bufferedSocketStates.get(ws)
  if (existing) {
    return existing
  }

  const state: BufferedSocketState = {
    messages: [],
    waiters: [],
  }

  ws.on('message', (data) => {
    const message = data.toString()
    const waiter = state.waiters.shift()
    if (waiter) {
      waiter.resolve(message)
      return
    }
    state.messages.push(message)
  })

  ws.on('error', (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    while (state.waiters.length > 0) {
      state.waiters.shift()?.reject(normalized)
    }
  })

  ws.on('close', () => {
    const error = new Error('WebSocket closed before the expected message arrived')
    while (state.waiters.length > 0) {
      state.waiters.shift()?.reject(error)
    }
  })

  bufferedSocketStates.set(ws, state)
  return state
}

function encryptSessionKey(sessionKey: Buffer): string {
  return publicEncrypt(
    {
      key: RELAY_PUBLIC_KEY_PEM,
      oaepHash: 'sha256',
    },
    sessionKey,
  ).toString('base64')
}

function encryptWireMessage(sessionKey: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, ciphertext, tag]).toString('base64')}`
}

function decryptWireMessage(sessionKey: Buffer, wireMessage: string): string {
  if (!wireMessage.startsWith(ENCRYPTED_PREFIX)) return wireMessage
  const payload = Buffer.from(wireMessage.slice(ENCRYPTED_PREFIX.length), 'base64')
  const iv = payload.subarray(0, 12)
  const ciphertext = payload.subarray(12, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function waitForOpen(ws: WebSocket): Promise<void> {
  ensureBufferedSocket(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function waitForMessage(ws: WebSocket): Promise<string> {
  const state = ensureBufferedSocket(ws)
  const buffered = state.messages.shift()
  if (buffered !== undefined) {
    return Promise.resolve(buffered)
  }

  return new Promise((resolve, reject) => {
    state.waiters.push({ resolve, reject })
  })
}

async function waitForJsonMessageMatching(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  while (true) {
    const message = JSON.parse(await waitForMessage(ws)) as Record<string, unknown>
    if (predicate(message)) {
      return message
    }
  }
}

async function waitForEncryptedJsonMessageMatching(
  ws: WebSocket,
  sessionKey: Buffer,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  while (true) {
    const message = JSON.parse(decryptWireMessage(sessionKey, await waitForMessage(ws))) as Record<string, unknown>
    if (predicate(message)) {
      return message
    }
  }
}

let server: BrowserRelayServer | null = null
let childProcess: ChildProcessWithoutNullStreams | null = null
let tempStateDir: string | null = null

async function ensureTempStateDir(prefix = 'matchaclaw-relay-test-'): Promise<string> {
  tempStateDir ??= await mkdtemp(path.join(os.tmpdir(), prefix))
  return tempStateDir
}

async function startRelayServer(port = 0): Promise<BrowserRelayServer> {
  server = new BrowserRelayServer({
    port,
    logger,
    stateDir: await ensureTempStateDir(),
  })
  await server.start()
  return server
}

afterEach(async () => {
  await server?.stop()
  if (childProcess && !childProcess.killed) {
    childProcess.kill('SIGKILL')
  }
  childProcess = null
  if (tempStateDir) {
    await rm(tempStateDir, { recursive: true, force: true })
  }
  tempStateDir = null
  server = null
})

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate port'))
        return
      }
      const { port } = address
      probe.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function waitForPortResponse(port: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`port ${port} did not start responding in time`)
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return
  }
  await new Promise((resolve) => child.once('exit', resolve))
}

async function spawnListeningProcess(port: number, body: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        'const http = require("node:http")',
        `const server = http.createServer((_, res) => res.end(${JSON.stringify(body)}))`,
        `server.listen(${port}, "127.0.0.1", () => console.log("ready"))`,
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child process did not start on port ${port}`)), 5_000)
    child.stdout.once('data', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child process exited before ready (code=${code}, signal=${signal})`))
    })
  })

  return child
}

describe('openclaw browser relay plugin', () => {
  it('serves relay health endpoints', async () => {
    await startRelayServer()

    const baseUrl = `http://127.0.0.1:${server!.port}`
    const headResponse = await fetch(baseUrl, { method: 'HEAD' })
    const getResponse = await fetch(baseUrl)
    const jsonVersionResponse = await fetch(`${baseUrl}/json/version/`, {
      headers: {
        [RELAY_AUTH_HEADER]: server!.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const diagnosticsResponse = await fetch(`${baseUrl}/diagnostics`)

    expect(headResponse.status).toBe(200)
    expect(await getResponse.text()).toBe('OK')
    expect(jsonVersionResponse.status).toBe(200)
    expect(diagnosticsResponse.status).toBe(401)
  })

  it('completes encrypted extension handshake and accepts CDP clients', async () => {
    await startRelayServer()

    const port = server!.port
    expect(port).toBeTypeOf('number')

    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckRawPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          extensionVersion: '0.1.3',
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )

    const helloAckRaw = await helloAckRawPromise
    const helloAck = JSON.parse(decryptWireMessage(sessionKey, helloAckRaw))
    expect(helloAck).toMatchObject({
      method: 'Extension.helloAck',
      params: {
        status: 'ok',
        encrypted: true,
      },
    })

    const statusResponse = await fetch(`http://127.0.0.1:${port}/status`)
    const status = await statusResponse.json()
    expect(status.connected).toBe(true)

    const cdpWs = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: server!.authHeaders,
    })
    await waitForOpen(cdpWs)

    cdpWs.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    const cdpMessage = JSON.parse(await waitForMessage(cdpWs))
    expect(cdpMessage.result.product).toContain('OpenClaw-Browser-Relay')

    cdpWs.close()
    extensionWs.close()
  })

  it('exposes attached tabs through /json/list', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Extension.tabDiscovered',
            params: {
              sessionId: 'session-1',
              targetInfo: {
                targetId: 'target-1',
                type: 'page',
                title: 'Example',
                url: 'https://example.com',
              },
            },
          },
        }),
      ),
    )

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: 'session-1',
            params: {
              sessionId: 'session-1',
              targetInfo: {
                targetId: 'target-1',
                type: 'page',
                title: 'Example',
                url: 'https://example.com',
              },
            },
          },
        }),
      ),
    )

    const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: {
        [RELAY_AUTH_HEADER]: server!.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const targets = await listResponse.json()

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      id: 'browser-a|tid|target-1',
      title: 'Example',
      url: 'https://example.com',
    })

    extensionWs.close()
  })

  it('waits for created targets to become physically attached', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await waitForMessage(extensionWs)

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'Extension.selectExecutionWindow',
          params: { windowId: 1 },
        }),
      ),
    )
    await waitForMessage(extensionWs)

    const relayCommandPromise = waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand',
    )
    const openTargetPromise = server!.openTarget('https://example.com/opened')

    const createTargetCommand = await relayCommandPromise
    expect(createTargetCommand.params.method).toBe('Target.createTarget')

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: createTargetCommand.id,
          result: { targetId: 'target-opened' },
        }),
      ),
    )

    const opened = await openTargetPromise
    let resolvedTargetId: string | null = null
    const waitPromise = server!.waitForAttachedTarget(opened.targetId).then((attached) => {
      resolvedTargetId = attached.targetId
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(resolvedTargetId).toBeNull()

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: 'session-opened',
            params: {
              sessionId: 'session-opened',
              targetInfo: {
                targetId: 'target-opened',
                type: 'page',
                title: 'Opened Page',
                url: 'https://example.com/opened',
              },
              windowId: 1,
              tabId: 11,
              active: false,
            },
          },
        }),
      ),
    )

    await waitPromise
    expect(resolvedTargetId).toBe(opened.targetId)
    await expect(server!.waitForAttachedTarget(opened.targetId)).resolves.toMatchObject({
      targetId: opened.targetId,
      sessionId: 'browser-a|sid|session-opened',
      windowId: 1,
      tabId: 11,
    })

    extensionWs.close()
  })

  it('does not emit duplicate attachedToTarget events when auto-attach is configured repeatedly', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: 'session-1',
            params: {
              sessionId: 'session-1',
              targetInfo: {
                targetId: 'target-1',
                type: 'page',
                title: 'Example',
                url: 'https://example.com',
              },
            },
          },
        }),
      ),
    )

    const cdpWs = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: server!.authHeaders,
    })
    await waitForOpen(cdpWs)

    const messages: Array<Record<string, unknown>> = []
    cdpWs.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })

    cdpWs.send(JSON.stringify({
      id: 1,
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
    }))

    cdpWs.send(JSON.stringify({
      id: 2,
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
    }))

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(messages.filter((entry) => entry.method === 'Target.attachedToTarget')).toHaveLength(1)
    expect(messages.filter((entry) => entry.id === 1)).toHaveLength(1)
    expect(messages.filter((entry) => entry.id === 2)).toHaveLength(1)

    cdpWs.close()
    extensionWs.close()
  })

  it('returns a browser target for root Target.getTargetInfo instead of falling back to the selected page target', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'page-a',
              tabId: 11,
              windowId: 1,
              active: true,
              targetInfo: {
                targetId: 'target-a',
                type: 'page',
                title: 'Page A',
                url: 'https://a.example.com',
              },
            },
          },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const cdpWs = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: server!.authHeaders,
    })
    await waitForOpen(cdpWs)

    cdpWs.send(JSON.stringify({
      id: 1,
      method: 'Target.getTargetInfo',
      params: {},
    }))

    const response = JSON.parse(await waitForMessage(cdpWs))
    expect(response.result?.targetInfo).toMatchObject({
      type: 'browser',
      title: 'browser-a',
    })
    expect(response.result?.targetInfo?.targetId).not.toBe('browser-a|tid|target-a')

    cdpWs.close()
    extensionWs.close()
  })

  it('supports browser sessions for page CDP attachment', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'page-a',
              tabId: 11,
              windowId: 1,
              active: true,
              targetInfo: {
                targetId: 'target-a',
                type: 'page',
                title: 'Page A',
                url: 'https://a.example.com',
              },
            },
          },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const cdpWs = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: server!.authHeaders,
    })
    await waitForOpen(cdpWs)

    cdpWs.send(JSON.stringify({
      id: 1,
      method: 'Target.attachToBrowserTarget',
      params: {},
    }))
    const browserAttachResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(browserAttachResponse.result?.sessionId).toMatch(/^browser-a\|bsid\|/)
    const browserSessionId = browserAttachResponse.result.sessionId

    cdpWs.send(JSON.stringify({
      id: 2,
      sessionId: browserSessionId,
      method: 'Target.attachToTarget',
      params: {
        targetId: 'browser-a|tid|target-a',
        flatten: true,
      },
    }))
    const pageAttachResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(pageAttachResponse.result?.sessionId).toMatch(/^browser-a\|asid\|/)
    const attachSessionId = pageAttachResponse.result.sessionId

    cdpWs.send(JSON.stringify({
      id: 3,
      method: 'Target.detachFromTarget',
      params: {
        sessionId: attachSessionId,
      },
    }))
    const detachResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 3)
    expect(detachResponse.result).toEqual({})

    cdpWs.send(JSON.stringify({
      id: 4,
      method: 'Target.detachFromTarget',
      params: {
        sessionId: browserSessionId,
      },
    }))
    const detachBrowserResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 4)
    expect(detachBrowserResponse.result).toEqual({})

    cdpWs.close()
    extensionWs.close()
  })

  it('routes attach-session bootstrap commands and page events through the physical page session', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'page-a',
              tabId: 11,
              windowId: 1,
              active: true,
              targetInfo: {
                targetId: 'target-a',
                type: 'page',
                title: 'Page A',
                url: 'https://a.example.com',
              },
            },
          },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const cdpWs = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: server!.authHeaders,
    })
    await waitForOpen(cdpWs)

    cdpWs.send(JSON.stringify({
      id: 1,
      method: 'Target.attachToTarget',
      params: {
        targetId: 'browser-a|tid|target-a',
        flatten: true,
      },
    }))
    const firstAttachResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 1)
    expect(firstAttachResponse.result?.sessionId).toMatch(/^browser-a\|asid\|/)
    const firstAttachSessionId = firstAttachResponse.result.sessionId

    cdpWs.send(JSON.stringify({
      id: 2,
      sessionId: firstAttachSessionId,
      method: 'Page.enable',
      params: {},
    }))

    const pageEnableCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Page.enable',
    )
    expect(pageEnableCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        sessionId: 'page-a',
        method: 'Page.enable',
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: pageEnableCommand.id,
          result: {},
        }),
      ),
    )

    const pageEnableResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 2)
    expect(pageEnableResponse).toMatchObject({
      id: 2,
      sessionId: firstAttachSessionId,
      result: {},
    })

    cdpWs.send(JSON.stringify({
      id: 3,
      sessionId: firstAttachSessionId,
      method: 'Page.getFrameTree',
      params: {},
    }))

    const frameTreeCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Page.getFrameTree',
    )
    expect(frameTreeCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        sessionId: 'page-a',
        method: 'Page.getFrameTree',
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: frameTreeCommand.id,
          result: {
            frameTree: {
              frame: {
                id: 'target-a',
                url: 'https://a.example.com',
                securityOrigin: 'https://a.example.com',
                mimeType: 'text/html',
              },
            },
          },
        }),
      ),
    )

    const frameTreeResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 3)
    expect(frameTreeResponse).toMatchObject({
      id: 3,
      sessionId: firstAttachSessionId,
      result: {
        frameTree: {
          frame: {
            id: 'browser-a|tid|target-a',
            url: 'https://a.example.com',
          },
        },
      },
    })

    cdpWs.send(JSON.stringify({
      id: 4,
      sessionId: firstAttachSessionId,
      method: 'Runtime.enable',
      params: {},
    }))

    const runtimeEnableCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Runtime.enable',
    )
    expect(runtimeEnableCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        sessionId: 'page-a',
        method: 'Runtime.enable',
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: runtimeEnableCommand.id,
          result: {},
        }),
      ),
    )

    const runtimeEnableResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 4)
    expect(runtimeEnableResponse).toMatchObject({
      id: 4,
      sessionId: firstAttachSessionId,
      result: {},
    })

    cdpWs.send(JSON.stringify({
      id: 5,
      sessionId: firstAttachSessionId,
      method: 'Page.createIsolatedWorld',
      params: {
        frameId: 'browser-a|tid|target-a',
        worldName: 'playwright',
        grantUniveralAccess: true,
      },
    }))

    const createWorldCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Page.createIsolatedWorld',
    )
    expect(createWorldCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        sessionId: 'page-a',
        method: 'Page.createIsolatedWorld',
        params: {
          frameId: 'target-a',
          worldName: 'playwright',
          grantUniveralAccess: true,
        },
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: createWorldCommand.id,
          result: {
            executionContextId: 101,
          },
        }),
      ),
    )

    const createWorldResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 5)
    expect(createWorldResponse).toMatchObject({
      id: 5,
      sessionId: firstAttachSessionId,
      result: {
        executionContextId: 101,
      },
    })

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            sessionId: 'page-a',
            method: 'Runtime.executionContextCreated',
            params: {
              context: {
                id: 1,
                origin: 'https://a.example.com',
                name: '',
                auxData: {
                  frameId: 'target-a',
                  isDefault: true,
                  type: 'default',
                },
              },
            },
          },
        }),
      ),
    )
    const firstRuntimeEvent = await waitForJsonMessageMatching(
      cdpWs,
      (message) => message.method === 'Runtime.executionContextCreated' && (message.params as any)?.context?.id === 1,
    )
    expect(firstRuntimeEvent).toMatchObject({
      method: 'Runtime.executionContextCreated',
      sessionId: firstAttachSessionId,
      params: {
        context: {
          id: 1,
          auxData: {
            frameId: 'browser-a|tid|target-a',
          },
        },
      },
    })

    cdpWs.send(JSON.stringify({
      id: 6,
      method: 'Target.attachToTarget',
      params: {
        targetId: 'browser-a|tid|target-a',
        flatten: true,
      },
    }))
    const secondAttachResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 6)
    expect(secondAttachResponse.result?.sessionId).toMatch(/^browser-a\|asid\|/)
    const secondAttachSessionId = secondAttachResponse.result.sessionId
    expect(secondAttachSessionId).not.toBe(firstAttachSessionId)

    const duplicatedRuntimeEvents = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const collected: Array<Record<string, unknown>> = []
      const timer = setTimeout(() => {
        cdpWs.off('message', onMessage)
        reject(new Error('Timed out waiting for duplicated runtime events'))
      }, 1_000)
      const onMessage = (data: any) => {
        const message = JSON.parse(data.toString()) as Record<string, any>
        if (message.method !== 'Runtime.executionContextCreated') return
        if (message.params?.context?.id !== 2) return
        collected.push(message)
        if (collected.length < 2) return
        clearTimeout(timer)
        cdpWs.off('message', onMessage)
        resolve(collected)
      }

      cdpWs.on('message', onMessage)
      extensionWs.send(
        encryptWireMessage(
          sessionKey,
          JSON.stringify({
            method: 'forwardCDPEvent',
            params: {
              sessionId: 'page-a',
              method: 'Runtime.executionContextCreated',
              params: {
                context: {
                  id: 2,
                  origin: 'https://a.example.com',
                  name: '',
                  auxData: {
                    frameId: 'target-a',
                    isDefault: true,
                    type: 'default',
                  },
                },
              },
            },
          }),
        ),
      )
    })
    const [secondRuntimeEvent, thirdRuntimeEvent] = duplicatedRuntimeEvents
    expect(
      [secondRuntimeEvent.sessionId, thirdRuntimeEvent.sessionId].sort(),
    ).toEqual([firstAttachSessionId, secondAttachSessionId].sort())

    cdpWs.send(JSON.stringify({
      id: 7,
      method: 'Target.detachFromTarget',
      params: {
        sessionId: firstAttachSessionId,
      },
    }))
    const detachFirstAttachResponse = await waitForJsonMessageMatching(cdpWs, (message) => message.id === 7)
    expect(detachFirstAttachResponse).toMatchObject({
      id: 7,
      result: {},
    })

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            sessionId: 'page-a',
            method: 'Runtime.executionContextCreated',
            params: {
              context: {
                id: 3,
                origin: 'https://a.example.com',
                name: '',
                auxData: {
                  frameId: 'target-a',
                  isDefault: true,
                  type: 'default',
                },
              },
            },
          },
        }),
      ),
    )
    const remainingRuntimeEvent = await waitForJsonMessageMatching(
      cdpWs,
      (message) => message.method === 'Runtime.executionContextCreated' && (message.params as any)?.context?.id === 3,
    )
    expect(remainingRuntimeEvent).toMatchObject({
      method: 'Runtime.executionContextCreated',
      sessionId: secondAttachSessionId,
      params: {
        context: {
          id: 3,
          auxData: {
            frameId: 'browser-a|tid|target-a',
          },
        },
      },
    })

    cdpWs.close()
    extensionWs.close()
  })

  it('forwards native cookie commands through relay target routing', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'page-a',
              tabId: 11,
              windowId: 1,
              active: true,
              targetInfo: {
                targetId: 'target-a',
                type: 'page',
                title: 'Page A',
                url: 'https://a.example.com/account',
              },
            },
          },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const getCookiesPromise = server!.getCookies('browser-a|tid|target-a')
    const getCookiesCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Extension.getCookies',
    )
    expect(getCookiesCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        method: 'Extension.getCookies',
        params: {
          targetId: 'target-a',
        },
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: getCookiesCommand.id,
          result: [{ name: 'sid', value: 'abc' }],
        }),
      ),
    )
    await expect(getCookiesPromise).resolves.toEqual([{ name: 'sid', value: 'abc' }])

    const setCookiesPromise = server!.setCookies('browser-a|tid|target-a', [
      { name: 'sid', value: 'next', path: '/' },
    ])
    const setCookiesCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Extension.setCookies',
    )
    expect(setCookiesCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        method: 'Extension.setCookies',
        params: {
          targetId: 'target-a',
          cookies: [{ name: 'sid', value: 'next', path: '/' }],
        },
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: setCookiesCommand.id,
          result: { ok: true },
        }),
      ),
    )
    await expect(setCookiesPromise).resolves.toBeUndefined()

    const clearCookiesPromise = server!.clearCookies('browser-a|tid|target-a')
    const clearCookiesCommand = await waitForEncryptedJsonMessageMatching(
      extensionWs,
      sessionKey,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Extension.clearCookies',
    )
    expect(clearCookiesCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        method: 'Extension.clearCookies',
        params: {
          targetId: 'target-a',
        },
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: clearCookiesCommand.id,
          result: { ok: true },
        }),
      ),
    )
    await expect(clearCookiesPromise).resolves.toBeUndefined()

    extensionWs.close()
  })

  it('only exposes top-level page targets through relay tab discovery APIs', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extensionWs = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test' },
    })
    await waitForOpen(extensionWs)

    const helloAckPromise = waitForMessage(extensionWs)
    extensionWs.send(
      JSON.stringify({
        method: 'Extension.hello',
        params: {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          browserInstanceId: 'browser-a',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await helloAckPromise

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: 'page-session',
            params: {
              sessionId: 'page-session',
              targetInfo: {
                targetId: 'page-target',
                type: 'page',
                title: 'Example',
                url: 'https://example.com',
                browserContextId: 'default',
              },
            },
          },
        }),
      ),
    )

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: 'iframe-session',
            params: {
              sessionId: 'iframe-session',
              targetInfo: {
                targetId: 'iframe-target',
                type: 'iframe',
                title: '',
                url: 'https://example.com/frame',
                browserContextId: 'default',
              },
            },
          },
        }),
      ),
    )

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.listAttachments()).toEqual([
      expect.objectContaining({
        sessionId: 'browser-a|sid|page-session',
        targetId: 'browser-a|tid|page-target',
        title: 'Example',
        url: 'https://example.com',
      }),
    ])

    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: {
        [RELAY_AUTH_HEADER]: server!.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const targets = await response.json() as Array<{ id: string; type: string }>

    expect(targets).toEqual([
      expect.objectContaining({
        id: 'browser-a|tid|page-target',
        type: 'page',
      }),
    ])

    extensionWs.close()
  })

  it('tracks multiple browser instances and switches the selected default window explicitly', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKeyA = randomBytes(32)
    const sessionKeyB = randomBytes(32)

    const extensionA = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-a' },
    })
    const extensionB = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-b' },
    })

    await Promise.all([waitForOpen(extensionA), waitForOpen(extensionB)])

    const helloAckAPromise = waitForMessage(extensionA)
    extensionA.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKeyA),
      },
    }))
    const helloAckBPromise = waitForMessage(extensionB)
    extensionB.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-b',
        encryptedSessionKey: encryptSessionKey(sessionKeyB),
      },
    }))

    await Promise.all([helloAckAPromise, helloAckBPromise])

    extensionA.send(encryptWireMessage(sessionKeyA, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 1,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-b',
          tabId: 22,
          windowId: 2,
          active: true,
          targetKey: 'vtab:browser-b:22',
          targetInfo: {
            targetId: 'target-b',
            type: 'page',
            title: 'Page B',
            url: 'https://b.example.com',
          },
        },
      },
    })))

    const selectionChangedA1 = waitForMessage(extensionA)
    const selectionChangedB1 = waitForMessage(extensionB)
    extensionA.send(encryptWireMessage(sessionKeyA, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 1 },
    })))
    await selectionChangedA1
    await selectionChangedB1
    extensionA.send(encryptWireMessage(sessionKeyA, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-a',
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    await vi.waitFor(() => {
      expect(server!.listTabs()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          browserInstanceId: 'browser-a',
          tabId: 11,
          windowId: 1,
          active: true,
          targetKey: 'browser-a|tid|vtab:browser-a:11',
          targetId: 'browser-a|tid|target-a',
          selectedBrowser: true,
          selectedWindow: true,
          selected: true,
          primary: true,
        }),
        expect.objectContaining({
          browserInstanceId: 'browser-b',
          tabId: 22,
          windowId: 2,
          active: true,
          targetKey: 'browser-b|tid|vtab:browser-b:22',
          targetId: 'browser-b|tid|target-b',
          selectedBrowser: false,
          selectedWindow: false,
          selected: false,
          primary: false,
        }),
      ]))
    })
    expect(server!.resolveSelectedSessionId()).toBe('browser-a|sid|page-a')

    const selectionChangedA2 = waitForMessage(extensionA)
    const selectionChangedB2 = waitForMessage(extensionB)
    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 2 },
    })))
    await selectionChangedA2
    await selectionChangedB2
    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-b',
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.resolveSelectedSessionId()).toBe('browser-b|sid|page-b')

    extensionA.close()
    extensionB.close()
  })

  it('switches the selected default window within the same browser instance', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)

    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-a' },
    })

    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))

    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 1,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-b',
          tabId: 22,
          windowId: 2,
          active: true,
          targetKey: 'vtab:browser-a:22',
          targetInfo: {
            targetId: 'target-b',
            type: 'page',
            title: 'Page B',
            url: 'https://b.example.com',
          },
        },
      },
    })))

    const selectionChanged1 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 1,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 1 },
    })))
    await selectionChanged1
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-a',
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.resolveSelectedSessionId()).toBe('browser-a|sid|page-a')

    const selectionChanged2 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 2,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 2 },
    })))
    await selectionChanged2
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-b',
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.resolveSelectedSessionId()).toBe('browser-a|sid|page-b')
    expect(server!.listTabs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        browserInstanceId: 'browser-a',
        windowId: 1,
        selectedWindow: false,
        selected: false,
        primary: false,
      }),
      expect.objectContaining({
        browserInstanceId: 'browser-a',
        windowId: 2,
        selectedWindow: true,
        selected: true,
        primary: true,
      }),
    ]))

    extension.close()
  })

  it('retains the selected window when the selected browser instance disconnects', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)

    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-a' },
    })

    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))

    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 1,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    const selectionChanged = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 1,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 1 },
    })))
    await selectionChanged
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-a',
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(1)
    expect(server!.resolveSelectedSessionId()).toBe('browser-a|sid|page-a')

    extension.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(1)
    expect(() => server!.resolveSelectedSessionId()).toThrow('Selected window has no current attached page.')
  })

  it('restores the selected window across relay restart and rebinds it after reconnect', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-selection-')
    await startRelayServer()

    const firstPort = server!.port
    const firstSessionKey = randomBytes(32)
    const firstExtension = new WebSocket(`ws://127.0.0.1:${firstPort}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-a' },
    })

    await waitForOpen(firstExtension)

    const firstHelloAckPromise = waitForMessage(firstExtension)
    firstExtension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(firstSessionKey),
      },
    }))

    await firstHelloAckPromise

    const selectionChanged = waitForEncryptedJsonMessageMatching(
      firstExtension,
      firstSessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 7,
    )
    firstExtension.send(encryptWireMessage(firstSessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 7 },
    })))
    await selectionChanged

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(7)

    firstExtension.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server!.stop()
    server = null

    await startRelayServer()

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(7)
    expect(() => server!.resolveSelectedSessionId()).toThrow('Selected window has no current attached page.')

    const secondPort = server!.port
    const secondSessionKey = randomBytes(32)
    const secondExtension = new WebSocket(`ws://127.0.0.1:${secondPort}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-a' },
    })

    await waitForOpen(secondExtension)

    const secondHelloAckPromise = waitForMessage(secondExtension)
    secondExtension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(secondSessionKey),
      },
    }))

    const helloAck = JSON.parse(decryptWireMessage(secondSessionKey, await secondHelloAckPromise))
    expect(helloAck).toMatchObject({
      method: 'Extension.helloAck',
      params: {
        browserCount: 1,
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: null,
        selected: true,
        selectedBrowser: true,
        selectedWindow: false,
      },
    })

    secondExtension.send(encryptWireMessage(secondSessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 7,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    secondExtension.send(encryptWireMessage(secondSessionKey, JSON.stringify({
      method: 'Extension.currentTargetChanged',
      params: {
        sessionId: 'page-a',
      },
    })))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server!.status.selectedWindowId).toBe(7)
    expect(server!.resolveSelectedSessionId()).toBe('browser-a|sid|page-a')

    secondExtension.close()
  })

  it('auto-selects the opened target window when no execution window is currently selected', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-open-select' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-open',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-open',
          tabId: 51,
          windowId: 5,
          active: true,
          targetKey: 'vtab:browser-open:51',
          targetInfo: {
            targetId: 'target-open',
            type: 'page',
            title: 'Opened Page',
            url: 'https://example.com/opened',
          },
        },
      },
    })))

    await new Promise((resolve) => setTimeout(resolve, 20))

    const selectionChanged = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-open'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 5,
    )
    await expect(server!.selectExecutionWindowForTargetIfUnset('browser-open|tid|target-open')).resolves.toBe(true)
    const selectionPayload = await selectionChanged
    expect(selectionPayload).toMatchObject({
      method: 'Extension.selectionChanged',
      params: {
        selectedBrowserInstanceId: 'browser-open',
        selectedWindowId: 5,
      },
    })
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-open')
    expect(server!.status.selectedWindowId).toBe(5)

    extension.close()
  })

  it('selects the opened target window even when the browser has multiple known windows', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-open-multi' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-multi',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 61,
          windowId: 6,
          active: true,
          targetKey: 'vtab:browser-multi:61',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://example.com/a',
          },
        },
      },
    })))
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-b',
          tabId: 62,
          windowId: 7,
          active: false,
          targetKey: 'vtab:browser-multi:62',
          targetInfo: {
            targetId: 'target-b',
            type: 'page',
            title: 'Page B',
            url: 'https://example.com/b',
          },
        },
      },
    })))

    await new Promise((resolve) => setTimeout(resolve, 20))

    const selectionChanged = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-multi'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 6,
    )
    await expect(server!.selectExecutionWindowForTargetIfUnset('browser-multi|tid|target-a')).resolves.toBe(true)
    const selectionPayload = await selectionChanged
    expect(selectionPayload).toMatchObject({
      method: 'Extension.selectionChanged',
      params: {
        selectedBrowserInstanceId: 'browser-multi',
        selectedWindowId: 6,
      },
    })
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-multi')
    expect(server!.status.selectedWindowId).toBe(6)

    extension.close()
  })

  it('reclaims the recorded stale relay owner before binding the fixed relay port', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-owner-')
    const port = await findFreePort()

    childProcess = await spawnListeningProcess(port, 'stale-owner')
    await waitForPortResponse(port)

    const processInfo = await inspectRelayProcess(childProcess.pid)
    expect(processInfo).not.toBeNull()

    const ownerRecord: RelayOwnerRecord = {
      pid: childProcess.pid!,
      port,
      startedAtMs: processInfo?.startedAtMs ?? null,
      command: processInfo?.command ?? '',
    }

    const ownerFilePath = getRelayOwnerFilePath(tempStateDir)
    await mkdir(path.dirname(ownerFilePath), { recursive: true })
    await writeFile(ownerFilePath, JSON.stringify(ownerRecord, null, 2), 'utf8')

    await startRelayServer(port)

    await expect(waitForProcessExit(childProcess)).resolves.toBeUndefined()

    const response = await fetch(`http://127.0.0.1:${port}`)
    expect(await response.text()).toBe('OK')
  }, 15_000)

  it('fails clearly when the relay port is occupied by an unowned process', async () => {
    const port = await findFreePort()

    childProcess = await spawnListeningProcess(port, 'foreign-owner')
    await waitForPortResponse(port)

    server = new BrowserRelayServer({ port, logger, stateDir: await ensureTempStateDir() })
    await expect(server.start()).rejects.toThrow(`Relay port ${port} is already in use`)
  }, 15_000)

  it('does not auto-repair a stale persisted browser selection when a different browser reconnects', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-selection-repair-')
    await writeRelaySelection(
      {
        kind: 'manual',
        browserInstanceId: 'browser-a',
        windowId: 1,
      },
      tempStateDir,
    )

    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-b' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-b',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-b',
          tabId: 22,
          windowId: 9,
          active: true,
          targetKey: 'vtab:browser-b:22',
          targetInfo: {
            targetId: 'target-b',
            type: 'page',
            title: 'Page B',
            url: 'https://b.example.com',
          },
        },
      },
    })))

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(1)
    await expect(readRelaySelection(tempStateDir)).resolves.toEqual({
      kind: 'manual',
      browserInstanceId: 'browser-a',
      windowId: 1,
    })

    extension.close()
  })

  it('clears a stale persisted window selection for the same browser until a live window is rediscovered', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-selection-stale-same-browser-')
    await writeRelaySelection(
      {
        kind: 'manual',
        browserInstanceId: 'browser-a',
        windowId: 7,
      },
      tempStateDir,
    )

    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-same-browser-stale-window' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))

    const helloAck = JSON.parse(decryptWireMessage(sessionKey, await helloAckPromise))
    expect(helloAck).toMatchObject({
      method: 'Extension.helloAck',
      params: {
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: null,
        selected: true,
        selectedBrowser: true,
        selectedWindow: false,
      },
    })
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBeNull()
    await expect(readRelaySelection(tempStateDir)).resolves.toEqual({
      kind: 'manual',
      browserInstanceId: 'browser-a',
      windowId: null,
    })

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 22,
          windowId: 9,
          active: true,
          targetKey: 'vtab:browser-a:22',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(9)
    await expect(readRelaySelection(tempStateDir)).resolves.toEqual({
      kind: 'manual',
      browserInstanceId: 'browser-a',
      windowId: 9,
    })

    extension.close()
  })

  it('clears selection when extension explicitly revokes execution window control', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-clear-selection-')
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-clear-selection' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    const selectionChanged1 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 7,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 7 },
    })))
    await selectionChanged1

    const selectionChanged2 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === null
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === null,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.clearExecutionWindowSelection',
      params: {},
    })))
    await selectionChanged2

    expect(server!.status.selectedBrowserInstanceId).toBeNull()
    expect(server!.status.selectedWindowId).toBeNull()
    await expect(readRelaySelection(tempStateDir)).resolves.toBeNull()

    extension.close()
  })

  it('does not re-select a window after explicit clear and detach', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-clear-selection-detach-')
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-clear-selection-detach' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 7,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const selectionChanged1 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 7,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 7 },
    })))
    await selectionChanged1

    const selectionChanged2 = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === null
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === null,
    )
    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'Extension.clearExecutionWindowSelection',
      params: {},
    })))
    await selectionChanged2

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 7,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetId: 'target-a',
          reason: 'canceled_by_user',
        },
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server!.status.selectedBrowserInstanceId).toBeNull()
    expect(server!.status.selectedWindowId).toBeNull()
    await expect(readRelaySelection(tempStateDir)).resolves.toBeNull()

    extension.close()
  })

  it('creates and auto-selects a fresh controlled window after manual selection was cleared in a multi-browser setup', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKeyA = randomBytes(32)
    const sessionKeyB = randomBytes(32)
    const extensionA = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-multi-a' },
    })
    const extensionB = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-multi-b' },
    })
    await waitForOpen(extensionA)
    await waitForOpen(extensionB)

    const helloAckA = waitForMessage(extensionA)
    extensionA.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKeyA),
      },
    }))
    await helloAckA

    const helloAckB = waitForMessage(extensionB)
    extensionB.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-b',
        encryptedSessionKey: encryptSessionKey(sessionKeyB),
      },
    }))
    await helloAckB

    const selectionChanged = waitForEncryptedJsonMessageMatching(
      extensionA,
      sessionKeyA,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-a'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 7,
    )
    extensionA.send(encryptWireMessage(sessionKeyA, JSON.stringify({
      method: 'Extension.selectExecutionWindow',
      params: { windowId: 7 },
    })))
    await selectionChanged

    extensionA.send(encryptWireMessage(sessionKeyA, JSON.stringify({
      method: 'Extension.clearExecutionWindowSelection',
      params: {},
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server!.status.selectedBrowserInstanceId).toBeNull()
    expect(server!.status.selectedWindowId).toBeNull()

    const createTargetCommand = waitForEncryptedJsonMessageMatching(
      extensionB,
      sessionKeyB,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Target.createTarget',
    )
    const ensurePromise = server!.ensureExecutionWindowSelectionForBrowserUse()
    const createTargetRequest = await createTargetCommand

    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      id: createTargetRequest.id,
      result: { targetId: 'target-fresh' },
    })))

    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-fresh',
          tabId: 91,
          windowId: 9,
          active: true,
          targetKey: 'vtab:browser-b:91',
          targetInfo: {
            targetId: 'target-fresh',
            type: 'page',
            title: 'Fresh Controlled Page',
            url: 'about:blank',
          },
        },
      },
    })))

    await expect(ensurePromise).resolves.toBe(true)
    await waitForEncryptedJsonMessageMatching(
      extensionB,
      sessionKeyB,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-b'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 9,
    )
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-b')
    expect(server!.status.selectedWindowId).toBe(9)

    extensionA.close()
    extensionB.close()
  })

  it('opens a page through a newly provisioned execution window when no browser is selected in a multi-browser setup', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKeyA = randomBytes(32)
    const sessionKeyB = randomBytes(32)
    const extensionA = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-open-multi-a' },
    })
    const extensionB = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-open-multi-b' },
    })
    await waitForOpen(extensionA)
    await waitForOpen(extensionB)

    const helloAckA = waitForMessage(extensionA)
    extensionA.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKeyA),
      },
    }))
    await helloAckA

    const helloAckB = waitForMessage(extensionB)
    extensionB.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-b',
        encryptedSessionKey: encryptSessionKey(sessionKeyB),
      },
    }))
    await helloAckB

    expect(server!.status.selectedBrowserInstanceId).toBeNull()
    expect(server!.status.selectedWindowId).toBeNull()

    const provisionCommand = waitForEncryptedJsonMessageMatching(
      extensionB,
      sessionKeyB,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Target.createTarget'
        && ((message.params as Record<string, unknown>).params as Record<string, unknown> | undefined)?.url === 'about:blank',
    )
    const openPromise = server!.openTarget('https://example.com/opened')
    const provisionRequest = await provisionCommand

    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      id: provisionRequest.id,
      result: { targetId: 'target-provisioned' },
    })))
    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-provisioned',
          tabId: 91,
          windowId: 9,
          active: true,
          targetKey: 'vtab:browser-b:91',
          targetInfo: {
            targetId: 'target-provisioned',
            type: 'page',
            title: 'Provisioned Page',
            url: 'about:blank',
          },
        },
      },
    })))

    await waitForEncryptedJsonMessageMatching(
      extensionB,
      sessionKeyB,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-b'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 9,
    )

    const openedCommand = await waitForEncryptedJsonMessageMatching(
      extensionB,
      sessionKeyB,
      (message) => message.method === 'forwardCDPCommand'
        && (message.params as Record<string, unknown> | undefined)?.method === 'Target.createTarget'
        && ((message.params as Record<string, unknown>).params as Record<string, unknown> | undefined)?.url === 'https://example.com/opened',
    )
    extensionB.send(encryptWireMessage(sessionKeyB, JSON.stringify({
      id: openedCommand.id,
      result: { targetId: 'target-opened' },
    })))

    await expect(openPromise).resolves.toEqual({
      targetId: 'browser-b|tid|target-opened',
    })
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-b')
    expect(server!.status.selectedWindowId).toBe(9)

    extensionA.close()
    extensionB.close()
  })

  it('auto-selects the only known window when browser use is requested in a single-browser setup', async () => {
    await startRelayServer()

    const port = server!.port
    const sessionKey = randomBytes(32)
    const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://unit-test-single-browser-use' },
    })
    await waitForOpen(extension)

    const helloAckPromise = waitForMessage(extension)
    extension.send(JSON.stringify({
      method: 'Extension.hello',
      params: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        browserInstanceId: 'browser-a',
        encryptedSessionKey: encryptSessionKey(sessionKey),
      },
    }))
    await helloAckPromise

    extension.send(encryptWireMessage(sessionKey, JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'page-a',
          tabId: 11,
          windowId: 7,
          active: true,
          targetKey: 'vtab:browser-a:11',
          targetInfo: {
            targetId: 'target-a',
            type: 'page',
            title: 'Page A',
            url: 'https://a.example.com',
          },
        },
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const selectionChanged = waitForEncryptedJsonMessageMatching(
      extension,
      sessionKey,
      (message) => message.method === 'Extension.selectionChanged'
        && (message.params as Record<string, unknown> | undefined)?.selectedBrowserInstanceId === 'browser-a'
        && (message.params as Record<string, unknown> | undefined)?.selectedWindowId === 7,
    )

    await expect(server!.ensureExecutionWindowSelectionForBrowserUse()).resolves.toBe(true)
    await selectionChanged
    expect(server!.status.selectedBrowserInstanceId).toBe('browser-a')
    expect(server!.status.selectedWindowId).toBe(7)
    await expect(readRelaySelection(tempStateDir)).resolves.toEqual({
      kind: 'auto',
      browserInstanceId: 'browser-a',
      windowId: 7,
    })

    extension.close()
  })
})
