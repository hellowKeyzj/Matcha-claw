import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map(async (dir) => {
    await rm(dir, { recursive: true, force: true })
  }))
})

describe('openclaw local plugin builder', () => {
  it('编译 dist 时同时保留 JSON 导入与相对路径资源可用', async () => {
    const workspaceDir = await createTempDir('openclaw-local-plugin-builder-')
    const packageDir = path.join(workspaceDir, 'plugin')
    const sourceDir = path.join(packageDir, 'src')
    const distDir = path.join(packageDir, 'dist')

    await mkdir(path.join(sourceDir, 'nested', 'assets'), { recursive: true })
    await writeFile(path.join(sourceDir, 'rules.json'), JSON.stringify({ mode: 'strict' }), 'utf8')
    await writeFile(path.join(sourceDir, 'nested', 'assets', 'message.txt'), 'hello plugin', 'utf8')
    await writeFile(
      path.join(sourceDir, 'nested', 'loader.ts'),
      [
        "import { readFileSync } from 'node:fs'",
        "import path from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        '',
        'const __filename = fileURLToPath(import.meta.url)',
        'const __dirname = path.dirname(__filename)',
        '',
        'export function loadMessage(): string {',
        "  return readFileSync(path.resolve(__dirname, './assets/message.txt'), 'utf8').trim()",
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(sourceDir, 'index.ts'),
      [
        "import rules from './rules.json'",
        "import { loadMessage } from './nested/loader.js'",
        '',
        'export function readBuiltRuntime(): string {',
        "  return `${rules.mode}:${loadMessage()}`",
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const { buildLocalPluginArtifacts } = await import('../../scripts/lib/openclaw-local-plugin-builder.mjs')

    await buildLocalPluginArtifacts({
      packageDir,
      sourceDir,
      distDir,
    })

    const entryPath = path.join(distDir, 'index.js')
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)}); console.log(mod.readBuiltRuntime())`,
      ],
      { cwd: workspaceDir },
    )
    expect(stdout.trim()).toBe('strict:hello plugin')

    expect(await readFile(path.join(distDir, 'rules.json'), 'utf8')).toContain('"mode":"strict"')
    expect(await readFile(path.join(distDir, 'rules.json.js'), 'utf8')).toContain('export default')
    expect(await readFile(path.join(distDir, 'nested', 'assets', 'message.txt'), 'utf8')).toBe('hello plugin')
  })

  it('支持根入口文件与 src 目录一起编译，并保留包根路径解析', async () => {
    const workspaceDir = await createTempDir('openclaw-local-plugin-builder-')
    const packageDir = path.join(workspaceDir, 'plugin')
    const sourceDir = path.join(packageDir, 'src')
    const distDir = path.join(packageDir, 'dist')

    await mkdir(path.join(sourceDir), { recursive: true })
    await mkdir(path.join(packageDir, 'models'), { recursive: true })
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8')
    await writeFile(path.join(packageDir, 'models', 'info.txt'), 'model-ready', 'utf8')
    await writeFile(
      path.join(sourceDir, 'runtime-paths.ts'),
      [
        "import { readFileSync } from 'node:fs'",
        "import { dirname, basename, join } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        '',
        'export function getPluginPackageRoot(metaUrl: string): string {',
        '  const moduleDir = dirname(fileURLToPath(metaUrl))',
        '  if (basename(moduleDir) === "dist") return dirname(moduleDir)',
        '  const parentDir = dirname(moduleDir)',
        '  if (basename(parentDir) === "dist") return dirname(parentDir)',
        '  return parentDir',
        '}',
        '',
        'export function readPluginPackageVersion(metaUrl: string): string {',
        '  return JSON.parse(readFileSync(join(getPluginPackageRoot(metaUrl), "package.json"), "utf8")).version',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(sourceDir, 'embedder.ts'),
      [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { getPluginPackageRoot } from './runtime-paths.js'",
        '',
        'export function readModelInfo(): string {',
        '  return readFileSync(join(getPluginPackageRoot(import.meta.url), "models", "info.txt"), "utf8").trim()',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(packageDir, 'cli.ts'),
      [
        "import { readPluginPackageVersion } from './src/runtime-paths.js'",
        '',
        'export function readVersion(): string {',
        '  return readPluginPackageVersion(import.meta.url)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(packageDir, 'index.ts'),
      [
        "import { readVersion } from './cli.js'",
        "import { readModelInfo } from './src/embedder.js'",
        '',
        'export function readBuiltPackage(): string {',
        '  return `${readVersion()}:${readModelInfo()}`',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const { buildLocalPluginArtifacts } = await import('../../scripts/lib/openclaw-local-plugin-builder.mjs')

    await buildLocalPluginArtifacts({
      packageDir,
      distDir,
      compileDirs: ['src'],
      compileFiles: ['index.ts', 'cli.ts'],
      preserveDirStructure: true,
    })

    const entryPath = path.join(distDir, 'index.js')
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)}); console.log(mod.readBuiltPackage())`,
      ],
      { cwd: workspaceDir },
    )
    expect(stdout.trim()).toBe('1.2.3:model-ready')
  })
})
