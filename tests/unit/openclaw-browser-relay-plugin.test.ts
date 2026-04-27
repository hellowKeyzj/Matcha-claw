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
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()))
    ws.once('error', reject)
  })
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

    const relayCommandPromise = waitForMessage(extensionWs)
    const openTargetPromise = server!.openTarget('https://example.com/opened')

    const createTargetCommand = JSON.parse(decryptWireMessage(sessionKey, await relayCommandPromise))
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
    expect(pageAttachResponse.result).toMatchObject({
      sessionId: 'browser-a|sid|page-a',
    })

    cdpWs.send(JSON.stringify({
      id: 3,
      sessionId: browserSessionId,
      method: 'Target.getTargetInfo',
      params: {},
    }))
    const browserInfoResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(browserInfoResponse.result?.targetInfo).toMatchObject({
      type: 'browser',
      title: 'browser-a',
    })

    cdpWs.send(JSON.stringify({
      id: 4,
      sessionId: 'browser-a|sid|page-a',
      method: 'Target.getTargetInfo',
      params: {},
    }))
    const pageInfoResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(pageInfoResponse.result?.targetInfo).toMatchObject({
      targetId: 'browser-a|tid|target-a',
      title: 'Page A',
      url: 'https://a.example.com',
    })

    cdpWs.send(JSON.stringify({
      id: 5,
      method: 'Target.detachFromTarget',
      params: {
        sessionId: browserSessionId,
      },
    }))
    const detachResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(detachResponse.result).toEqual({})

    cdpWs.close()
    extensionWs.close()
  })

  it('forwards page-session bootstrap commands to the extension instead of swallowing them in relay mode', async () => {
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
      sessionId: 'browser-a|sid|page-a',
      method: 'Page.enable',
      params: {},
    }))

    const pageEnableCommand = JSON.parse(decryptWireMessage(sessionKey, await waitForMessage(extensionWs)))
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

    const pageEnableResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(pageEnableResponse).toMatchObject({
      id: 1,
      sessionId: 'browser-a|sid|page-a',
      result: {},
    })

    cdpWs.send(JSON.stringify({
      id: 2,
      sessionId: 'browser-a|sid|page-a',
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      },
    }))

    const autoAttachCommand = JSON.parse(decryptWireMessage(sessionKey, await waitForMessage(extensionWs)))
    expect(autoAttachCommand).toMatchObject({
      method: 'forwardCDPCommand',
      params: {
        sessionId: 'page-a',
        method: 'Target.setAutoAttach',
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        },
      },
    })
    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: autoAttachCommand.id,
          result: {},
        }),
      ),
    )

    const autoAttachResponse = JSON.parse(await waitForMessage(cdpWs))
    expect(autoAttachResponse).toMatchObject({
      id: 2,
      sessionId: 'browser-a|sid|page-a',
      result: {},
    })

    cdpWs.close()
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

    const selectionChanged1 = waitForMessage(extension)
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

    const selectionChanged2 = waitForMessage(extension)
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
    const selectionChanged = waitForMessage(extension)
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

    const selectionChanged = waitForMessage(firstExtension)
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

    const selectionChanged = waitForMessage(extension)
    await expect(server!.selectExecutionWindowForTargetIfUnset('browser-open|tid|target-open')).resolves.toBe(true)
    const selectionPayload = JSON.parse(decryptWireMessage(sessionKey, await selectionChanged))
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

    const selectionChanged = waitForMessage(extension)
    await expect(server!.selectExecutionWindowForTargetIfUnset('browser-multi|tid|target-a')).resolves.toBe(true)
    const selectionPayload = JSON.parse(decryptWireMessage(sessionKey, await selectionChanged))
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
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: 1,
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
      selectedBrowserInstanceId: 'browser-a',
      selectedWindowId: 1,
    })

    extension.close()
  })

  it('clears a stale persisted window selection for the same browser until a live window is rediscovered', async () => {
    tempStateDir = await ensureTempStateDir('matchaclaw-relay-selection-stale-same-browser-')
    await writeRelaySelection(
      {
        selectedBrowserInstanceId: 'browser-a',
        selectedWindowId: 7,
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
      selectedBrowserInstanceId: 'browser-a',
      selectedWindowId: null,
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
      selectedBrowserInstanceId: 'browser-a',
      selectedWindowId: 9,
    })

    extension.close()
  })
})
