import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

let playwrightModulePromise: Promise<any> | null = null
const localRequire = createRequire(import.meta.url)

function resolveOpenClawRequire() {
  const entryCandidates = [
    'openclaw/plugin-sdk',
    'openclaw',
  ]

  for (const candidate of entryCandidates) {
    try {
      return createRequire(localRequire.resolve(candidate))
    } catch {
      // Try the next exported OpenClaw entry.
    }
  }

  // MatchaClaw starts Gateway with cwd pointing at the bundled OpenClaw package.
  return createRequire(`${process.cwd().replace(/\\/g, '/')}/package.json`)
}

function resolvePreferredPlaywrightVersion(): string | null {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
    }
    return packageJson.dependencies?.['playwright-core'] ?? null
  } catch {
    return null
  }
}

function resolveFromPnpmVirtualStore(): string | null {
  const candidateStores = [
    path.join(process.cwd(), '..', '.pnpm'),
    path.join(process.cwd(), 'node_modules', '.pnpm'),
  ]
  const preferredVersion = resolvePreferredPlaywrightVersion()

  for (const storeDir of candidateStores) {
    if (!fs.existsSync(storeDir)) {
      continue
    }

    const entries = fs.readdirSync(storeDir)
      .filter((entry) => entry.startsWith('playwright-core@'))
      .sort((left, right) => {
        const leftPreferred = preferredVersion && left.startsWith(`playwright-core@${preferredVersion}`)
        const rightPreferred = preferredVersion && right.startsWith(`playwright-core@${preferredVersion}`)
        if (leftPreferred && !rightPreferred) return -1
        if (!leftPreferred && rightPreferred) return 1
        return right.localeCompare(left)
      })

    for (const entry of entries) {
      const entryPath = path.join(storeDir, entry, 'node_modules', 'playwright-core', 'index.js')
      if (fs.existsSync(entryPath)) {
        return entryPath
      }
    }
  }

  return null
}

function resolvePlaywrightEntry(): string {
  const requireCandidates = [
    localRequire,
    resolveOpenClawRequire(),
    createRequire(`${process.cwd().replace(/\\/g, '/')}/package.json`),
  ]

  for (const currentRequire of requireCandidates) {
    try {
      return currentRequire.resolve('playwright-core')
    } catch {
      // Try next resolution anchor.
    }
  }

  const virtualStoreEntry = resolveFromPnpmVirtualStore()
  if (virtualStoreEntry) {
    return virtualStoreEntry
  }

  throw new Error(`Unable to resolve playwright-core from plugin runtime, OpenClaw runtime, or pnpm store (cwd=${process.cwd()})`)
}

export async function loadPlaywrightCore(): Promise<any> {
  if (playwrightModulePromise) {
    return await playwrightModulePromise
  }

  playwrightModulePromise = (async () => {
    const playwrightEntry = resolvePlaywrightEntry()
    return await import(playwrightEntry)
  })()

  return await playwrightModulePromise
}
