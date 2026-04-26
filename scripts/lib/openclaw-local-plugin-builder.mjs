import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const BUILD_TARGETS = [
  {
    pluginId: 'task-manager',
    packageDir: 'packages/openclaw-task-manager-plugin',
    compileDirs: ['src'],
    runtimeFiles: ['package.json', 'openclaw.plugin.json', 'dist'],
  },
  {
    pluginId: 'security-core',
    packageDir: 'packages/openclaw-security-plugin',
    compileDirs: ['src'],
    runtimeFiles: ['package.json', 'openclaw.plugin.json', 'dist'],
  },
  {
    pluginId: 'browser-relay',
    packageDir: 'packages/openclaw-browser-relay-plugin',
    compileDirs: ['src'],
    runtimeFiles: ['package.json', 'openclaw.plugin.json', 'dist'],
  },
  {
    pluginId: 'memory-lancedb-pro',
    packageDir: 'packages/memory-lancedb-pro',
    compileDirs: ['src'],
    compileFiles: ['index.ts', 'cli.ts'],
    preserveDirStructure: true,
    runtimeFiles: ['package.json', 'openclaw.plugin.json', 'dist', 'models', 'skills'],
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

function readJson(filePath) {
  return JSON.parse(fsSync.readFileSync(filePath, 'utf8'))
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

function createSkipPackages(packageJson) {
  const skipPackages = new Set(['typescript', '@playwright/test'])
  for (const peerDependency of Object.keys(packageJson?.peerDependencies ?? {})) {
    skipPackages.add(peerDependency)
  }
  return skipPackages
}

function getRuntimeDependencyNames(packageJson) {
  return Object.keys(packageJson?.dependencies ?? {})
}

function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') {
      return dir
    }
    dir = path.dirname(dir)
  }
  return null
}

function resolveInstalledPackagePath(packageName, nodeModulesDirs) {
  for (const nodeModulesDir of nodeModulesDirs) {
    const packagePath = path.join(nodeModulesDir, ...packageName.split('/'))
    if (fsSync.existsSync(packagePath)) {
      return packagePath
    }
  }
  return null
}

function listPackages(nodeModulesDir) {
  const packages = []
  if (!fsSync.existsSync(nodeModulesDir)) {
    return packages
  }

  for (const entry of fsSync.readdirSync(nodeModulesDir)) {
    if (entry === '.bin') {
      continue
    }
    const entryPath = path.join(nodeModulesDir, entry)
    if (entry.startsWith('@')) {
      if (!fsSync.existsSync(entryPath)) {
        continue
      }
      for (const scopedEntry of fsSync.readdirSync(entryPath)) {
        packages.push({
          name: `${entry}/${scopedEntry}`,
          fullPath: path.join(entryPath, scopedEntry),
        })
      }
      continue
    }
    packages.push({ name: entry, fullPath: entryPath })
  }

  return packages
}

function collectTransitiveDepsFromPackageNames(packageNames, skipPackages, nodeModulesDirs) {
  const collected = new Map()
  const queue = []
  const skipScopes = ['@types/']

  for (const packageName of packageNames) {
    if (!packageName || skipPackages.has(packageName) || skipScopes.some((scope) => packageName.startsWith(scope))) {
      continue
    }

    const packagePath = resolveInstalledPackagePath(packageName, nodeModulesDirs)
    if (!packagePath) {
      throw new Error(`Missing dependency "${packageName}" in local plugin runtime node_modules.`)
    }

    const realPath = fsSync.realpathSync(packagePath)
    if (collected.has(realPath)) {
      continue
    }

    collected.set(realPath, packageName)
    const virtualNodeModules = getVirtualStoreNodeModules(realPath)
    if (virtualNodeModules) {
      queue.push({ nodeModulesDir: virtualNodeModules, skipPkg: packageName })
    }
  }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift()
    for (const { name, fullPath } of listPackages(nodeModulesDir)) {
      if (name === skipPkg) {
        continue
      }
      if (skipPackages.has(name) || skipScopes.some((scope) => name.startsWith(scope))) {
        continue
      }

      let realPath
      try {
        realPath = fsSync.realpathSync(fullPath)
      } catch {
        continue
      }
      if (collected.has(realPath)) {
        continue
      }

      collected.set(realPath, name)
      const depVirtualNodeModules = getVirtualStoreNodeModules(realPath)
      if (depVirtualNodeModules && depVirtualNodeModules !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNodeModules, skipPkg: name })
      }
    }
  }

  return collected
}

function copyFlattenedDeps(outputDir, collected) {
  const outputNodeModules = path.join(outputDir, 'node_modules')
  fsSync.mkdirSync(outputNodeModules, { recursive: true })

  for (const [realPath, packageName] of collected) {
    const destination = path.join(outputNodeModules, packageName)
    fsSync.mkdirSync(path.dirname(destination), { recursive: true })
    fsSync.cpSync(realPath, destination, { recursive: true, dereference: true })
  }
}

async function copyRuntimeFiles(sourceDir, outputDir, runtimeFiles) {
  for (const relativePath of runtimeFiles) {
    const sourcePath = path.join(sourceDir, relativePath)
    if (!await pathExists(sourcePath)) {
      throw new Error(`Missing runtime file "${relativePath}" in local plugin "${sourceDir}".`)
    }
    const destinationPath = path.join(outputDir, relativePath)
    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true })
  }
}

async function refreshManagedPluginMirror({ rootDir, target }) {
  const packageDir = path.join(rootDir, target.packageDir)
  const outputDir = path.join(rootDir, 'build', 'openclaw-plugins', target.pluginId)

  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(outputDir, { recursive: true })
  await copyRuntimeFiles(packageDir, outputDir, target.runtimeFiles)

  const pluginPackageJson = readJson(path.join(outputDir, 'package.json'))
  const runtimeDependencyNames = getRuntimeDependencyNames(pluginPackageJson)
  const dependencyMap = collectTransitiveDepsFromPackageNames(
    runtimeDependencyNames,
    createSkipPackages(pluginPackageJson),
    [path.join(packageDir, 'node_modules'), path.join(rootDir, 'node_modules')],
  )
  copyFlattenedDeps(outputDir, dependencyMap)
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
  refreshMirrors = true,
} = {}) {
  const resolvedRootDir = rootDir ?? process.cwd()
  const selectedTargets = BUILD_TARGETS.filter((target) => !pluginIds || pluginIds.includes(target.pluginId))

  for (const target of selectedTargets) {
    const packageDir = path.join(resolvedRootDir, target.packageDir)
    await buildLocalPluginArtifacts({
      packageDir,
      ...(Array.isArray(target.compileDirs) ? { compileDirs: target.compileDirs } : {}),
      ...(Array.isArray(target.compileFiles) ? { compileFiles: target.compileFiles } : {}),
      ...(target.preserveDirStructure === true ? { preserveDirStructure: true } : {}),
    })

    if (refreshMirrors) {
      await refreshManagedPluginMirror({
        rootDir: resolvedRootDir,
        target,
      })
    }
  }
}

export const LOCAL_OPENCLAW_PLUGIN_BUILD_TARGETS = BUILD_TARGETS
