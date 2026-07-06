#!/usr/bin/env bun
/**
 * Dev entrypoint — launches cli.tsx with MACRO.* defines injected
 * via Bun's -d flag (bunfig.toml [define] doesn't propagate to
 * dynamically imported modules at runtime).
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

type DevLaunchEnv = Record<string, string | undefined>

export type DevLaunchSpec = {
  command: string
  args: string[]
  env: DevLaunchEnv
}

type DevLaunchInput = {
  argv: string[]
  env: DevLaunchEnv
  bunExecutable: string
  cliPath: string
  defineArgs: string[]
  featureArgs: string[]
  inspectPort?: string
}

// Resolve project root from this script's location
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '..')
const cliPath = join(projectRoot, 'src/entrypoints/cli.tsx')

const defines = {
  ...getMacroDefines(),
  // React production mode — prevents 6,889+ _debugStack Error objects
  // (12MB) from accumulating during long-running sessions.
  // dev 模式使用 development 模式
  'process.env.NODE_ENV': JSON.stringify('production'),
}

const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
  '-d',
  `${k}:${v}`,
])

// Bun --feature flags: enable feature() gates at runtime.
// Uses the shared DEFAULT_BUILD_FEATURES list from defines.ts.

// Any env var matching FEATURE_<NAME>=1 will also enable that feature.
// e.g. FEATURE_PROACTIVE=1 bun run dev
const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith('FEATURE_'))
  .map(([k]) => k.replace('FEATURE_', ''))

const allFeatures = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]
const featureArgs = allFeatures.flatMap(name => ['--feature', name])

export function createDevLaunchSpec(input: DevLaunchInput): DevLaunchSpec {
  return {
    command: input.bunExecutable,
    args: [
      ...inspectArgs(input.inspectPort),
      'run',
      ...input.defineArgs,
      ...input.featureArgs,
      input.cliPath,
      ...argvWithAppServerWorkerArgs(input),
    ],
    env: { ...input.env },
  }
}

function argvWithAppServerWorkerArgs(input: DevLaunchInput): string[] {
  if (!isAppServerDevCommand(input.argv)) return input.argv
  if (hasExplicitWorkerArgs(input.argv, input.env)) return input.argv

  return [
    ...input.argv,
    '--',
    'run',
    ...input.defineArgs,
    ...input.featureArgs,
    input.cliPath,
    '--matcha-agent-worker-entry',
  ]
}

function isAppServerDevCommand(argv: string[]): boolean {
  return argv[0] === 'app-server'
}

function hasExplicitWorkerArgs(argv: string[], env: DevLaunchEnv): boolean {
  if (env.MATCHA_AGENT_APP_SERVER_WORKER_ARGS !== undefined) return true

  return argv.includes('--')
}

function inspectArgs(inspectPort: string | undefined): string[] {
  return inspectPort ? [`--inspect-wait=${inspectPort}`] : []
}

function main(): void {
  const launch = createDevLaunchSpec({
    argv: process.argv.slice(2),
    env: process.env,
    bunExecutable: process.execPath,
    cliPath,
    defineArgs,
    featureArgs,
    inspectPort: process.env.BUN_INSPECT,
  })

  const result = Bun.spawnSync([launch.command, ...launch.args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: projectRoot,
    env: launch.env,
  })

  process.exit(result.exitCode ?? 0)
}

if (import.meta.main) {
  main()
}
