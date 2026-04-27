import { describe, expect, it, vi } from 'vitest'
import { PlaywrightActions } from '../../packages/openclaw-browser-relay-plugin/src/playwright/actions'

describe('browser relay actions', () => {
  it('retries navigation once after the first page frame is detached', async () => {
    const firstPage = {
      goto: vi.fn(async () => {
        throw new Error('page.goto: Frame has been detached.')
      }),
      url: () => '',
    }

    const secondPage = {
      goto: vi.fn(async () => {}),
      url: () => 'https://example.com/',
    }

    const session = {
      getPageForTargetId: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
      closeConnections: vi.fn(async () => {}),
      ensurePageState: vi.fn(),
      logPageSnapshot: vi.fn(),
    }

    const actions = new PlaywrightActions(session as any)
    const result = await actions.navigate({
      cdpUrl: 'http://127.0.0.1:9236',
      targetId: 'playwright-target-id',
      mode: 'relay',
      url: 'https://example.com',
    })

    expect(session.getPageForTargetId).toHaveBeenCalledTimes(2)
    expect(session.closeConnections).toHaveBeenCalledWith('relay')
    expect(firstPage.goto).toHaveBeenCalledTimes(1)
    expect(secondPage.goto).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ url: 'https://example.com/' })
  })
})
