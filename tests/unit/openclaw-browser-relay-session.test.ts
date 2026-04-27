import { describe, expect, it } from 'vitest'
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

    ;(session as any).resolveTargetId = async () => 'playwright-target-id'

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
})
