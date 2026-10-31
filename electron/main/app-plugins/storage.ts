import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPluginCatalog, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import { logger } from '../../utils/logger';
import { MAX_APP_PLUGIN_ZIP_BYTES, requireDigest, requireObject, requirePluginId, validateAppPluginManifest } from './package';
import type { AppPluginPackageWorker } from './package-client';
import type { PackageResults, StoredPackageRequest } from './package-contract';

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_INSTALLED_APP_PLUGINS = 128;

async function requireDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('App plugin storage directory is invalid.');
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('App plugin storage file is invalid.');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('App plugin storage file changed during read.');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function writeSyncedFile(path: string, contents: string | Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function readCatalog(value: unknown): AppPluginCatalog {
  const catalog = requireObject(value, ['revision', 'plugins']);
  if (!Number.isSafeInteger(catalog.revision) || (catalog.revision as number) < 0
    || !Array.isArray(catalog.plugins) || catalog.plugins.length > MAX_INSTALLED_APP_PLUGINS) {
    throw new Error('App plugin catalog is invalid.');
  }
  const ids = new Set<string>();
  const plugins: InstalledAppPlugin[] = catalog.plugins.map((value) => {
    const record = requireObject(value, ['manifest', 'digest', 'enabled', 'origin', 'installedAt', 'previous']);
    const manifest = validateAppPluginManifest(record.manifest);
    requireDigest(record.digest);
    if (typeof record.enabled !== 'boolean' || (record.origin !== 'manual' && record.origin !== 'agent')
      || typeof record.installedAt !== 'string' || !Number.isFinite(Date.parse(record.installedAt)) || ids.has(manifest.id)) {
      throw new Error('App plugin catalog record is invalid.');
    }
    ids.add(manifest.id);
    let previous: InstalledAppPlugin['previous'];
    if (record.previous !== undefined) {
      const old = requireObject(record.previous, ['manifest', 'digest', 'origin', 'installedAt']);
      const oldManifest = validateAppPluginManifest(old.manifest);
      requireDigest(old.digest);
      if (oldManifest.id !== manifest.id || old.digest === record.digest || oldManifest.version === manifest.version
        || (old.origin !== 'manual' && old.origin !== 'agent') || typeof old.installedAt !== 'string'
        || !Number.isFinite(Date.parse(old.installedAt))) throw new Error('App plugin previous version is invalid.');
      previous = { manifest: oldManifest, digest: old.digest, origin: old.origin, installedAt: old.installedAt };
    }
    return { manifest, digest: record.digest, enabled: record.enabled, origin: record.origin, installedAt: record.installedAt,
      ...(previous ? { previous } : {}) };
  });
  return { revision: catalog.revision as number, plugins };
}

export class AppPluginStorage {
  constructor(private readonly rootDir: string, private readonly packageWorker: AppPluginPackageWorker) {}

  async load(): Promise<AppPluginCatalog> {
    await requireDirectory(this.rootDir);
    await requireDirectory(join(this.rootDir, 'versions'));
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(join(this.rootDir, 'catalog.json'), MAX_CATALOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, plugins: [] };
      throw error;
    }
    // Corruption is visible; never replace an unreadable catalog with an empty one.
    return readCatalog(JSON.parse(bytes.toString('utf8')));
  }

  async stage(id: string, digest: string, bytes: Buffer): Promise<void> {
    requirePluginId(id);
    requireDigest(digest);
    const parent = join(this.rootDir, 'versions', id);
    await requireDirectory(parent);
    const target = join(parent, digest);
    try {
      const existing = await this.readPackage(id, digest);
      if (!existing.equals(bytes)) throw new Error('Immutable app plugin version does not match.');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Store the validated archive, not arbitrary extracted paths, in a new empty directory.
    const staging = await mkdtemp(join(parent, '.staging-'));
    try {
      await writeSyncedFile(join(staging, 'package.zip'), bytes);
      await syncDirectory(staging);
      await rename(staging, target);
      await syncDirectory(parent);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  readPackage(id: string, digest: string): Promise<Buffer>;
  readPackage(id: string, digest: string, request: Extract<StoredPackageRequest, { operation: 'read' }>): Promise<PackageResults['read']>;
  readPackage(id: string, digest: string, request: Extract<StoredPackageRequest, { operation: 'files' }>): Promise<PackageResults['files']>;
  readPackage(id: string, digest: string, request: Extract<StoredPackageRequest, { operation: 'source' }>): Promise<PackageResults['source']>;
  readPackage(id: string, digest: string, request: Extract<StoredPackageRequest, { operation: 'html' }>): Promise<PackageResults['html']>;
  async readPackage(id: string, digest: string, request: StoredPackageRequest = { operation: 'verify' }): Promise<Buffer | PackageResults[StoredPackageRequest['operation']]> {
    requirePluginId(id);
    requireDigest(digest);
    const parent = join(this.rootDir, 'versions', id);
    const version = join(parent, digest);
    for (const path of [parent, version]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('App plugin version directory is invalid.');
    }
    const bytes = await readBoundedFile(join(version, 'package.zip'), MAX_APP_PLUGIN_ZIP_BYTES);
    switch (request.operation) {
      case 'read': return this.packageWorker.process({ operation: 'read', bytes, expectedDigest: digest });
      case 'files': return this.packageWorker.process({ operation: 'files', bytes, expectedDigest: digest });
      case 'source': return this.packageWorker.process({ ...request, bytes, expectedDigest: digest });
      case 'html': return this.packageWorker.process({ ...request, bytes, expectedDigest: digest });
      case 'verify': {
        const verified = await this.packageWorker.process({ operation: 'verify', bytes, expectedDigest: digest });
        return Buffer.from(verified.buffer, verified.byteOffset, verified.byteLength);
      }
    }
  }

  async publish(catalog: AppPluginCatalog): Promise<void> {
    const contents = JSON.stringify(catalog, null, 2);
    if (Buffer.byteLength(contents) > MAX_CATALOG_BYTES) throw new Error('App plugin catalog is too large.');
    const target = join(this.rootDir, 'catalog.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeSyncedFile(temporary, contents);
      // The rename is the sole commit point; versions are immutable and already durable.
      await rename(temporary, target);
      await syncDirectory(this.rootDir).catch(() => logger.warn('[AppPlugins] Catalog committed but directory sync failed'));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async prune(id: string, activeDigest: string, previousDigest?: string): Promise<void> {
    requirePluginId(id);
    requireDigest(activeDigest);
    if (previousDigest !== undefined) requireDigest(previousDigest);
    const parent = join(this.rootDir, 'versions', id);
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === activeDigest || entry.name === previousDigest) continue;
      if (entry.name.startsWith('.staging-') || /^[a-f0-9]{64}$/.test(entry.name)) {
        await rm(join(parent, entry.name), { recursive: true, force: true });
      }
    }
  }

  async remove(id: string): Promise<void> {
    requirePluginId(id);
    await rm(join(this.rootDir, 'versions', id), { recursive: true, force: true });
  }
}
