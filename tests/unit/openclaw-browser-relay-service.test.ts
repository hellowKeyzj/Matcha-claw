import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

type RelayMock = Pick<
  BrowserRelayServer,
  | 'hasExtensionConnection'
  | 'relayPort'
  | 'authHeaders'
  | 'status'
  | 'listAttachments'
  | 'listTabs'
  | 'onExtensionConnected'
  | 'resolveReadyTarget'
  | 'selectExecutionWindowForTargetIfUnset'
  | 'updateTargetUrl'
>

type BrowserControlServiceWithActions = BrowserControlService & {
  actions: {
    snapshot: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    navigate: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  session: {
    sendBrowserCdpCommand: (
      cdpUrl: string,
      method: string,
      params: Record<string, unknown>,
      mode?: 'relay' | 'direct-cdp',
    ) => Promise<Record<string, unknown>>
  }
}

function createRelayMock(overrides: Omit<RelayMock, 'onExtensionConnected'>): BrowserRelayServer {
  return {
    onExtensionConnected: () => () => {},
    status: {
      running: true,
      port: 9236,
      extensionConnected: true,
      handshakeOk: true,
      tabCount: 0,
      browserCount: 1,
      selectedBrowserInstanceId: null,
      selectedWindowId: null,
    },
    resolveReadyTarget: async (targetId: string) => ({
      browserInstanceId: 'browser-a',
      browserName: 'browser-a',
      sessionId: 'browser-a|sid|session-opened',
      targetId,
      windowId: 1,
      tabId: 1,
      active: false,
      title: '',
      url: '',
      mainFrameUrl: '',
      readyState: 'complete',
      executionContextReady: true,
    }),
    selectExecutionWindowForTargetIfUnset: async () => false,
    updateTargetUrl: () => {},
    ...overrides,
  } as RelayMock as BrowserRelayServer
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
let tempStateDir: string | null = null

async function startRelayServer(): Promise<BrowserRelayServer> {
  tempStateDir ??= await mkdtemp(path.join(os.tmpdir(), 'matchaclaw-relay-service-test-'))
  server = new BrowserRelayServer({ port: 0, logger, stateDir: tempStateDir })
  await server.start()
  return server
}

afterEach(async () => {
  await service?.stop()
  await server?.stop()
  if (tempStateDir) {
    await rm(tempStateDir, { recursive: true, force: true })
  }
  service = null
  server = null
  tempStateDir = null
})

describe('browser relay service', () => {
  it('handles browser.request open and tabs through the unified service', async () => {
    const relay = await startRelayServer()
    service = new BrowserControlService({ logger, relay })
    const snapshot = vi.fn(async (input: Record<string, unknown>) => ({
      snapshot: 'opened-page',
      refs: {},
      stats: { lines: 1, chars: 11, refs: 0, interactive: 0 },
      pageUrl: 'https://example.com/opened',
      input,
    }))
    ;(service as BrowserControlServiceWithActions).actions.snapshot = snapshot

    const port = relay.port
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
          params: {
            windowId: 1,
          },
        }),
      ),
    )
    await waitForMessage(extensionWs)

    const relayCommandPromise = waitForMessage(extensionWs)
    const openPromise = service.handleRequest({
      action: 'open',
      url: 'https://example.com/opened',
      sessionKey: 'agent:test',
    })

    const createTargetCommand = JSON.parse(decryptWireMessage(sessionKey, await relayCommandPromise))
    expect(createTargetCommand.method).toBe('forwardCDPCommand')
    expect(createTargetCommand.params.method).toBe('Target.createTarget')

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
                url: 'about:blank',
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
            method: 'Extension.tabUpdated',
            params: {
              sessionId: 'session-opened',
              tabId: 1,
              windowId: 1,
              active: false,
              targetKey: 'vtab:browser-a:1',
              targetInfo: {
                targetId: 'target-opened',
                type: 'page',
                title: 'Opened Page',
                url: 'https://example.com/opened',
                attached: true,
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
          method: 'Extension.currentTargetChanged',
          params: {
            sessionId: 'session-opened',
          },
        }),
      ),
    )

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: createTargetCommand.id,
          result: { targetId: 'target-opened' },
        }),
      ),
    )

    const openResult = await openPromise
    expect(openResult).toMatchObject({
      ok: true,
      action: 'open',
      targetId: 'browser-a|tid|target-opened',
      requestedUrl: 'https://example.com/opened',
      url: 'https://example.com/opened',
    })

    const snapshotResult = await service.handleRequest({ action: 'snapshot' })
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      cdpUrl: `http://127.0.0.1:${port}`,
      targetId: 'browser-a|tid|target-opened',
      mode: 'relay',
    }))
    expect(snapshotResult).toMatchObject({
      ok: true,
      targetId: 'browser-a|tid|target-opened',
      url: 'https://example.com/opened',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const tabsResult = await service.handleRequest({ action: 'tabs' })
    expect(tabsResult).toMatchObject({
      ok: true,
    })
    expect(tabsResult.tabs).toEqual([
      expect.objectContaining({
        targetId: 'browser-a|tid|target-opened',
        title: 'Opened Page',
        url: 'https://example.com/opened',
        isAgent: true,
      }),
    ])

    extensionWs.close()
  })

  it('keeps the opened page as current when current-target arrives before window selection finishes', async () => {
    const relay = await startRelayServer()
    service = new BrowserControlService({ logger, relay })
    const snapshot = vi.fn(async (input: Record<string, unknown>) => ({
      snapshot: 'opened-page',
      refs: {},
      stats: { lines: 1, chars: 11, refs: 0, interactive: 0 },
      pageUrl: 'https://example.com/opened',
      input,
    }))
    ;(service as BrowserControlServiceWithActions).actions.snapshot = snapshot

    const port = relay.port
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

    const relayCommandPromise = waitForMessage(extensionWs)
    const openPromise = service.handleRequest({
      action: 'open',
      url: 'https://example.com/opened',
      sessionKey: 'agent:test',
    })

    const createTargetCommand = JSON.parse(decryptWireMessage(sessionKey, await relayCommandPromise))
    expect(createTargetCommand.method).toBe('forwardCDPCommand')
    expect(createTargetCommand.params.method).toBe('Target.createTarget')

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
              tabId: 1,
              windowId: 1,
              active: true,
              targetKey: 'vtab:browser-a:1',
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

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          method: 'Extension.currentTargetChanged',
          params: {
            sessionId: 'session-opened',
          },
        }),
      ),
    )

    extensionWs.send(
      encryptWireMessage(
        sessionKey,
        JSON.stringify({
          id: createTargetCommand.id,
          result: { targetId: 'target-opened' },
        }),
      ),
    )

    const openResult = await openPromise
    expect(openResult).toMatchObject({
      ok: true,
      action: 'open',
      targetId: 'browser-a|tid|target-opened',
      requestedUrl: 'https://example.com/opened',
      url: 'https://example.com/opened',
    })

    const snapshotResult = await service.handleRequest({ action: 'snapshot' })
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      cdpUrl: `http://127.0.0.1:${port}`,
      targetId: 'browser-a|tid|target-opened',
      mode: 'relay',
    }))
    expect(snapshotResult).toMatchObject({
      ok: true,
      targetId: 'browser-a|tid|target-opened',
      url: 'https://example.com/opened',
    })

    extensionWs.close()
  })

  it('uses the current relay target and follows relay current-page changes', async () => {
    let attachments = [
      {
        browserInstanceId: 'browser-a',
        browserName: 'browser-a',
        windowId: 3,
        tabId: 7,
        active: true,
        sessionId: 'browser-a|sid|page-session',
        targetId: 'browser-a|tid|page-target',
        title: 'Selected Page',
        url: 'https://example.com/selected',
        selectedBrowser: true,
        selectedWindow: true,
        selected: true,
        primary: false,
      },
      {
        browserInstanceId: 'browser-a',
        browserName: 'browser-a',
        windowId: 3,
        tabId: 8,
        active: true,
        sessionId: 'browser-a|sid|opened-session',
        targetId: 'browser-a|tid|opened-target',
        title: 'Opened Page',
        url: 'https://example.com/opened',
        selectedBrowser: true,
        selectedWindow: true,
        selected: true,
        primary: true,
      },
    ]

    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => attachments,
        listTabs: () => [],
      }),
    })

    const snapshot = vi.fn(async (input: Record<string, unknown>) => ({
      snapshot: 'snapshot',
      refs: {},
      stats: { lines: 1, chars: 8, refs: 0, interactive: 0 },
      pageUrl: String(input.targetId),
    }))
    ;(service as BrowserControlServiceWithActions).actions.snapshot = snapshot

    const openedResult = await service.handleRequest({ action: 'snapshot' })
    expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: 'browser-a|tid|opened-target',
      mode: 'relay',
    }))
    expect(openedResult).toMatchObject({
      ok: true,
      targetId: 'browser-a|tid|opened-target',
      url: 'browser-a|tid|opened-target',
    })

    attachments = [
      {
        ...attachments[0],
        primary: true,
      },
    ]

    const fallbackResult = await service.handleRequest({ action: 'snapshot' })
    expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: 'browser-a|tid|page-target',
      mode: 'relay',
    }))
    expect(fallbackResult).toMatchObject({
      ok: true,
      targetId: 'browser-a|tid|page-target',
      url: 'browser-a|tid|page-target',
    })
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

  it('uses the current relay target when browser action omits targetId', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 3,
            tabId: 7,
            active: true,
            sessionId: 'browser-a|sid|page-session',
            targetId: 'browser-a|tid|page-target',
            title: 'Selected Page',
            url: 'https://example.com/selected',
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
        ],
        listTabs: () => [],
      }),
    })

    const snapshot = vi.fn(async (input: Record<string, unknown>) => ({
      snapshot: 'button "Submit"',
      refs: {},
      stats: { lines: 1, chars: 15, refs: 0, interactive: 0 },
      pageUrl: 'https://example.com/selected',
      input,
    }))

    ;(service as BrowserControlServiceWithActions).actions.snapshot = snapshot

    const result = await service.handleRequest({ action: 'snapshot' })

    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'browser-a|tid|page-target',
      mode: 'relay',
    }))
    expect(result).toMatchObject({
      ok: true,
      targetId: 'browser-a|tid|page-target',
      url: 'https://example.com/selected',
    })
  })

  it('uses url for navigate requests', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 3,
            tabId: 7,
            active: true,
            sessionId: 'browser-a|sid|page-session',
            targetId: 'browser-a|tid|page-target',
            title: 'Selected Page',
            url: 'https://example.com/selected',
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
        ],
        listTabs: () => [],
      }),
    })

    const navigate = vi.fn(async (input: Record<string, unknown>) => ({
      url: String(input.url),
    }))
    ;(service as BrowserControlServiceWithActions).actions.navigate = navigate

    const result = await service.handleRequest({
      action: 'navigate',
      url: 'https://example.com/next',
    })

    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'browser-a|tid|page-target',
      mode: 'relay',
      url: 'https://example.com/next',
    }))
    expect(result).toMatchObject({
      ok: true,
      action: 'navigate',
      targetId: 'browser-a|tid|page-target',
      requestedUrl: 'https://example.com/next',
      url: 'https://example.com/next',
    })
  })

  it('opens direct-cdp targets with the requested url and does not perform a follow-up Playwright navigation', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: false,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [],
        listTabs: () => [],
      }),
    })

    const sendBrowserCdpCommand = vi.fn(async () => ({ targetId: 'direct-target' }))

    ;(service as any).resolveDirectEndpoint = async () => ({
      httpUrl: 'http://127.0.0.1:9222',
      wsUrl: null,
      port: 9222,
      preferredUrl: 'http://127.0.0.1:9222',
    })
    ;(service as any).autoLauncher.ensureRelayBrowserAvailable = async () => {}
    ;(service as BrowserControlServiceWithActions).session.sendBrowserCdpCommand = sendBrowserCdpCommand

    const result = await service.handleRequest({
      action: 'open',
      url: 'https://example.com/direct-opened',
    })

    expect(sendBrowserCdpCommand).toHaveBeenCalledWith(
      'http://127.0.0.1:9222',
      'Target.createTarget',
      { url: 'https://example.com/direct-opened' },
      'direct-cdp',
    )
    expect((service as any).tabState.currentTargetId).toBe('direct-target')
    expect(result).toMatchObject({
      ok: true,
      action: 'open',
      targetId: 'direct-target',
      requestedUrl: 'https://example.com/direct-opened',
      url: 'https://example.com/direct-opened',
    })
  })

  it('delegates opened-window auto-selection to relay when no window is currently selected', async () => {
    const selectExecutionWindowForTargetIfUnset = vi.fn(async () => true)
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        status: {
          running: true,
          port: 9236,
          extensionConnected: true,
          handshakeOk: true,
          tabCount: 0,
          browserCount: 1,
          selectedBrowserInstanceId: null,
          selectedWindowId: null,
        },
        listAttachments: () => [],
        listTabs: () => [],
        resolveReadyTarget: async (targetId: string) => ({
          browserInstanceId: 'browser-a',
          browserName: 'browser-a',
          sessionId: 'browser-a|sid|session-opened',
          targetId,
          windowId: 7,
          tabId: 71,
          active: true,
          title: 'Opened Page',
          url: 'https://example.com/opened',
          mainFrameUrl: 'https://example.com/opened',
          readyState: 'complete',
          executionContextReady: true,
        }),
        selectExecutionWindowForTargetIfUnset,
      }),
    })

    ;(service as any).options.relay.openTarget = async (url: string) => ({
      targetId: `browser-a|tid|opened:${url}`,
    })

    const result = await (service as any).handleRelayAction('open', { action: 'open', url: 'https://example.com/opened' })

    expect(selectExecutionWindowForTargetIfUnset).toHaveBeenCalledWith('browser-a|tid|opened:https://example.com/opened')
    expect(result).toMatchObject({
      ok: true,
      action: 'open',
      targetId: 'browser-a|tid|opened:https://example.com/opened',
      requestedUrl: 'https://example.com/opened',
      url: 'https://example.com/opened',
    })
  })

  it('always delegates opened-window selection to relay even when a window is already selected', async () => {
    const selectExecutionWindowForTargetIfUnset = vi.fn(async () => false)
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        status: {
          running: true,
          port: 9236,
          extensionConnected: true,
          handshakeOk: true,
          tabCount: 1,
          browserCount: 1,
          selectedBrowserInstanceId: 'browser-a',
          selectedWindowId: 3,
        },
        listAttachments: () => [],
        listTabs: () => [],
        resolveReadyTarget: async (targetId: string) => ({
          browserInstanceId: 'browser-a',
          browserName: 'browser-a',
          sessionId: 'browser-a|sid|session-opened',
          targetId,
          windowId: 7,
          tabId: 71,
          active: true,
          title: 'Opened Page',
          url: 'https://example.com/opened',
          mainFrameUrl: 'https://example.com/opened',
          readyState: 'complete',
          executionContextReady: true,
        }),
        selectExecutionWindowForTargetIfUnset,
      }),
    })

    ;(service as any).options.relay.openTarget = async (url: string) => ({
      targetId: `browser-a|tid|opened:${url}`,
    })

    await (service as any).handleRelayAction('open', { action: 'open', url: 'https://example.com/opened' })

    expect(selectExecutionWindowForTargetIfUnset).toHaveBeenCalledWith('browser-a|tid|opened:https://example.com/opened')
  })

  it('fails clearly when no current relay target exists', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [],
        listTabs: () => [],
      }),
    })

    const result = await service.handleRequest({ action: 'snapshot' })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'no_current_target',
      error: 'No current browser target available. Open or focus a page before using browser actions.',
      recoverable: true,
      suggestedNextActions: ['tabs', 'open', 'focus'],
    })
  })

  it('rejects default execution when physical relay tabs exist but no browser instance is selected', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 1,
            tabId: 11,
            active: true,
            sessionId: 'browser-a|sid|page-a',
            targetId: 'browser-a|tid|target-a',
            title: 'Page A',
            url: 'https://a.example.com',
            selectedBrowser: false,
            selectedWindow: false,
            selected: false,
            primary: true,
          },
          {
            browserInstanceId: 'browser-b',
            browserName: 'browser-b',
            windowId: 2,
            tabId: 22,
            active: true,
            sessionId: 'browser-b|sid|page-b',
            targetId: 'browser-b|tid|target-b',
            title: 'Page B',
            url: 'https://b.example.com',
            selectedBrowser: false,
            selectedWindow: false,
            selected: false,
            primary: true,
          },
        ],
        listTabs: () => [],
      }),
    })

    const result = await service.handleRequest({ action: 'snapshot' })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'no_current_target',
      error: 'No current browser target available. Open or focus a page before using browser actions.',
      recoverable: true,
      suggestedNextActions: ['tabs', 'open', 'focus'],
    })
  })

  it('does not fall back to a virtual tab when the current physical relay target disappears', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [],
        listTabs: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 1,
            tabId: 11,
            active: true,
            sessionId: 'browser-a|sid|page-a',
            targetKey: 'browser-a|tid|vtab:browser-a:11',
            targetId: '',
            title: 'Virtual Page',
            url: 'https://example.com/virtual',
            physical: false,
            ready: false,
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
        ],
      }),
    })

    ;(service as any).tabState.setCurrentTarget('browser-a|tid|old-physical-target')

    const result = await service.handleRequest({ action: 'snapshot' })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'no_current_target',
      error: 'No current browser target available. Open or focus a page before using browser actions.',
    })
  })

  it('returns structured browser-unavailable metadata when tabs has no control channel to query', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: false,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [],
        listTabs: () => [],
      }),
    })

    ;(service as any).resolveDirectEndpoint = async () => null

    const result = await service.handleRequest({ action: 'tabs' })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'browser_unavailable',
      error: 'Browser extension not connected and no direct CDP browser detected.',
      recoverable: true,
      suggestedNextActions: ['start', 'open'],
    })
  })

  it('returns structured stale-snapshot metadata when the requested ref no longer exists', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 3,
            tabId: 7,
            active: true,
            sessionId: 'browser-a|sid|page-session',
            targetId: 'browser-a|tid|page-target',
            title: 'Selected Page',
            url: 'https://example.com/selected',
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
        ],
        listTabs: () => [],
      }),
    })

    ;(service as BrowserControlServiceWithActions).actions.snapshot = vi.fn(async () => {
      throw new Error('Unknown ref "e9". Run a new snapshot and use a ref from that snapshot.')
    })

    const result = await service.handleRequest({ action: 'snapshot', ref: 'e9' })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'stale_snapshot_ref',
      error: 'Unknown ref "e9". Run a new snapshot and use a ref from that snapshot.',
      recoverable: true,
      suggestedNextActions: ['snapshot'],
    })
  })

  it('returns all discovered relay tabs with browser and window metadata', async () => {
    service = new BrowserControlService({
      logger,
      relay: createRelayMock({
        hasExtensionConnection: true,
        relayPort: 9236,
        authHeaders: {},
        listAttachments: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 1,
            tabId: 11,
            active: true,
            sessionId: 'browser-a|sid|page-a',
            targetId: 'browser-a|tid|target-a',
            title: 'Page A',
            url: 'https://a.example.com',
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
        ],
        listTabs: () => [
          {
            browserInstanceId: 'browser-a',
            browserName: 'browser-a',
            windowId: 1,
            tabId: 11,
            active: true,
            sessionId: 'browser-a|sid|page-a',
            targetKey: 'browser-a|tid|vtab:browser-a:11',
            targetId: 'browser-a|tid|target-a',
            title: 'Page A',
            url: 'https://a.example.com',
            physical: true,
            selectedBrowser: true,
            selectedWindow: true,
            selected: true,
            primary: true,
          },
          {
            browserInstanceId: 'browser-b',
            browserName: 'browser-b',
            windowId: 2,
            tabId: 22,
            active: false,
            sessionId: 'browser-b|sid|page-b',
            targetKey: 'browser-b|tid|vtab:browser-b:22',
            targetId: '',
            title: 'Page B',
            url: 'https://b.example.com',
            physical: false,
            selectedBrowser: false,
            selectedWindow: false,
            selected: false,
            primary: false,
          },
        ],
      }),
    })

    const result = await service.handleRequest({ action: 'tabs' })

    expect(result).toMatchObject({
      ok: true,
      tabs: [
        expect.objectContaining({
          browserInstanceId: 'browser-a',
          windowId: 1,
          tabId: 11,
          active: true,
          targetKey: 'browser-a|tid|vtab:browser-a:11',
          targetId: 'browser-a|tid|target-a',
          physical: true,
          isSelectedBrowser: true,
          isSelectedWindow: true,
          isPrimary: true,
        }),
        expect.objectContaining({
          browserInstanceId: 'browser-b',
          windowId: 2,
          tabId: 22,
          active: false,
          targetKey: 'browser-b|tid|vtab:browser-b:22',
          targetId: null,
          physical: false,
          isSelectedBrowser: false,
          isSelectedWindow: false,
          isPrimary: false,
        }),
      ],
    })
  })
})
