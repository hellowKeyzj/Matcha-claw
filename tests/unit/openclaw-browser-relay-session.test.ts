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
})
