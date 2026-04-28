import { describe, expect, it, vi } from 'vitest'
import { PlaywrightSession } from '../../packages/openclaw-browser-relay-plugin/src/playwright/session'

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

describe('browser relay session', () => {
  it('matches page strictly by target id', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: () => {},
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    const page = {
      url: () => 'https://clawhub.ai/',
      isClosed: () => false,
      mainFrame: () => ({
        url: () => 'https://clawhub.ai/',
      }),
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string) => {
            if (method === 'Target.getTargetInfo') {
              return {
                targetInfo: {
                  targetId: 'playwright-target-id',
                },
              }
            }
            if (method === 'Page.getFrameTree') {
              return {
                frameTree: {
                  frame: {
                    id: 'frame-1',
                    url: 'https://clawhub.ai/',
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
            throw new Error(`Unexpected method: ${method}`)
          },
          detach: async () => {},
        }),
      }),
    }

    ;(session as any).connectBrowser = async () => ({
      browser: {
        contexts: () => [
          {
            pages: () => [page],
          },
        ],
      },
    })

    const resolved = await session.getPageForTargetId({
      cdpUrl: 'http://127.0.0.1:9236',
      targetId: 'playwright-target-id',
      mode: 'relay',
    })

    expect(resolved).toBe(page)
  })

  it('requires targetId for page lookup', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: () => {},
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    await expect(session.getPageForTargetId({
      cdpUrl: 'http://127.0.0.1:9236',
      mode: 'relay',
    })).rejects.toThrow('targetId is required')
  })

  it('recovers when target id lookup fails before page target info is ready', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: () => {},
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    let lookupAttempts = 0
    const page = {
      url: () => 'https://clawhub.ai/',
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            lookupAttempts += 1
            if (lookupAttempts === 1) {
              throw new Error('target not ready')
            }
            return {
              targetInfo: {
                targetId: 'playwright-target-id',
              },
            }
          },
          detach: async () => {},
        }),
      }),
    }

    await expect((session as any).resolveTargetId(page)).resolves.toBeNull()
    await expect((session as any).resolveTargetId(page)).resolves.toBe('playwright-target-id')
    expect(lookupAttempts).toBe(2)
  })

  it('resolves page target id through a page CDP session instead of private delegate fields', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: () => {},
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    const page = {
      _delegate: {
        _targetId: 'wrong-target-id',
      },
      context: () => ({
        newCDPSession: async () => ({
          send: async () => ({
            targetInfo: {
              targetId: 'playwright-target-id',
            },
          }),
          detach: async () => {},
        }),
      }),
    }

    await expect(session.resolvePageTargetId(page)).resolves.toBe('playwright-target-id')
  })

  it('detaches temporary relay CDP sessions after resolving a page target id', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: () => {},
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    const detach = vi.fn(async () => {})
    const page = {
      url: () => 'https://clawhub.ai/',
      context: () => ({
        newCDPSession: async () => ({
          send: async () => ({
            targetInfo: {
              targetId: 'playwright-target-id',
            },
          }),
          detach,
        }),
      }),
    }

    await expect(session.resolvePageTargetId(page)).resolves.toBe('playwright-target-id')
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('cleans up page-local caches when a Playwright page closes without closing the tracked relay target', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: vi.fn(),
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    const listeners = new Map<string, (...args: any[]) => void>()
    const page = {
      url: () => '',
      mainFrame: () => ({
        url: () => '',
      }),
      on: (event: string, handler: (...args: any[]) => void) => {
        listeners.set(event, handler)
      },
    }

    ;(session as any).targetIdByPage.set(page, 'browser-a|tid|target-a')
    session.ensurePageState(page)

    listeners.get('close')?.()

    expect((session as any).pageState.has(page)).toBe(false)
    expect((session as any).pageStateInitialized.has(page)).toBe(false)
    expect((session as any).targetIdByPage.has(page)).toBe(false)
    expect(((session as any).tabState.closeTab as any)).not.toHaveBeenCalled()
  })

  it('rebuilds the relay Playwright projection once when the target page is missing', async () => {
    const session = new PlaywrightSession(
      logger as any,
      {
        closeTab: vi.fn(),
        agentTabCount: 0,
        retainedTabCount: 0,
      } as any,
      () => ({
        connected: true,
        relayPort: 9236,
        authHeaders: {},
      }),
    )

    const page = {
      url: () => 'https://example.com/',
      context: () => ({
        newCDPSession: async () => ({
          send: async () => ({
            targetInfo: {
              targetId: 'playwright-target-id',
            },
          }),
          detach: async () => {},
        }),
      }),
    }

    let generation = 0
    ;(session as any).connectBrowser = async () => ({
      browser: {
        contexts: () => [
          {
            pages: () => (generation === 0 ? [] : [page]),
          },
        ],
      },
    })

    const closeConnections = vi.fn(async (mode?: string) => {
      if (mode === 'relay') {
        generation = 1
      }
    })
    ;(session as any).closeConnections = closeConnections

    const resolved = await session.getPageForTargetId({
      cdpUrl: 'http://127.0.0.1:9236',
      targetId: 'playwright-target-id',
      mode: 'relay',
    })

    expect(resolved).toBe(page)
    expect(closeConnections).toHaveBeenCalledWith('relay')
  })
})
