import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type {
  PluginDirectoryEntry,
  PluginFileSystemPort,
  PluginPathSignature,
} from '../plugin-engine/plugin-file-system';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class NodePluginFileSystem implements PluginFileSystemPort {
  async pathExists(pathname: string): Promise<boolean> {
    return await access(pathname).then(() => true).catch(() => false);
  }

  async readText(pathname: string): Promise<string> {
    return await readFile(pathname, 'utf8');
  }

  async readJsonRecord(pathname: string): Promise<Record<string, unknown> | null> {
    try {
      const parsed = JSON.parse(await this.readText(pathname)) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async listDirectoryEntries(pathname: string): Promise<PluginDirectoryEntry[]> {
    const entries = await readdir(pathname, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  }

  async ensureDirectory(pathname: string): Promise<void> {
    await mkdir(pathname, { recursive: true });
  }

  async remove(pathname: string): Promise<void> {
    await rm(pathname, { recursive: true, force: true });
  }

  async copyDirectory(sourcePath: string, targetPath: string): Promise<void> {
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }

  async writeText(pathname: string, content: string): Promise<void> {
    await writeFile(pathname, content, 'utf8');
  }

  async readPathSignature(pathname: string): Promise<PluginPathSignature | null> {
    try {
      const info = await stat(pathname);
      return {
        kind: info.isDirectory() ? 'dir' : 'file',
        mtimeMs: info.mtimeMs,
        size: info.size,
      };
    } catch {
      return null;
    }
  }
}
