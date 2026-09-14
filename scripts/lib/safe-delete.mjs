import fs from 'node:fs'
import path from 'node:path'

function nativePath(targetPath) {
  return path.toNamespacedPath(path.resolve(targetPath))
}

function comparablePath(targetPath) {
  const resolved = path.resolve(targetPath).replace(/^\\\\\?\\/, '')
  return process.platform === 'win32'
    ? resolved.replace(/\\/g, '/').toLowerCase()
    : resolved
}

function isPathInside(rootPath, targetPath) {
  const root = comparablePath(rootPath)
  const target = comparablePath(targetPath)
  const rootWithSep = root.endsWith('/') ? root : `${root}/`
  return target === root || target.startsWith(rootWithSep)
}

function errnoCode(error) {
  return error && typeof error === 'object' ? error.code : undefined
}

function isLinkLike(stat) {
  return stat.isSymbolicLink()
    || (process.platform === 'win32' && typeof stat.reparseTag !== 'undefined' && stat.reparseTag !== 0 && stat.reparseTag !== 0n)
}

function lstatEntry(targetPath, force) {
  try {
    return fs.lstatSync(nativePath(targetPath))
  } catch (error) {
    if (force && errnoCode(error) === 'ENOENT') return null
    throw error
  }
}

function realpathEntry(targetPath) {
  return fs.realpathSync.native(nativePath(targetPath))
}

function removeLinkEntry(targetPath, stat) {
  try {
    if (process.platform === 'win32' && stat.isDirectory()) {
      fs.rmdirSync(nativePath(targetPath))
    } else {
      fs.unlinkSync(nativePath(targetPath))
    }
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT') return
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR')) {
      fs.rmdirSync(nativePath(targetPath))
      return
    }
    throw error
  }
}

function removeFileEntry(targetPath, force) {
  try {
    fs.unlinkSync(nativePath(targetPath))
  } catch (error) {
    if (force && errnoCode(error) === 'ENOENT') return
    throw error
  }
}

function assertParentInsideRoot(targetPath, rootRealPath) {
  const parentRealPath = realpathEntry(path.dirname(targetPath))
  if (!isPathInside(rootRealPath, parentRealPath)) {
    throw new Error(`refusing to delete entry outside root: ${targetPath}`)
  }
}

function removeEntry(targetPath, rootRealPath, deletionRootRealPath, force) {
  const stat = lstatEntry(targetPath, force)
  if (!stat) return false

  assertParentInsideRoot(targetPath, rootRealPath)

  if (isLinkLike(stat)) {
    removeLinkEntry(targetPath, stat)
    return true
  }

  if (!stat.isDirectory()) {
    removeFileEntry(targetPath, force)
    return true
  }

  const targetRealPath = realpathEntry(targetPath)
  if (!isPathInside(rootRealPath, targetRealPath) || !isPathInside(deletionRootRealPath, targetRealPath)) {
    throw new Error(`refusing to recursively delete directory outside root: ${targetPath}`)
  }

  for (const child of fs.readdirSync(nativePath(targetPath))) {
    removeEntry(path.join(targetPath, child), rootRealPath, deletionRootRealPath, force)
  }
  fs.rmdirSync(nativePath(targetPath))
  return true
}

export function safeRmSync(targetPath, options) {
  const { root, force = true } = options ?? {}
  if (!root) {
    throw new Error('safeRmSync requires a root path')
  }
  if (!isPathInside(root, targetPath)) {
    throw new Error(`refusing to delete outside root: ${targetPath}`)
  }

  const stat = lstatEntry(targetPath, force)
  if (!stat) return false

  const rootRealPath = realpathEntry(root)
  assertParentInsideRoot(targetPath, rootRealPath)

  if (isLinkLike(stat)) {
    removeLinkEntry(targetPath, stat)
    return true
  }

  if (!stat.isDirectory()) {
    removeFileEntry(targetPath, force)
    return true
  }

  const deletionRootRealPath = realpathEntry(targetPath)
  if (!isPathInside(rootRealPath, deletionRootRealPath)) {
    throw new Error(`refusing to recursively delete directory outside root: ${targetPath}`)
  }

  for (const child of fs.readdirSync(nativePath(targetPath))) {
    removeEntry(path.join(targetPath, child), rootRealPath, deletionRootRealPath, force)
  }
  fs.rmdirSync(nativePath(targetPath))
  return true
}

export async function safeRm(targetPath, options) {
  return safeRmSync(targetPath, options)
}
