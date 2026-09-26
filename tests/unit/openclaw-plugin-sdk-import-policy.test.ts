import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractImportSpecifiers,
  findOpenClawPluginSdkImportIssues,
  formatOpenClawPluginSdkImportIssue,
} from '../../scripts/lib/openclaw-plugin-sdk-import-policy.mjs'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)
const REQUIRED_MIRRORS = [
  ['qianfan', 'qianfan'],
  ['stepfun', 'stepfun'],
  ['tencent', 'tencent'],
  ['xiaomi', 'xiaomi'],
  ['qwen', 'qwen'],
  ['kimi', 'kimi'],
  ['volcengine', 'volcengine'],
  ['opencode', 'opencode'],
  ['task-manager', 'task-manager'],
  ['security-core', 'security-core'],
  ['browser-relay', 'browser-relay'],
  ['memory-lancedb-pro', 'memory-lancedb-pro'],
  ['dingtalk', 'dingtalk'],
  ['wecom', 'wecom-openclaw-plugin'],
  ['openclaw-weixin', 'openclaw-weixin'],
  ['qqbot', 'qqbot'],
  ['openclaw-lark', 'openclaw-lark'],
  ['matchaclaw-media', 'matchaclaw-media'],
] as const

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

async function createRequiredLocalPlugin(
  rootDir: string,
  packageName: string,
  pluginId: string,
  sourceEntries = ['./src/index.ts'],
  entrySource = "import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'\n",
): Promise<void> {
  const pluginDir = path.join(rootDir, 'packages', packageName)
  const runtimeEntry = pluginId === 'openclaw-lark' ? './dist/index.mjs' : './dist/index.js'
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  await writeFile(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: pluginId }), 'utf8')
  await writeFile(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ openclaw: { extensions: [runtimeEntry] }, dependencies: {} }),
    'utf8',
  )
  await writeFile(path.join(pluginDir, runtimeEntry), 'export {}\n', 'utf8')

  for (const sourceEntry of sourceEntries) {
    const sourcePath = path.join(pluginDir, sourceEntry)
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, sourceEntry.endsWith('index.ts') ? entrySource : 'export {}\n', 'utf8')
  }
}

async function createRequiredMirror(rootDir: string, dir: string, pluginId: string): Promise<void> {
  const mirrorDir = path.join(rootDir, 'build', 'openclaw-plugins', dir)
  const runtimeEntry = pluginId === 'openclaw-lark' ? './dist/index.mjs' : './dist/index.js'
  await mkdir(path.join(mirrorDir, 'dist'), { recursive: true })
  await writeFile(path.join(mirrorDir, 'openclaw.plugin.json'), JSON.stringify({ id: pluginId }), 'utf8')
  await writeFile(
    path.join(mirrorDir, 'package.json'),
    JSON.stringify({ openclaw: { extensions: [runtimeEntry] }, dependencies: {} }),
    'utf8',
  )
  await writeFile(path.join(mirrorDir, runtimeEntry), 'export {}\n', 'utf8')
  if (dir === 'openclaw-lark') {
    await mkdir(path.join(mirrorDir, 'skills'), { recursive: true })
    for (const filePath of ['dist/secret-contract-api.mjs', 'dist/config-schema.mjs', 'secret-contract-api.js', 'LICENSE']) {
      await writeFile(path.join(mirrorDir, filePath), 'export {}\n', 'utf8')
    }
  }
  if (dir === 'tencent') {
    await writeFile(path.join(mirrorDir, 'dist', 'setup-api.js'), 'export {}\n', 'utf8')
  }

  if (dir === 'memory-lancedb-pro') {
    for (const filePath of [
      'models/Xenova/all-MiniLM-L6-v2/config.json',
      'models/Xenova/all-MiniLM-L6-v2/tokenizer.json',
      'models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
      'models/Xenova/all-MiniLM-L6-v2/onnx/model.onnx',
    ]) {
      const targetPath = path.join(mirrorDir, filePath)
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, '{}\n', 'utf8')
    }
  }
}

describe('openclaw plugin SDK import policy', () => {
  it('extracts static, dynamic, re-export, and require specifiers', () => {
    expect(extractImportSpecifiers([
      "import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'",
      "import type { PluginLogger } from 'openclaw/plugin-sdk'",
      "export { compat } from 'openclaw/plugin-sdk/compat'",
      "const sdk = await import('openclaw/plugin-sdk/provider-http')",
      "const ext = require('openclaw/extension-api')",
      "// import ignored from 'openclaw/plugin-sdk/provider-auth-runtime'",
    ].join('\n'))).toEqual([
      'openclaw/plugin-sdk/plugin-entry',
      'openclaw/plugin-sdk',
      'openclaw/plugin-sdk/compat',
      'openclaw/plugin-sdk/provider-http',
      'openclaw/extension-api',
    ])
  })

  it('reports forbidden SDK imports with file and specifier while skipping node_modules and dist directories', async () => {
    const rootDir = await createTempDir('openclaw-plugin-sdk-policy-')
    const srcDir = path.join(rootDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await mkdir(path.join(rootDir, 'node_modules', 'bad'), { recursive: true })
    await mkdir(path.join(rootDir, 'dist'), { recursive: true })

    await writeFile(path.join(srcDir, 'index.ts'), [
      "import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'",
      "import type { PluginLogger } from 'openclaw/plugin-sdk'",
      "import { compat } from 'openclaw/plugin-sdk/compat/runtime'",
      "import { fetchWithTimeoutGuarded } from 'openclaw/plugin-sdk/provider-http'",
      "import type { PinnedDispatcherPolicy } from 'openclaw/plugin-sdk/ssrf-dispatcher'",
      "const auth = await import('openclaw/plugin-sdk/provider-auth-runtime')",
      "export { createExtension } from 'openclaw/extension-api/runtime'",
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(rootDir, 'node_modules', 'bad', 'index.js'), "import x from 'openclaw/plugin-sdk'\n", 'utf8')
    await writeFile(path.join(rootDir, 'dist', 'index.js'), "import x from 'openclaw/plugin-sdk'\n", 'utf8')

    const issues = await findOpenClawPluginSdkImportIssues({ dirs: [rootDir] })
    expect(issues.map((issue) => issue.specifier)).toEqual([
      'openclaw/plugin-sdk',
      'openclaw/plugin-sdk/compat/runtime',
      'openclaw/plugin-sdk/provider-http',
      'openclaw/plugin-sdk/ssrf-dispatcher',
      'openclaw/plugin-sdk/provider-auth-runtime',
      'openclaw/extension-api/runtime',
    ])
    expect(formatOpenClawPluginSdkImportIssue(issues[0], rootDir)).toBe(
      '禁止使用 openclaw/plugin-sdk root import: src/index.ts -> openclaw/plugin-sdk',
    )
  })

  it('checks explicit build mirror entry files even when they live under dist', async () => {
    const rootDir = await createTempDir('openclaw-plugin-sdk-policy-')
    const entryPath = path.join(rootDir, 'dist', 'index.js')
    await mkdir(path.dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "import x from 'openclaw/plugin-sdk/compat'\n", 'utf8')

    const issues = await findOpenClawPluginSdkImportIssues({ files: [entryPath] })
    expect(issues.map((issue) => issue.specifier)).toEqual(['openclaw/plugin-sdk/compat'])
  })

  it('fails plugin input check with file and specifier details', async () => {
    const rootDir = await createTempDir('openclaw-plugin-input-check-')
    const pluginDir = path.join(rootDir, 'packages', 'openclaw-task-manager-plugin')
    await createRequiredLocalPlugin(rootDir, 'openclaw-security-plugin', 'security-core')
    await createRequiredLocalPlugin(rootDir, 'openclaw-browser-relay-plugin', 'browser-relay')
    await createRequiredLocalPlugin(rootDir, 'memory-lancedb-pro', 'memory-lancedb-pro', ['./index.ts', './cli.ts', './src/embedder.ts'])
    await createRequiredLocalPlugin(rootDir, 'openclaw-matchaclaw-media-plugin', 'matchaclaw-media')
    await createRequiredLocalPlugin(rootDir, 'openclaw-lark', 'openclaw-lark', ['./index.ts', './secret-contract-api.ts', './src/core/config-schema.ts', './secret-contract-api.js'])
    await createRequiredLocalPlugin(rootDir, 'openclaw-task-manager-plugin', 'task-manager', ['./src/index.ts'], [
      "import type { PluginLogger } from 'openclaw/plugin-sdk'",
      "export { compat } from 'openclaw/plugin-sdk/compat'",
      '',
    ].join('\n'))
    await writeFile(path.join(pluginDir, 'dist', 'ignored.js'), "import x from 'openclaw/plugin-sdk'\n", 'utf8')
    await mkdir(path.join(pluginDir, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(path.join(pluginDir, 'node_modules', 'ignored', 'index.js'), "import x from 'openclaw/plugin-sdk'\n", 'utf8')

    await expect(execFileAsync(process.execPath, [path.join(process.cwd(), 'scripts/check-openclaw-plugin-inputs.mjs')], { cwd: rootDir }))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('packages/openclaw-task-manager-plugin/src/index.ts -> openclaw/plugin-sdk'),
      })
  })

  it('fails first-party plugin mirror check with file and specifier details', async () => {
    const rootDir = await createTempDir('openclaw-plugin-mirror-check-')
    for (const [dir, pluginId] of REQUIRED_MIRRORS) {
      await createRequiredMirror(rootDir, dir, pluginId)
    }
    const mirrorDir = path.join(rootDir, 'build', 'openclaw-plugins', 'task-manager')
    await writeFile(path.join(mirrorDir, 'dist', 'index.js'), "import x from 'openclaw/extension-api/runtime'\n", 'utf8')
    await mkdir(path.join(mirrorDir, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(path.join(mirrorDir, 'node_modules', 'ignored', 'index.js'), "import x from 'openclaw/plugin-sdk'\n", 'utf8')

    await expect(execFileAsync(process.execPath, [path.join(process.cwd(), 'scripts/check-openclaw-plugin-mirrors.mjs')], { cwd: rootDir }))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('build/openclaw-plugins/task-manager/dist/index.js -> openclaw/extension-api/runtime'),
      })
  })

  it('enforces SDK import policy on the Feishu plugin mirror entry', async () => {
    const rootDir = await createTempDir('openclaw-plugin-mirror-check-')
    for (const [dir, pluginId] of REQUIRED_MIRRORS) {
      await createRequiredMirror(rootDir, dir, pluginId)
    }
    const mirrorDir = path.join(rootDir, 'build', 'openclaw-plugins', 'openclaw-lark')
    const checker = path.join(process.cwd(), 'scripts/check-openclaw-plugin-mirrors.mjs')
    await expect(execFileAsync(process.execPath, [checker], { cwd: rootDir })).resolves.toMatchObject({ stderr: '' })
    await writeFile(path.join(mirrorDir, 'dist', 'index.mjs'), "import type { PluginLogger } from 'openclaw/plugin-sdk'\n", 'utf8')

    await expect(execFileAsync(process.execPath, [checker], { cwd: rootDir }))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('build/openclaw-plugins/openclaw-lark/dist/index.mjs -> openclaw/plugin-sdk'),
      })

    await writeFile(path.join(mirrorDir, 'dist', 'index.mjs'), 'export {}\n', 'utf8')
    for (const filePath of ['dist/index.mjs', 'dist/secret-contract-api.mjs', 'dist/config-schema.mjs', 'secret-contract-api.js', 'skills', 'LICENSE']) {
      await rm(path.join(mirrorDir, filePath), { recursive: true, force: true })
      await expect(execFileAsync(process.execPath, [checker], { cwd: rootDir }))
        .rejects.toMatchObject({
          stderr: expect.stringContaining(`build 插件资源缺失: openclaw-lark -> ${filePath}`),
        })
      await createRequiredMirror(rootDir, 'openclaw-lark', 'openclaw-lark')
    }
  })
})
