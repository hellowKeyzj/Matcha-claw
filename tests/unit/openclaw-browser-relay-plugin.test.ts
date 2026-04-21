import { afterEach, describe, expect, it } from 'vitest'
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
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()

    const baseUrl = `http://127.0.0.1:${server.port}`
    const headResponse = await fetch(baseUrl, { method: 'HEAD' })
    const getResponse = await fetch(baseUrl)
    const jsonVersionResponse = await fetch(`${baseUrl}/json/version/`, {
      headers: {
        [RELAY_AUTH_HEADER]: server.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const diagnosticsResponse = await fetch(`${baseUrl}/diagnostics`)

    expect(headResponse.status).toBe(200)
    expect(await getResponse.text()).toBe('OK')
    expect(jsonVersionResponse.status).toBe(200)
    expect(diagnosticsResponse.status).toBe(401)
  })

  it('completes encrypted extension handshake and accepts CDP clients', async () => {
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()

    const port = server.port
    expect(port).toBeTypeOf('number')

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
          extensionVersion: '0.1.3',
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )

    const helloAckRaw = await waitForMessage(extensionWs)
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
      headers: server.authHeaders,
    })
    await waitForOpen(cdpWs)

    cdpWs.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    const cdpMessage = JSON.parse(await waitForMessage(cdpWs))
    expect(cdpMessage.result.product).toContain('OpenClaw-Browser-Relay')

    cdpWs.close()
    extensionWs.close()
  })

  it('exposes attached tabs through /json/list', async () => {
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()

    const port = server.port
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
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await waitForMessage(extensionWs)

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
        [RELAY_AUTH_HEADER]: server.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const targets = await listResponse.json()

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      id: 'target-1',
      title: 'Example',
      url: 'https://example.com',
    })

    extensionWs.close()
  })

  it('does not emit duplicate attachedToTarget events when auto-attach is configured repeatedly', async () => {
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()

    const port = server.port
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
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await waitForMessage(extensionWs)

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
      headers: server.authHeaders,
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

  it('only exposes top-level page targets through relay tab discovery APIs', async () => {
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()

    const port = server.port
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
          encryptedSessionKey: encryptSessionKey(sessionKey),
        },
      }),
    )
    await waitForMessage(extensionWs)

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

    expect(server.listAttachments()).toEqual([
      {
        sessionId: 'page-session',
        targetId: 'page-target',
        title: 'Example',
        url: 'https://example.com',
      },
    ])

    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: {
        [RELAY_AUTH_HEADER]: server.authHeaders[RELAY_AUTH_HEADER],
      },
    })
    const targets = await response.json() as Array<{ id: string; type: string }>

    expect(targets).toEqual([
      expect.objectContaining({
        id: 'page-target',
        type: 'page',
      }),
    ])

    extensionWs.close()
  })

  it('reclaims the recorded stale relay owner before binding the fixed relay port', async () => {
    tempStateDir = await mkdtemp(path.join(os.tmpdir(), 'matchaclaw-relay-owner-'))
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

    server = new BrowserRelayServer({ port, logger, stateDir: tempStateDir })
    await server.start()

    await expect(waitForProcessExit(childProcess)).resolves.toBeUndefined()

    const response = await fetch(`http://127.0.0.1:${port}`)
    expect(await response.text()).toBe('OK')
  }, 15_000)

  it('fails clearly when the relay port is occupied by an unowned process', async () => {
    const port = await findFreePort()

    childProcess = await spawnListeningProcess(port, 'foreign-owner')
    await waitForPortResponse(port)

    server = new BrowserRelayServer({ port, logger })
    await expect(server.start()).rejects.toThrow(`Relay port ${port} is already in use`)
  }, 15_000)
})
