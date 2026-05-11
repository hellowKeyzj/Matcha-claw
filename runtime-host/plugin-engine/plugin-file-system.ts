export interface PluginDirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface PluginPathSignature {
  readonly kind: 'file' | 'dir';
  readonly mtimeMs: number;
  readonly size: number;
}

export interface PluginFileSystemPort {
  pathExists(pathname: string): Promise<boolean>;
  readText(pathname: string): Promise<string>;
  readJsonRecord(pathname: string): Promise<Record<string, unknown> | null>;
  listDirectoryEntries(pathname: string): Promise<PluginDirectoryEntry[]>;
  ensureDirectory(pathname: string): Promise<void>;
  remove(pathname: string): Promise<void>;
  copyDirectory(sourcePath: string, targetPath: string): Promise<void>;
  writeText(pathname: string, content: string): Promise<void>;
  readPathSignature(pathname: string): Promise<PluginPathSignature | null>;
}
