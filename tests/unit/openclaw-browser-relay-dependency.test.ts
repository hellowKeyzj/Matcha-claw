import { describe, expect, it } from 'vitest'
import { loadPlaywrightCore, resolvePlaywrightImportSpecifier } from '../../packages/openclaw-browser-relay-plugin/src/playwright/dependency'

describe('browser relay playwright dependency', () => {
  it('converts the resolved playwright entry to a file url import specifier', () => {
    const specifier = resolvePlaywrightImportSpecifier()
    expect(specifier.startsWith('file://')).toBe(true)
    expect(specifier.includes('/playwright-core/index.mjs')).toBe(true)
  })

  it('loads playwright-core through exported openclaw entrypoints', async () => {
    const playwright = await loadPlaywrightCore()

    expect(playwright).toBeTruthy()
    expect(typeof playwright.chromium?.connectOverCDP).toBe('function')
  })
})
