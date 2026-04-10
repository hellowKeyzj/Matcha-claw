import path from 'node:path';

export function fsPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return filePath;
  }
  if (!filePath) {
    return filePath;
  }
  if (filePath.startsWith('\\\\?\\')) {
    return filePath;
  }

  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) {
    return windowsPath;
  }
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}
