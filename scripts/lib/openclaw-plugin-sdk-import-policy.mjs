import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const JS_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'])
const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])

const FORBIDDEN_SDK_IMPORTS = [
  {
    specifier: 'openclaw/plugin-sdk',
    subtree: false,
    reason: '禁止使用 openclaw/plugin-sdk root import',
  },
  {
    specifier: 'openclaw/plugin-sdk/compat',
    subtree: true,
    reason: '禁止使用 openclaw/plugin-sdk/compat',
  },
  {
    specifier: 'openclaw/extension-api',
    subtree: true,
    reason: '禁止使用 openclaw/extension-api',
  },
  {
    specifier: 'openclaw/plugin-sdk/provider-http',
    subtree: true,
    reason: 'private-local SDK subpath 禁止项',
  },
  {
    specifier: 'openclaw/plugin-sdk/provider-auth-runtime',
    subtree: true,
    reason: 'private-local SDK subpath 禁止项',
  },
  {
    specifier: 'openclaw/plugin-sdk/ssrf-dispatcher',
    subtree: true,
    reason: 'private-local SDK subpath 禁止项',
  },
]

function isSourceFile(filePath) {
  return JS_SOURCE_EXTENSIONS.has(path.extname(filePath))
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function extractImportSpecifiers(source) {
  const cleaned = stripComments(source)
  const matches = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(cleaned)) !== null) {
      matches.push({ index: match.index, specifier: match[1] })
    }
  }

  return matches.sort((left, right) => left.index - right.index).map((match) => match.specifier)
}

function classifyForbiddenSdkImport(specifier) {
  return FORBIDDEN_SDK_IMPORTS.find((rule) => {
    if (specifier === rule.specifier) return true
    return rule.subtree && specifier.startsWith(`${rule.specifier}/`)
  }) ?? null
}

async function collectFiles(targetPath, files, skipDirs) {
  let entryStat
  try {
    entryStat = await stat(targetPath)
  } catch {
    return
  }

  if (entryStat.isFile()) {
    if (isSourceFile(targetPath)) files.add(path.resolve(targetPath))
    return
  }

  if (!entryStat.isDirectory()) return
  if (skipDirs.has(path.basename(targetPath))) return

  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        await collectFiles(entryPath, files, skipDirs)
      }
      continue
    }
    if (entry.isFile() && isSourceFile(entryPath)) {
      files.add(path.resolve(entryPath))
    }
  }
}

export async function findOpenClawPluginSdkImportIssues({ files = [], dirs = [], skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const scanFiles = new Set()
  const normalizedSkipDirs = skipDirs instanceof Set ? skipDirs : new Set(skipDirs)

  for (const filePath of files) {
    await collectFiles(filePath, scanFiles, normalizedSkipDirs)
  }
  for (const dirPath of dirs) {
    await collectFiles(dirPath, scanFiles, normalizedSkipDirs)
  }

  const issues = []
  for (const filePath of [...scanFiles].sort()) {
    const source = await readFile(filePath, 'utf8')
    for (const specifier of extractImportSpecifiers(source)) {
      const rule = classifyForbiddenSdkImport(specifier)
      if (rule) {
        issues.push({ filePath, specifier, reason: rule.reason })
      }
    }
  }

  return issues
}

export function formatOpenClawPluginSdkImportIssue(issue, rootDir = process.cwd()) {
  const relativeFile = path.relative(rootDir, issue.filePath).split(path.sep).join('/')
  return `${issue.reason}: ${relativeFile} -> ${issue.specifier}`
}
