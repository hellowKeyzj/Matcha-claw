import { describe, expect, it } from 'vitest'
import { loadPlaywrightCore } from '../../packages/openclaw-browser-relay-plugin/src/playwright/dependency'

describe('browser relay playwright dependency', () => {
  it('loads playwright-core through exported openclaw entrypoints', async () => {
    const playwright = await loadPlaywrightCore()

    expect(playwright).toBeTruthy()
    expect(typeof playwright.chromium?.connectOverCDP).toBe('function')
  })
})
