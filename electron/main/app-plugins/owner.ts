import { join } from 'node:path';
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
  MAX_APP_PLUGIN_ZIP_BYTES,
  requireDigest,
  requireObject,
  requirePluginId,
} from './package';
import type { AppPluginPackageWorker } from './package-client';
import type { PackageRequest, PackageResults } from './package-contract';
import { compareAppPluginVersions, readBundledAppPlugins } from './bundled';
import { AppPluginStorage, MAX_INSTALLED_APP_PLUGINS, type StoredAppPluginCatalog } from './storage';
import { readBoundedFile } from '../../utils/private-file';

export interface ApplicationPluginOwnerOptions {
  readonly rootDir: string;
  readonly packageWorker: AppPluginPackageWorker;
  readonly onChanged: (event: { revision: number }, catalog: AppPluginCatalog) => void | Promise<void>;
}

export class ApplicationPluginOwner {
  private readonly storage: AppPluginStorage;
  private catalog: StoredAppPluginCatalog | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(private readonly options: ApplicationPluginOwnerOptions) {
    this.storage = new AppPluginStorage(options.rootDir, options.packageWorker);
  }

  list(): Promise<AppPluginCatalog> {
    if (this.closed) return Promise.reject(new AppPluginError('closed', 'App plugin owner is closing.'));
    const snapshot = ({ revision, plugins }: AppPluginCatalog): AppPluginCatalog => structuredClone({ revision, plugins });
    if (this.catalog) return Promise.resolve(snapshot(this.catalog));
    return this.enqueue(async () => {
      this.catalog ??= await this.load();
      return snapshot(this.catalog);
    });
  }

  installBundled(directory: string): Promise<void> {
    return this.enqueue(async () => {
      const receipts = await readBundledAppPlugins(directory);
      for (const receipt of receipts) {
        const catalog = await this.load();
        const handled = catalog.bundled[receipt.id];
        if (handled === receipt.digest) continue;
        const current = catalog.plugins.find((plugin) => plugin.manifest.id === receipt.id);
        // Keep the bundle baseline: recording a skipped package can erase a user's rollback choice.
        if (handled && current?.digest !== handled) continue;
        const bundled = { ...catalog.bundled, [receipt.id]: receipt.digest };
        if (current && compareAppPluginVersions(receipt.version, current.manifest.version) <= 0) {
          // Re-signing the same version must not turn the installed bundle into a user override.
          if (!handled) await this.commit(catalog.plugins, undefined, bundled);
          continue;
        }
        const bytes = await readBoundedFile(join(directory, `${receipt.id}.zip`), MAX_APP_PLUGIN_ZIP_BYTES);
        const contents = await this.options.packageWorker.process({ operation: 'validate', bytes });
        if (contents.digest !== receipt.digest || contents.manifest.id !== receipt.id || contents.manifest.version !== receipt.version) {
          throw new AppPluginError('invalid_package', 'Bundled app plugin does not match its receipt.');
        }
        await this.installContents(contents, { digest: receipt.digest, origin: 'bundled' }, bundled);
      }
    });
  }

  inspect(packageBase64: string): Promise<AppPluginInspection> {
    return this.enqueue(async () => {
      const { manifest, digest } = await this.options.packageWorker.process({ operation: 'inspect', packageBase64 });
      return { manifest, digest };
    });
  }

  // Consumes the buffer; callers retaining a snapshot must pass one exclusive clone.
  validate(bytes: Uint8Array): Promise<PackageResults['validate']> {
    return this.enqueue(() => {
      if (!(bytes instanceof Uint8Array)) throw new AppPluginError('invalid_package', 'App plugin package must be ZIP bytes.');
      return this.options.packageWorker.process({ operation: 'validate', bytes });
    });
  }

  importPackage(input: { packageBase64: string; digest: string; origin: 'manual' | 'agent'; onlyIfNew?: boolean }): Promise<InstalledAppPlugin> {
    return this.enqueue(() => {
      requireObject(input, ['packageBase64', 'digest', 'origin', 'onlyIfNew']);
      return this.install({ operation: 'import', packageBase64: input.packageBase64 }, input);
    });
  }

  // Revalidates and consumes bytes; pass one exclusive clone to retain a validated snapshot.
  importBytes(input: { bytes: Uint8Array; digest: string; origin: 'manual' | 'agent'; onlyIfNew?: boolean }): Promise<InstalledAppPlugin> {
    return this.enqueue(() => {
      requireObject(input, ['bytes', 'digest', 'origin', 'onlyIfNew']);
      if (!(input.bytes instanceof Uint8Array)) throw new AppPluginError('invalid_package', 'App plugin package must be ZIP bytes.');
      return this.install({ operation: 'validate', bytes: input.bytes }, input);
    });
  }

  build(input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<AppPluginBuild> {
    return this.enqueue(async () => {
      requireObject(input, ['manifest', 'files']);
      return this.options.packageWorker.process({ operation: 'build', input });
    });
  }

  bundle(id: string, digest: string, entry: string): Promise<{ html: string }> {
    return this.enqueue(async () => {
      const installed = this.requireCurrent(await this.load(), id, digest);
      if (!installed.enabled) throw new AppPluginError('conflict', 'This app plugin is disabled.');
      const isReader = installed.manifest.contributes.readers?.some((reader) => reader.entry === entry);
      const isApplication = installed.manifest.contributes.applications?.some((application) => application.entry === entry);
      if (typeof entry !== 'string' || (!isReader && !isApplication)) {
        throw new AppPluginError('invalid_package', 'The requested HTML entry is not declared by this plugin.');
      }
      const contents = await this.storage.readPackage(id, digest, { operation: 'html', entry, expectedManifest: installed.manifest });
      return { html: contents.html };
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
      await this.commit(catalog.plugins.filter((plugin) => plugin.manifest.id !== input.id),
        () => this.storage.remove(input.id).catch(() => logger.warn('[AppPlugins] Could not remove uninstalled package files')));
    });
  }

  rollback(input: { id: string; digest: string }): Promise<InstalledAppPlugin> {
    return this.enqueue(async () => {
      requireObject(input, ['id', 'digest']);
      const catalog = await this.load();
      const current = this.requireCurrent(catalog, input.id, input.digest);
      const previous = current.previous;
      if (!previous) throw new AppPluginError('conflict', 'This app plugin has no retained previous version.');
      const contents = await this.storage.readPackage(input.id, previous.digest, { operation: 'read' });
      if (JSON.stringify(contents.manifest) !== JSON.stringify(previous.manifest)) throw new Error('Retained plugin manifest does not match its package.');
      const restored: InstalledAppPlugin = { ...previous, enabled: current.enabled };
      await this.commit(catalog.plugins.map((plugin) => plugin.manifest.id === input.id ? restored : plugin),
        () => this.storage.prune(input.id, restored.digest)
          .catch(() => logger.warn('[AppPlugins] Could not prune rolled-back package version')));
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

  private async install(
    request: Extract<PackageRequest, { operation: 'import' | 'validate' }>,
    input: { digest: string; origin: 'manual' | 'agent'; onlyIfNew?: boolean },
  ): Promise<InstalledAppPlugin> {
    requireDigest(input.digest);
    if (input.onlyIfNew !== undefined && typeof input.onlyIfNew !== 'boolean') throw new AppPluginError('invalid_package', 'Invalid app plugin creation condition.');
    if (input.origin !== 'manual' && input.origin !== 'agent') throw new AppPluginError('invalid_package', 'Invalid plugin installation origin.');
    const contents = request.operation === 'import'
      ? await this.options.packageWorker.process({ operation: 'import', packageBase64: request.packageBase64 })
      : await this.options.packageWorker.process({ operation: 'validate', bytes: request.bytes });
    return this.installContents(contents, input);
  }

  private async installContents(
    contents: PackageResults['import'],
    input: { digest: string; origin: InstalledAppPlugin['origin']; onlyIfNew?: boolean },
    bundled?: StoredAppPluginCatalog['bundled'],
  ): Promise<InstalledAppPlugin> {
    if (contents.digest !== input.digest) throw new AppPluginError('conflict', 'Package changed after inspection. Inspect it again before importing.');
    const catalog = await this.load();
    const previous = catalog.plugins.find((plugin) => plugin.manifest.id === contents.manifest.id);
    if (input.onlyIfNew && previous) throw new AppPluginError('conflict', 'New plugin development cannot replace an installed package.');
    if (previous?.digest === contents.digest) {
      if (bundled) await this.commit(catalog.plugins, undefined, bundled);
      return structuredClone(previous);
    }
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
    await this.storage.stage(contents.manifest.id, contents.digest, Buffer.from(contents.bytes.buffer, contents.bytes.byteOffset, contents.bytes.byteLength));
    await this.commit([...catalog.plugins.filter((plugin) => plugin.manifest.id !== contents.manifest.id), installed],
      () => this.storage.prune(contents.manifest.id, contents.digest, installed.previous?.digest)
        .catch(() => logger.warn('[AppPlugins] Could not prune retained package versions')), bundled);
    return structuredClone(installed);
  }

  private async load(): Promise<StoredAppPluginCatalog> {
    return this.catalog ?? await this.storage.load();
  }

  private requireCurrent(catalog: AppPluginCatalog, id: string, digest: string): InstalledAppPlugin {
    requirePluginId(id);
    requireDigest(digest);
    const installed = catalog.plugins.find((plugin) => plugin.manifest.id === id);
    if (!installed) throw new AppPluginError('not_found', 'App plugin is not installed.');
    if (installed.digest !== digest) throw new AppPluginError('conflict', 'App plugin was updated. Refresh its details before continuing.');
    return installed;
  }

  private async commit(
    plugins: readonly InstalledAppPlugin[],
    cleanup?: () => Promise<void>,
    bundled?: StoredAppPluginCatalog['bundled'],
  ): Promise<void> {
    const current = await this.load();
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('App plugin catalog revision limit reached.');
    const catalog = { revision, plugins, bundled: bundled ?? current.bundled };
    await this.storage.publish(catalog);
    this.catalog = catalog;
    try {
      await this.options.onChanged({ revision }, structuredClone({ revision, plugins }));
    } catch (cause) {
      const message = `App plugin catalog revision ${revision} was committed, but change notification or application cleanup failed. Refresh installed plugins before retrying.`;
      const error = cause instanceof AppPluginError
        ? new AppPluginError(cause.code, `${message} ${cause.message}`) : new Error(message);
      error.cause = cause;
      throw error;
    } finally {
      await cleanup?.();
    }
  }
}
