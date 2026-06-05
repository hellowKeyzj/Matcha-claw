function getElectronFilePath(file: globalThis.File): string | null {
  try {
    const resolved = window.electron?.getPathForFile?.(file);
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

function getRelativePath(file: globalThis.File): string | null {
  const relativePath = (file as globalThis.File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
  return relativePath || null;
}

function normalizePathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return window.electron?.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inferExpandedFolderDropRoot(files: globalThis.File[]): string | null {
  if (files.length === 0) {
    return null;
  }

  const roots = files.map((file) => {
    const filePath = getElectronFilePath(file);
    const relativePath = getRelativePath(file);
    if (!filePath || !relativePath) {
      return null;
    }
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    if (!normalizedPath.endsWith(normalizedRelativePath)) {
      return null;
    }
    return filePath.slice(0, filePath.length - relativePath.length) + parts[0];
  });

  if (roots.some((root) => !root)) {
    return null;
  }
  const firstRoot = roots[0]!;
  const firstKey = normalizePathKey(firstRoot);
  return roots.every((root) => normalizePathKey(root!) === firstKey) ? firstRoot : null;
}

function isDirectoryItem(item: DataTransferItem): boolean {
  return item.webkitGetAsEntry?.()?.isDirectory === true;
}

export function collectDroppedFiles(dataTransfer: DataTransfer): {
  pathFiles: string[];
  bufferFiles: globalThis.File[];
} {
  const pathFiles: string[] = [];
  const bufferFiles: globalThis.File[] = [];
  const seenPaths = new Set<string>();
  const allFiles = Array.from(dataTransfer.files ?? []);

  const addPathFile = (filePath: string) => {
    const key = normalizePathKey(filePath);
    if (seenPaths.has(key)) {
      return;
    }
    seenPaths.add(key);
    pathFiles.push(filePath);
  };

  const expandedFolderRoot = inferExpandedFolderDropRoot(allFiles);
  if (expandedFolderRoot) {
    addPathFile(expandedFolderRoot);
    return { pathFiles, bufferFiles };
  }

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      const filePath = getElectronFilePath(file);
      if (filePath) {
        addPathFile(filePath);
      } else if (!isDirectoryItem(item)) {
        bufferFiles.push(file);
      }
    }
    return { pathFiles, bufferFiles };
  }

  for (const file of allFiles) {
    const filePath = getElectronFilePath(file);
    if (filePath) {
      addPathFile(filePath);
    } else {
      bufferFiles.push(file);
    }
  }

  return { pathFiles, bufferFiles };
}
