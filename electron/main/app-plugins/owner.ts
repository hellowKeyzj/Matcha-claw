import type {
  AppPluginBuild,
  AppPluginCatalog,
  AppPluginInspection,
  AppPluginManifest,
  InstalledAppPlugin,
} from '../../../src/types/desktop/app-plugin';
import { logger } from '../../utils/logger';
import {
  AppPluginError,
  buildAppPluginPackage,
  decodeAppPluginPackage,
  readAppPluginPackage,
  requireDigest,
  requireObject,
  requirePluginId,
} from './package';
import { AppPluginStorage, MAX_INSTALLED_APP_PLUGINS } from './storage';

export interface ApplicationPluginOwnerOptions {
  readonly rootDir: string;
  readonly onChanged: (event: { revision: number }) => void;
}

export class ApplicationPluginOwner {
  private readonly storage: AppPluginStorage;
  private catalog: AppPluginCatalog | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(private readonly options: ApplicationPluginOwnerOptions) {
    this.storage = new AppPluginStorage(options.rootDir);
  }

  list(): Promise<AppPluginCatalog> {
    return this.enqueue(async () => structuredClone(await this.load()));
  }

  inspect(packageBase64: string): Promise<AppPluginInspection> {
    return this.enqueue(async () => {
      const { manifest, digest } = decodeAppPluginPackage(packageBase64);
      return { manifest, digest };
    });
  }

  inspectInstalledSource(input: { id: string; digest: string }): Promise<{
    manifest: AppPluginManifest; digest: string; files: Record<string, string>;
  }> {
    return this.enqueue(async () => {
      requireObject(input, ['id', 'digest']);
      const installed = this.requireCurrent(await this.load(), input.id, input.digest);
      const contents = readAppPluginPackage(await this.storage.readPackage(input.id, input.digest));
      if (JSON.stringify(contents.manifest) !== JSON.stringify(installed.manifest)) throw new Error('Installed app plugin manifest does not match its package.');
      const files: Record<string, string> = Object.create(null);
      for (const reader of contents.manifest.contributes.readers ?? []) {
        files[reader.entry] = Buffer.from(contents.files.get(reader.entry)!).toString('utf8');
      }
      return { manifest: contents.manifest, digest: contents.digest, files };
    });
  }

  importPackage(input: { packageBase64: string; digest: string; origin: 'manual' | 'agent'; onlyIfNew?: boolean; expectedDigest?: string }): Promise<InstalledAppPlugin> {
    return this.enqueue(async () => {
      requireObject(input, ['packageBase64', 'digest', 'origin', 'onlyIfNew', 'expectedDigest']);
      requireDigest(input.digest);
      if (input.expectedDigest !== undefined) requireDigest(input.expectedDigest);
      if (input.onlyIfNew !== undefined && typeof input.onlyIfNew !== 'boolean') throw new AppPluginError('invalid_package', 'Invalid app plugin creation condition.');
      if (input.origin !== 'manual' && input.origin !== 'agent') throw new AppPluginError('invalid_package', 'Invalid plugin installation origin.');
      const contents = decodeAppPluginPackage(input.packageBase64);
      if (contents.digest !== input.digest) throw new AppPluginError('conflict', 'Package changed after inspection. Inspect it again before importing.');
      const catalog = await this.load();
      const previous = catalog.plugins.find((plugin) => plugin.manifest.id === contents.manifest.id);
      if (input.onlyIfNew && previous) throw new AppPluginError('conflict', 'New plugin development cannot replace an installed package.');
      if (input.expectedDigest !== undefined && previous?.digest !== input.expectedDigest) {
        throw new AppPluginError('conflict', 'App plugin changed since its source was inspected. Inspect the current version before installing.');
      }
      if (previous?.digest === contents.digest) return structuredClone(previous);
      if (previous && [previous, previous.previous].some((version) => version
        && version.manifest.version === contents.manifest.version && version.digest !== contents.digest)) {
        throw new AppPluginError('conflict', 'This plugin version already has different contents. Build a new version before importing.');
      }
      if (!previous && catalog.plugins.length >= MAX_INSTALLED_APP_PLUGINS) throw new AppPluginError('busy', 'The installed app plugin limit has been reached. Uninstall a plugin first.');
      const installed: InstalledAppPlugin = {
        manifest: contents.manifest,
        digest: contents.digest,
        enabled: previous?.enabled ?? true,
        origin: input.origin,
        installedAt: new Date().toISOString(),
        ...(previous ? { previous: {
          manifest: previous.manifest,
          digest: previous.digest,
          origin: previous.origin,
          installedAt: previous.installedAt,
        } } : {}),
      };
      await this.storage.stage(contents.manifest.id, contents.digest, contents.bytes);
      await this.commit([...catalog.plugins.filter((plugin) => plugin.manifest.id !== contents.manifest.id), installed]);
      await this.storage.prune(contents.manifest.id, contents.digest, installed.previous?.digest)
        .catch(() => logger.warn('[AppPlugins] Could not prune retained package versions'));
      return structuredClone(installed);
    });
  }

  build(input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<AppPluginBuild> {
    return this.enqueue(async () => {
      requireObject(input, ['manifest', 'files']);
      const { manifest, digest, bytes } = buildAppPluginPackage(input);
      return { manifest, digest, packageBase64: bytes.toString('base64') };
    });
  }

  bundle(id: string, digest: string, entry: string): Promise<{ html: string }> {
    return this.enqueue(async () => {
      const installed = this.requireCurrent(await this.load(), id, digest);
      if (!installed.enabled) throw new AppPluginError('conflict', 'This app plugin is disabled.');
      if (typeof entry !== 'string' || !installed.manifest.contributes.readers?.some((reader) => reader.entry === entry)) {
        throw new AppPluginError('invalid_package', 'The requested reader entry is not declared by this plugin.');
      }
      const contents = readAppPluginPackage(await this.storage.readPackage(id, digest));
      if (JSON.stringify(contents.manifest) !== JSON.stringify(installed.manifest)) throw new Error('Installed app plugin manifest does not match its package.');
      return { html: Buffer.from(contents.files.get(entry)!).toString('utf8') };
    });
  }

  setEnabled(input: { id: string; digest: string; enabled: boolean }): Promise<InstalledAppPlugin> {
    return this.enqueue(async () => {
      requireObject(input, ['id', 'digest', 'enabled']);
      if (typeof input.enabled !== 'boolean') throw new AppPluginError('invalid_package', 'Plugin enabled must be a boolean.');
      const catalog = await this.load();
      const current = this.requireCurrent(catalog, input.id, input.digest);
      if (current.enabled === input.enabled) return structuredClone(current);
      const installed = { ...current, enabled: input.enabled };
      await this.commit(catalog.plugins.map((plugin) => plugin.manifest.id === input.id ? installed : plugin));
      return structuredClone(installed);
    });
  }

  uninstall(input: { id: string; digest: string }): Promise<void> {
    return this.enqueue(async () => {
      requireObject(input, ['id', 'digest']);
      const catalog = await this.load();
      this.requireCurrent(catalog, input.id, input.digest);
      await this.commit(catalog.plugins.filter((plugin) => plugin.manifest.id !== input.id));
      await this.storage.remove(input.id).catch(() => logger.warn('[AppPlugins] Could not remove uninstalled package files'));
    });
  }

  rollback(input: { id: string; digest: string }): Promise<InstalledAppPlugin> {
    return this.enqueue(async () => {
      requireObject(input, ['id', 'digest']);
      const catalog = await this.load();
      const current = this.requireCurrent(catalog, input.id, input.digest);
      const previous = current.previous;
      if (!previous) throw new AppPluginError('conflict', 'This app plugin has no retained previous version.');
      const contents = readAppPluginPackage(await this.storage.readPackage(input.id, previous.digest));
      if (JSON.stringify(contents.manifest) !== JSON.stringify(previous.manifest)) throw new Error('Retained plugin manifest does not match its package.');
      const restored: InstalledAppPlugin = { ...previous, enabled: current.enabled };
      await this.commit(catalog.plugins.map((plugin) => plugin.manifest.id === input.id ? restored : plugin));
      await this.storage.prune(input.id, restored.digest)
        .catch(() => logger.warn('[AppPlugins] Could not prune rolled-back package version'));
      return structuredClone(restored);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppPluginError('closed', 'App plugin owner is closing.'));
    if (this.pending >= 16) return Promise.reject(new AppPluginError('busy', 'Too many app plugin operations. Try again shortly.'));
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.then(() => { this.pending--; }, () => { this.pending--; });
    return result;
  }

  private async load(): Promise<AppPluginCatalog> {
    this.catalog ??= await this.storage.load();
    return this.catalog;
  }

  private requireCurrent(catalog: AppPluginCatalog, id: string, digest: string): InstalledAppPlugin {
    requirePluginId(id);
    requireDigest(digest);
    const installed = catalog.plugins.find((plugin) => plugin.manifest.id === id);
    if (!installed) throw new AppPluginError('not_found', 'App plugin is not installed.');
    if (installed.digest !== digest) throw new AppPluginError('conflict', 'App plugin was updated. Refresh its details before continuing.');
    return installed;
  }

  private async commit(plugins: readonly InstalledAppPlugin[]): Promise<void> {
    const revision = (await this.load()).revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('App plugin catalog revision limit reached.');
    const catalog = { revision, plugins };
    await this.storage.publish(catalog);
    this.catalog = catalog;
    try { this.options.onChanged({ revision }); }
    catch { logger.warn('[AppPlugins] Catalog committed but change notification failed'); }
  }
}
