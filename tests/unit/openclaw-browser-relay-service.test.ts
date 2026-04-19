import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { BrowserRelayServer, RELAY_PROTOCOL_VERSION } from '../../packages/openclaw-browser-relay-plugin/src/relay/server'
import { BrowserControlService } from '../../packages/openclaw-browser-relay-plugin/src/service/browser-control-service'
import { RELAY_PUBLIC_KEY_PEM } from '../../packages/openclaw-browser-relay-plugin/src/relay/keypair'
import { parseRoleSnapshot } from '../../packages/openclaw-browser-relay-plugin/src/playwright/role-refs'

const ENCRYPTED_PREFIX = 'E:'
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
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
let service: BrowserControlService | null = null

afterEach(async () => {
  await service?.stop()
  await server?.stop()
  service = null
  server = null
})

describe('browser relay service', () => {
  it('handles browser.request open and tabs through the unified service', async () => {
    server = new BrowserRelayServer({ port: 0, logger })
    await server.start()
    service = new BrowserControlService({ logger, relay: server })

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

    const openPromise = service.handleRequest({
      action: 'open',
      targetUrl: 'https://example.com/opened',
      sessionKey: 'agent:test',
    })

    const relayCommand = JSON.parse(decryptWireMessage(sessionKey, await waitForMessage(extensionWs)))
    expect(relayCommand.method).toBe('forwardCDPCommand')
    expect(relayCommand.params.method).toBe('Target.createTarget')

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: relayCommand.id,
          result: { targetId: 'target-opened' },
        }),
      ),
    )

    const openResult = await openPromise
    expect(openResult).toMatchObject({
      ok: true,
      targetId: 'target-opened',
      url: 'https://example.com/opened',
    })

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
            },
          },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    const tabsResult = await service.handleRequest({ action: 'tabs' })
    expect(tabsResult).toMatchObject({
      ok: true,
    })
    expect(tabsResult.tabs).toEqual([
      expect.objectContaining({
        targetId: 'target-opened',
        title: 'Opened Page',
        url: 'https://example.com/opened',
        isAgent: true,
      }),
    ])

    extensionWs.close()
  })

  it('parses role snapshots into stable refs', () => {
    const parsed = parseRoleSnapshot(
      [
        '- heading "Settings"',
        '- button "Save"',
        '- button "Save"',
        '- generic',
        '  - link "Open docs"',
      ].join('\n'),
      { compact: true },
    )

    expect(parsed.snapshot).toContain('[ref=e1]')
    expect(parsed.snapshot).toContain('[ref=e2]')
    expect(parsed.snapshot).toContain('[nth=1]')
    expect(parsed.refs.e1).toEqual({ role: 'heading', name: 'Settings' })
    expect(parsed.refs.e2).toEqual({ role: 'button', name: 'Save' })
    expect(parsed.stats.refs).toBe(4)
  })
})
