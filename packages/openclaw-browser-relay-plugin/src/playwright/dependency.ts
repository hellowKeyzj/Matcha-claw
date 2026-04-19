import { createRequire } from 'node:module'

let playwrightModulePromise: Promise<any> | null = null

export async function loadPlaywrightCore(): Promise<any> {
  if (playwrightModulePromise) {
    return await playwrightModulePromise
  }

  playwrightModulePromise = (async () => {
    const openClawRequire = createRequire(require.resolve('openclaw/package.json'))
    const playwrightEntry = openClawRequire.resolve('playwright-core')
    return await import(playwrightEntry)
  })()

  return await playwrightModulePromise
}
