import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCreateTarget = vi.fn()
const cdpCloseTarget = vi.fn()
const cdpCloseAllAgentTabs = vi.fn()
const cdpActivateTarget = vi.fn()
const sendCommand = vi.fn()

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/commands/target-ops.js', () => ({
  createTargetOps: () => ({
    cdpCreateTarget,
    cdpCloseTarget,
    cdpCloseAllAgentTabs,
    cdpActivateTarget,
  }),
}))

vi.mock('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/content_script/extension-ops.js', () => ({
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
    }
  })

  it('routes Runtime.enable through the addressed child session instead of always using the root tab session', async () => {
    sendCommand.mockResolvedValue({})

    const { createDispatcher } = await import('../../resources/tools/data/extension/chrome-extension/accio-browser-relay/lib/cdp/commands/dispatch.js')
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
})
