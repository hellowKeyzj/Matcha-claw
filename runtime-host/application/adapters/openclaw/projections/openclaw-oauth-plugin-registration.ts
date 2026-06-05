import { join } from 'node:path';
import type { RuntimeHostLogger } from '../../../../shared/logger';
import type { RuntimeFileSystemPort } from '../../../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';

type BundledPluginDiscovery = {
  dir: string;
  all: Set<string>;
  enabledByDefault: string[];
  manifests: BundledPluginManifest[];
};

type BundledPluginManifest = {
  id: string;
  enabledByDefault: boolean;
  providers: string[];
  legacyPluginIds: string[];
};

export type OAuthPluginRegistration = {
  canonicalPluginId: string;
  stalePluginIds: string[];
};

async function discoverBundledPluginsInDir(
  fileSystem: RuntimeFileSystemPort,
  extensionsDir: string,
): Promise<BundledPluginDiscovery> {
  const all = new Set<string>();
  const enabledByDefault: string[] = [];
  const manifests: BundledPluginManifest[] = [];

  try {
    for (const entry of await fileSystem.listDirectory(extensionsDir)) {
      if (!entry.isDirectory) {
        continue;
      }
      const manifestPath = join(extensionsDir, entry.name, 'openclaw.plugin.json');
      if (!(await fileSystem.exists(manifestPath))) {
        continue;
      }
      try {
        const manifest = JSON.parse(await fileSystem.readTextFile(manifestPath)) as Record<string, unknown>;
        const pluginId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
        if (!pluginId) {
          continue;
        }
        const providers = Array.isArray(manifest.providers)
          ? manifest.providers.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        const legacyPluginIds = Array.isArray(manifest.legacyPluginIds)
          ? manifest.legacyPluginIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        all.add(pluginId);
        if (manifest.enabledByDefault === true) {
          enabledByDefault.push(pluginId);
        }
        manifests.push({
          id: pluginId,
          enabledByDefault: manifest.enabledByDefault === true,
          providers,
          legacyPluginIds,
        });
      } catch {
        // Ignore malformed plugin manifest.
      }
    }
  } catch {
    // Ignore unreadable extension directory.
  }

  return {
    dir: extensionsDir,
    all,
    enabledByDefault,
    manifests,
  };
}

async function getOAuthPluginRegistration(
  discovery: BundledPluginDiscovery,
  provider: string,
): Promise<OAuthPluginRegistration> {
  const manifest = discovery.manifests.find((entry) => entry.providers.includes(provider));
  if (!manifest) {
    return {
      canonicalPluginId: `${provider}-auth`,
      stalePluginIds: [],
    };
  }

  const knownPluginIds = new Set<string>([
    manifest.id,
    `${provider}-auth`,
    ...manifest.legacyPluginIds,
  ]);

  return {
    canonicalPluginId: manifest.id,
    stalePluginIds: [...knownPluginIds].filter((pluginId) => pluginId !== manifest.id),
  };
}

function removePluginRegistrations(
  config: Record<string, unknown>,
  pluginIds: string[],
): boolean {
  const uniquePluginIds = Array.from(new Set(pluginIds.filter(Boolean)));
  if (uniquePluginIds.length === 0) {
    return false;
  }

  const plugins = (
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? config.plugins as Record<string, unknown>
      : null
  );
  if (!plugins) {
    return false;
  }

  let modified = false;

  if (Array.isArray(plugins.allow)) {
    const allow = (plugins.allow as unknown[]).filter((value): value is string => typeof value === 'string');
    const nextAllow = allow.filter((pluginId) => !uniquePluginIds.includes(pluginId));
    if (nextAllow.length !== allow.length) {
      modified = true;
      if (nextAllow.length > 0) {
        plugins.allow = nextAllow;
      } else {
        delete plugins.allow;
      }
    }
  }

  if (plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)) {
    const entries = plugins.entries as Record<string, unknown>;
    for (const pluginId of uniquePluginIds) {
      if (pluginId in entries) {
        delete entries[pluginId];
        modified = true;
      }
    }
    if (Object.keys(entries).length === 0) {
      delete plugins.entries;
      modified = true;
    }
  }

  const pluginKeysExcludingEnabled = Object.keys(plugins).filter((key) => key !== 'enabled');
  if (plugins.enabled === true && pluginKeysExcludingEnabled.length === 0) {
    delete plugins.enabled;
    modified = true;
  }
  if (Object.keys(plugins).length === 0) {
    delete config.plugins;
    modified = true;
  }

  return modified;
}

async function removeOAuthPluginRegistrationsForDiscovery(
  discovery: BundledPluginDiscovery,
  config: Record<string, unknown>,
  provider: string,
): Promise<boolean> {
  const registration = await getOAuthPluginRegistration(discovery, provider);
  return removePluginRegistrations(config, [
    registration.canonicalPluginId,
    ...registration.stalePluginIds,
  ]);
}

function removePluginIdsFromAllowlist(
  plugins: Record<string, unknown>,
  pluginIds: readonly string[],
): boolean {
  if (!Array.isArray(plugins.allow)) {
    return false;
  }
  const removals = new Set(pluginIds);
  const allow = (plugins.allow as unknown[]).filter((value): value is string => typeof value === 'string');
  const nextAllow = allow.filter((pluginId) => !removals.has(pluginId));
  if (nextAllow.length === allow.length) {
    return false;
  }
  if (nextAllow.length > 0) {
    plugins.allow = nextAllow;
  } else {
    delete plugins.allow;
  }
  return true;
}

async function ensureOAuthPluginEnabledForDiscovery(
  discovery: BundledPluginDiscovery,
  config: Record<string, unknown>,
  provider: string,
  logger: RuntimeHostLogger,
): Promise<boolean> {
  const plugins = (
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? { ...(config.plugins as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const entries = (
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const { canonicalPluginId, stalePluginIds } = await getOAuthPluginRegistration(discovery, provider);

  let modified = false;
  if (removePluginIdsFromAllowlist(plugins, stalePluginIds)) {
    modified = true;
  }

  for (const stalePluginId of stalePluginIds) {
    if (stalePluginId in entries) {
      delete entries[stalePluginId];
      modified = true;
    }
  }

  const currentCanonicalEntry = (
    entries[canonicalPluginId] && typeof entries[canonicalPluginId] === 'object' && !Array.isArray(entries[canonicalPluginId])
      ? entries[canonicalPluginId] as Record<string, unknown>
      : {}
  );
  if (currentCanonicalEntry.enabled !== true) {
    entries[canonicalPluginId] = {
      ...currentCanonicalEntry,
      enabled: true,
    };
    modified = true;
  }

  if (!modified) {
    return false;
  }

  plugins.entries = entries;
  config.plugins = plugins;
  logger.debug?.(`Enabled OAuth plugin for provider "${provider}"`);
  return true;
}

export function applyOAuthPluginRegistration(config: Record<string, unknown>, registration: OAuthPluginRegistration, logger: RuntimeHostLogger): boolean {
  const plugins = (
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? { ...(config.plugins as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const entries = (
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  let modified = false;
  if (removePluginIdsFromAllowlist(plugins, registration.stalePluginIds)) {
    modified = true;
  }

  for (const stalePluginId of registration.stalePluginIds) {
    if (stalePluginId in entries) {
      delete entries[stalePluginId];
      modified = true;
    }
  }

  const currentCanonicalEntry = (
    entries[registration.canonicalPluginId] && typeof entries[registration.canonicalPluginId] === 'object' && !Array.isArray(entries[registration.canonicalPluginId])
      ? entries[registration.canonicalPluginId] as Record<string, unknown>
      : {}
  );
  if (currentCanonicalEntry.enabled !== true) {
    entries[registration.canonicalPluginId] = {
      ...currentCanonicalEntry,
      enabled: true,
    };
    modified = true;
  }

  if (!modified) {
    return false;
  }

  plugins.entries = entries;
  config.plugins = plugins;
  logger.debug?.(`Enabled OAuth plugin for provider "${registration.canonicalPluginId}"`);
  return true;
}

export function applyOAuthPluginRegistrationRemoval(config: Record<string, unknown>, registration: OAuthPluginRegistration): boolean {
  return removePluginRegistrations(config, [
    registration.canonicalPluginId,
    ...registration.stalePluginIds,
  ]);
}

export class OpenClawOAuthPluginRegistrationService {
  private bundledPluginDiscoveryCache: BundledPluginDiscovery | null = null;

  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly fileSystem: RuntimeFileSystemPort,
    private readonly logger: RuntimeHostLogger,
  ) {}

  async discoverBundledPlugins(): Promise<BundledPluginDiscovery> {
    const extensionsDir = join(this.configRepository.getOpenClawDirPath(), 'dist', 'extensions');
    if (this.bundledPluginDiscoveryCache?.dir === extensionsDir) {
      return this.bundledPluginDiscoveryCache;
    }
    this.bundledPluginDiscoveryCache = await discoverBundledPluginsInDir(this.fileSystem, extensionsDir);
    return this.bundledPluginDiscoveryCache;
  }

  async resolveOAuthPluginRegistration(provider: string): Promise<OAuthPluginRegistration> {
    return await getOAuthPluginRegistration(await this.discoverBundledPlugins(), provider);
  }

  async removeOAuthPluginRegistrations(
    config: Record<string, unknown>,
    provider: string,
  ): Promise<boolean> {
    return applyOAuthPluginRegistrationRemoval(config, await this.resolveOAuthPluginRegistration(provider));
  }

  async ensureOAuthPluginEnabled(
    config: Record<string, unknown>,
    provider: string,
  ): Promise<boolean> {
    return applyOAuthPluginRegistration(config, await this.resolveOAuthPluginRegistration(provider), this.logger);
  }
}
