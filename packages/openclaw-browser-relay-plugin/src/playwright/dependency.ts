import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

let playwrightModulePromise: Promise<any> | null = null
const localRequire = createRequire(import.meta.url)

type PlaywrightPackageJson = {
  exports?: {
    '.':
      | string
      | {
        import?: string
        default?: string
      }
  }
}

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
      const packageDir = path.join(storeDir, entry, 'node_modules', 'playwright-core')
      if (fs.existsSync(packageDir)) {
        return packageDir
      }
    }
  }

  return null
}

function readPlaywrightImportEntry(packageDir: string): string {
  const packageJsonPath = path.join(packageDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PlaywrightPackageJson
  const rootExport = packageJson.exports?.['.']
  const importEntry =
    typeof rootExport === 'string'
      ? rootExport
      : typeof rootExport?.import === 'string'
        ? rootExport.import
        : typeof rootExport?.default === 'string'
          ? rootExport.default
          : './index.js'

  return path.resolve(packageDir, importEntry)
}

function resolvePlaywrightPackageDir(): string {
  const requireCandidates = [
    localRequire,
    resolveOpenClawRequire(),
    createRequire(`${process.cwd().replace(/\\/g, '/')}/package.json`),
  ]

  for (const currentRequire of requireCandidates) {
    try {
      return path.dirname(currentRequire.resolve('playwright-core/package.json'))
    } catch {
      // Try next resolution anchor.
    }
  }

  const virtualStorePackageDir = resolveFromPnpmVirtualStore()
  if (virtualStorePackageDir) {
    return virtualStorePackageDir
  }

  throw new Error(`Unable to resolve playwright-core from plugin runtime, OpenClaw runtime, or pnpm store (cwd=${process.cwd()})`)
}

export function resolvePlaywrightImportSpecifier(): string {
  return pathToFileURL(readPlaywrightImportEntry(resolvePlaywrightPackageDir())).href
}

function normalizePlaywrightRuntime(moduleNamespace: any): any {
  const runtime =
    typeof moduleNamespace?.chromium?.connectOverCDP === 'function'
      ? moduleNamespace
      : typeof moduleNamespace?.default?.chromium?.connectOverCDP === 'function'
        ? moduleNamespace.default
        : null

  if (!runtime) {
    throw new Error('Failed to load playwright runtime: missing chromium.connectOverCDP')
  }

  return runtime
}

export async function loadPlaywrightCore(): Promise<any> {
  if (playwrightModulePromise) {
    return await playwrightModulePromise
  }

  playwrightModulePromise = (async () => {
    return normalizePlaywrightRuntime(await import(resolvePlaywrightImportSpecifier()))
  })()

  return await playwrightModulePromise
}
