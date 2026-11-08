import { createRequire } from 'node:module';
import { isAbsolute, normalize, parse, sep } from 'node:path';
import { FolderError, isProtectedComponent, isValidComponent } from './contracts';

export interface DirectoryPageEntry { name: string; kind: 'file' | 'directory' }
export interface FolderDirectory {
  readonly canonicalRoot?: string;
  close(): Promise<void>;
  child(name: string): Promise<FolderDirectory>;
  next(): Promise<DirectoryPageEntry | null | undefined>;
  read(name: string): Promise<Buffer>;
  write(name: string, bytes: Buffer, beforeCommit: () => void): Promise<void>;
}

export function normalizedRoot(path: string): { root: string; prefix: string; components: string[] } {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 16_384) throw new FolderError('invalid-input');
  // Only local disk roots on Windows; device namespaces, UNC and drive-relative inputs never enter native calls.
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(path)) throw new FolderError('invalid-input');
  const originalParts = path.split(/[\\/]/u).slice(process.platform === 'win32' ? 1 : 0).filter(Boolean);
  if (originalParts.some((part) => !isValidComponent(part))) throw new FolderError('invalid-input');
  const root = normalize(path);
  const prefix = parse(root).root;
  const components = root.slice(prefix.length).split(sep).filter(Boolean);
  if (!components.length) throw new FolderError('forbidden-path');
  if (components.some((part) => isProtectedComponent(part, true))) throw new FolderError('forbidden-path');
  return { root: root.replace(/[\\/]$/u, ''), prefix, components };
}

export function loadKoffi(): typeof import('koffi') { return createRequire(__filename)('koffi') as typeof import('koffi'); }

type NativeFunction = ReturnType<import('koffi').LibraryHandle['func']>;
export function callNative(fn: NativeFunction, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (error: unknown, result: number) => error ? reject(new FolderError('unavailable')) : resolve(result));
  });
}

export async function openFolderRoot(path: string): Promise<FolderDirectory> {
  const root = normalizedRoot(path);
  if (!['x64', 'arm64'].includes(process.arch)) throw new FolderError('unavailable');
  if (process.platform === 'win32') return (await import('./windows')).openWindowsRoot(root);
  if (process.platform === 'linux' || process.platform === 'darwin') return (await import('./posix')).openPosixRoot(root);
  throw new FolderError('unavailable');
}
