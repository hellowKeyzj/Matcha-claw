import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendCommand = vi.fn()
const tabsCreate = vi.fn()
const tabsGet = vi.fn()
const tabsUpdate = vi.fn()
const tabsRemove = vi.fn()
const windowsCreate = vi.fn()
const windowsGet = vi.fn()
const windowsUpdate = vi.fn()

describe('accio browser relay target ops', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    tabsUpdate.mockResolvedValue({})
    windowsUpdate.mockResolvedValue({})

    ;(globalThis as any).chrome = {
      tabs: {
        create: tabsCreate,
        get: tabsGet,
        update: tabsUpdate,
        remove: tabsRemove,
      },
      windows: {
        create: windowsCreate,
        get: windowsGet,
        update: windowsUpdate,
      },
      debugger: {
        sendCommand,
      },
    }
  })

  it('creates a tab, navigates it in the attached page session, and returns the attached target without a second-stage open', async () => {
    windowsGet.mockResolvedValue({ id: 9 })
    tabsCreate.mockResolvedValue({
      id: 123,
      windowId: 9,
      url: 'about:blank',
    })
    tabsGet.mockResolvedValue({
      id: 123,
      windowId: 9,
      active: false,
      title: 'Opened Page',
      url: 'https://example.com/',
    })
    sendCommand.mockImplementation(async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: {
              id: 'main-frame',
              url: 'https://example.com/',
            },
          },
        }
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: 'complete',
          },
        }
      }
      if (method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            targetId: 'real-target-id',
          },
        }
      }
      if (method === 'Page.navigate') {
        expect(params).toEqual({ url: 'https://example.com' })
      }
      return {}
    })

    const { createTargetOps } = await import('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/commands/target-ops.js')
    const mgr = {
      retainedTabCount: 0,
      markAgent: vi.fn(),
      selectedWindowId: 9,
      attach: vi.fn(async () => ({
        sessionId: 'cb-tab:browser-a:123',
        targetId: 'real-target-id',
      })),
      get: vi.fn(() => ({
        sessionId: 'cb-tab:browser-a:123',
        targetId: 'real-target-id',
        windowId: 9,
        active: false,
        title: 'Opened Page',
        url: 'about:blank',
      })),
      setActiveTab: vi.fn(),
      announceCurrentTarget: vi.fn(),
      updateTab: vi.fn(),
    }

    const { cdpCreateTarget } = createTargetOps(mgr as any)
    const result = await cdpCreateTarget({ url: 'https://example.com' })

    expect(tabsCreate).toHaveBeenCalledWith({ url: 'about:blank', active: false, windowId: 9 })
    expect(mgr.attach).toHaveBeenCalledWith(123, { manual: true })
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 123 }, 'Page.navigate', { url: 'https://example.com' })
    expect(tabsUpdate).toHaveBeenCalledWith(123, { active: true })
    expect(windowsUpdate).toHaveBeenCalledWith(9, { focused: true })
    expect(mgr.setActiveTab).toHaveBeenCalledWith(123, 9)
    expect(mgr.announceCurrentTarget).toHaveBeenCalledWith(123)
    expect(mgr.updateTab).toHaveBeenLastCalledWith(123, 'https://example.com/', 'Opened Page', {
      windowId: 9,
      active: true,
    })
    expect(result).toEqual({
      targetId: 'real-target-id',
      retained: false,
    })
  })

  it('falls back to an unscoped tab create when the selected window no longer exists', async () => {
    windowsGet.mockRejectedValue(new Error('No window with id: 9'))
    tabsCreate.mockResolvedValue({
      id: 456,
      windowId: 12,
      url: 'about:blank',
    })
    tabsGet.mockResolvedValue({
      id: 456,
      windowId: 12,
      active: false,
      title: 'Opened Page',
      url: 'https://example.com/fallback',
    })
    sendCommand.mockImplementation(async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: {
              id: 'main-frame',
              url: 'https://example.com/fallback',
            },
          },
        }
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: 'complete',
          },
        }
      }
      if (method === 'Page.navigate') {
        expect(params).toEqual({ url: 'https://example.com/fallback' })
      }
      return {}
    })

    const { createTargetOps } = await import('../../resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/commands/target-ops.js')
    const mgr = {
      retainedTabCount: 0,
      markAgent: vi.fn(),
      selectedWindowId: 9,
      attach: vi.fn(async () => ({
        sessionId: 'cb-tab:browser-a:456',
        targetId: 'fallback-target-id',
      })),
      get: vi.fn(() => ({
        sessionId: 'cb-tab:browser-a:456',
        targetId: 'fallback-target-id',
        windowId: 12,
        active: false,
        title: 'Opened Page',
        url: 'about:blank',
      })),
      setActiveTab: vi.fn(),
      announceCurrentTarget: vi.fn(),
      updateTab: vi.fn(),
    }

    const { cdpCreateTarget } = createTargetOps(mgr as any)
    const result = await cdpCreateTarget({ url: 'https://example.com/fallback' })

    expect(tabsCreate).toHaveBeenCalledWith({ url: 'about:blank', active: false })
    expect(windowsUpdate).toHaveBeenCalledWith(12, { focused: true })
    expect(mgr.setActiveTab).toHaveBeenCalledWith(456, 12)
    expect(result).toEqual({
      targetId: 'fallback-target-id',
      retained: false,
    })
  })
})
