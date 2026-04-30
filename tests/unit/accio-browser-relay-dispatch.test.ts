import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCreateTarget = vi.fn()
const cdpCloseTarget = vi.fn()
const cdpCloseAllAgentTabs = vi.fn()
const cdpActivateTarget = vi.fn()
const sendCommand = vi.fn()
const getCookies = vi.fn()
const setCookie = vi.fn()
const removeCookie = vi.fn()
const getTab = vi.fn()

vi.mock('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/commands/target-ops.js', () => ({
  createTargetOps: () => ({
    cdpCreateTarget,
    cdpCloseTarget,
    cdpCloseAllAgentTabs,
    cdpActivateTarget,
  }),
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/content_script/extension-ops.js', () => ({
  extGetViewportInfo: vi.fn(),
  extEnsureZoom: vi.fn(),
  extCaptureViewport: vi.fn(),
  extExtractContent: vi.fn(),
  extMarkElements: vi.fn(),
  extClick: vi.fn(),
  extInput: vi.fn(),
}))

describe('accio browser relay dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    ;(globalThis as any).chrome = {
      debugger: {
        sendCommand,
      },
      cookies: {
        getAll: getCookies,
        set: setCookie,
        remove: removeCookie,
      },
      tabs: {
        get: getTab,
      },
    }
  })

  it('routes Runtime.enable through the addressed child session instead of always using the root tab session', async () => {
    sendCommand.mockResolvedValue({})

    const { createDispatcher } = await import('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/commands/dispatch.js')
    const mgr = {
      resolveTabId: vi.fn(() => 7),
      ensureAttached: vi.fn(async () => true),
      onCdpCommand: vi.fn(),
      get: vi.fn(() => ({ sessionId: 'main-session' })),
    }

    const dispatch = createDispatcher(mgr as any)
    await dispatch({
      params: {
        method: 'Runtime.enable',
        sessionId: 'child-session',
        params: {},
      },
    })

    expect(sendCommand).toHaveBeenNthCalledWith(1, { tabId: 7, sessionId: 'child-session' }, 'Runtime.disable')
    expect(sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7, sessionId: 'child-session' }, 'Runtime.enable', {})
  })

  it('routes Extension.getCookies and Extension.clearCookies through chrome.cookies using the current tab url', async () => {
    getTab.mockResolvedValue({ id: 7, url: 'https://example.com/account' })
    getCookies.mockResolvedValue([
      {
        name: 'sid',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        secure: true,
        session: false,
        sameSite: 'lax',
      },
    ])
    removeCookie.mockResolvedValue({})

    const { createDispatcher } = await import('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/commands/dispatch.js')
    const mgr = {
      resolveTabId: vi.fn(() => 7),
      ensureAttached: vi.fn(async () => true),
      onCdpCommand: vi.fn(),
      get: vi.fn(() => ({ sessionId: 'main-session' })),
    }

    const dispatch = createDispatcher(mgr as any)
    const getResult = await dispatch({
      params: {
        method: 'Extension.getCookies',
        params: {},
      },
    })

    expect(getCookies).toHaveBeenCalledWith({ url: 'https://example.com/account' })
    expect(getResult).toEqual([
      {
        name: 'sid',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        expires: undefined,
        httpOnly: false,
        secure: true,
        sameSite: 'lax',
        session: false,
      },
    ])

    const clearResult = await dispatch({
      params: {
        method: 'Extension.clearCookies',
        params: {},
      },
    })

    expect(removeCookie).toHaveBeenCalledWith({
      url: 'https://example.com/',
      name: 'sid',
      storeId: undefined,
    })
    expect(clearResult).toEqual({ ok: true })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})
