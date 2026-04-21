import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const BUILD_TARGETS = [
  {
    pluginId: 'task-manager',
    packageDir: 'packages/openclaw-task-manager-plugin',
    compileDirs: ['src'],
  },
  {
    pluginId: 'security-core',
    packageDir: 'packages/openclaw-security-plugin',
    compileDirs: ['src'],
  },
  {
    pluginId: 'browser-relay',
    packageDir: 'packages/openclaw-browser-relay-plugin',
    compileDirs: ['src'],
  },
  {
    pluginId: 'memory-lancedb-pro',
    packageDir: 'packages/memory-lancedb-pro',
    compileDirs: ['src'],
    compileFiles: ['index.ts', 'cli.ts'],
    preserveDirStructure: true,
  },
]

function replaceJsonImportSpecifiers(source) {
  return source
    .replace(/(from\s+['"])([^'"]+\.json)(['"])/g, '$1$2.js$3')
    .replace(/(import\s+['"])([^'"]+\.json)(['"])/g, '$1$2.js$3')
}

function createJsonModuleSource(rawJson) {
  return `export default ${rawJson.trim()}\n`
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listSourceFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath))
      continue
    }
    if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

function toAbsolutePath(packageDir, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.join(packageDir, targetPath)
}

async function collectCompileTargets(packageDir, {
  sourceDir,
  compileDirs,
  compileFiles,
  preserveDirStructure,
}) {
  const targets = new Map()
  const resolvedDirs = []

  if (sourceDir) {
    resolvedDirs.push(sourceDir)
  }
  for (const compileDir of compileDirs ?? []) {
    resolvedDirs.push(toAbsolutePath(packageDir, compileDir))
  }

  for (const dir of resolvedDirs) {
    if (!await pathExists(dir)) {
      throw new Error(`Missing plugin source directory: ${dir}`)
    }
    for (const sourceFile of await listSourceFiles(dir)) {
      const relativePath = preserveDirStructure
        ? path.relative(packageDir, sourceFile)
        : path.relative(dir, sourceFile)
      targets.set(sourceFile, relativePath)
    }
  }

  for (const compileFile of compileFiles ?? []) {
    const absoluteFile = toAbsolutePath(packageDir, compileFile)
    if (!await pathExists(absoluteFile)) {
      throw new Error(`Missing plugin source file: ${absoluteFile}`)
    }
    targets.set(absoluteFile, path.relative(packageDir, absoluteFile))
  }

  return [...targets.entries()].map(([sourceFile, relativePath]) => ({ sourceFile, relativePath }))
}

export async function buildLocalPluginArtifacts({
  packageDir,
  sourceDir = path.join(packageDir, 'src'),
  distDir = path.join(packageDir, 'dist'),
  compileDirs,
  compileFiles,
  preserveDirStructure = false,
}) {
  await fs.rm(distDir, { recursive: true, force: true })
  await fs.mkdir(distDir, { recursive: true })

  const sourceFiles = await collectCompileTargets(packageDir, {
    sourceDir,
    compileDirs,
    compileFiles,
    preserveDirStructure,
  })

  for (const { sourceFile, relativePath } of sourceFiles) {
    const extname = path.extname(sourceFile)
    const outputPath = path.join(
      distDir,
      extname === '.ts' ? relativePath.replace(/\.ts$/i, '.js') : relativePath,
    )

    if (extname === '.ts') {
      const source = await fs.readFile(sourceFile, 'utf8')
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          resolveJsonModule: true,
          isolatedModules: true,
          esModuleInterop: true,
        },
        fileName: sourceFile,
      })
      await ensureParentDir(outputPath)
      await fs.writeFile(outputPath, replaceJsonImportSpecifiers(transpiled.outputText), 'utf8')
      continue
    }

    await ensureParentDir(outputPath)
    await fs.copyFile(sourceFile, outputPath)

    if (extname === '.json') {
      const rawJson = await fs.readFile(sourceFile, 'utf8')
      await fs.writeFile(`${outputPath}.js`, createJsonModuleSource(rawJson), 'utf8')
    }
  }
}

export async function buildManagedOpenClawPlugins({
  rootDir,
  pluginIds,
} = {}) {
  const selectedTargets = BUILD_TARGETS.filter((target) => !pluginIds || pluginIds.includes(target.pluginId))

  for (const target of selectedTargets) {
    await buildLocalPluginArtifacts({
      packageDir: path.join(rootDir ?? process.cwd(), target.packageDir),
      ...(Array.isArray(target.compileDirs) ? { compileDirs: target.compileDirs } : {}),
      ...(Array.isArray(target.compileFiles) ? { compileFiles: target.compileFiles } : {}),
      ...(target.preserveDirStructure === true ? { preserveDirStructure: true } : {}),
    })
  }
}

export const LOCAL_OPENCLAW_PLUGIN_BUILD_TARGETS = BUILD_TARGETS
