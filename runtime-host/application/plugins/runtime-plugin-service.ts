import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import { normalizePluginIds } from '../../bootstrap/runtime-config';
import {
  CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS,
  findCapabilityOpenClawPluginDefinition,
  findManagedOpenClawPluginDefinition,
} from './managed-plugin-definitions';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
  resolveEffectivePluginIdsForConfig,
} from '../openclaw/openclaw-plugin-config-service';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import { isChannelDerivedPluginId } from '../channels/channel-plugin-bindings';
import type { RuntimePluginLifecycleRunner } from './plugin-lifecycle-registry';
import type { RuntimePluginTransitionLifecycleState } from './plugin-lifecycle-types';
import type { ManagedPluginInstaller, ManagedRegistryPluginSnapshot } from './managed-plugin-installer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function replaceConfigContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function normalizeManualPluginIds(pluginIds: readonly string[]): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => (
    !isChannelDerivedPluginId(pluginId)
    && Boolean(findCapabilityOpenClawPluginDefinition(pluginId))
  ));
}

function filterManagedPluginIds(pluginIds: readonly string[]): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => Boolean(findCapabilityOpenClawPluginDefinition(pluginId)));
}

function computeTransitionLifecycleState(
  previousEnabledPluginIds: readonly string[],
  nextEnabledPluginIds: readonly string[],
): RuntimePluginTransitionLifecycleState {
  const previousEnabledSet = new Set(previousEnabledPluginIds);
  const nextEnabledSet = new Set(nextEnabledPluginIds);

  return {
    previousEnabledPluginIds,
    nextEnabledPluginIds,
    newlyEnabledPluginIds: nextEnabledPluginIds.filter((pluginId) => !previousEnabledSet.has(pluginId)),
    newlyDisabledPluginIds: previousEnabledPluginIds.filter((pluginId) => !nextEnabledSet.has(pluginId)),
  };
}

async function listConfiguredManagedPluginIdsFromConfig(config: Record<string, unknown>): Promise<string[]> {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const configuredPluginIds = new Set<string>();

  if (Array.isArray(plugins.allow)) {
    for (const pluginId of plugins.allow) {
      if (typeof pluginId === 'string') {
        configuredPluginIds.add(pluginId);
      }
    }
  }

  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  for (const [pluginId, rawEntry] of Object.entries(entries)) {
    if (isRecord(rawEntry) && rawEntry.enabled === true) {
      configuredPluginIds.add(pluginId);
    }
  }

  return normalizePluginIds([...configuredPluginIds]).filter(
    (pluginId) => Boolean(findManagedOpenClawPluginDefinition(pluginId)),
  );
}

export interface RuntimePluginRepositoryPort {
  ensureManagedPluginInstalled(pluginId: string, options?: { force?: boolean }): Promise<void>;
  listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]>;
  listEnabledPluginIds(): Promise<string[]>;
  listConfiguredManagedPluginIds(): Promise<string[]>;
  ensureConfiguredManagedPluginsInstalled(options?: { forceInstall?: boolean }): Promise<string[]>;
  ensureRuntimePluginEnabled(pluginId: string): Promise<string[]>;
  setEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]>;
  getManagedPluginSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>>;
  getManagedPluginTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>>;
}

export class RuntimePluginRepository implements RuntimePluginRepositoryPort {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly installer: ManagedPluginInstaller,
    private readonly lifecycleRunner: RuntimePluginLifecycleRunner,
    private readonly pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  ) {}

  async ensureManagedPluginInstalled(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    const definition = findCapabilityOpenClawPluginDefinition(pluginId);
    if (!definition) {
      throw new Error(`Plugin ${pluginId} is not managed by the MatchaClaw plugin center`);
    }
    await this.installer.ensureDefinitionInstalled(definition, options);
  }

  async listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]> {
    const managedRegistryCatalog = await Promise.all(
      CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.map(async (definition) => await this.installer.discoverRegistryPlugin(definition)),
    );
    return managedRegistryCatalog
      .filter((plugin): plugin is ManagedRegistryPluginSnapshot => Boolean(plugin))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }

  async listEnabledPluginIds(): Promise<string[]> {
    return (await readManuallyManagedPluginIdsFromConfig(this.configRepository, this.pluginFileSystem, await this.configRepository.read()))
      .filter((pluginId) => Boolean(findCapabilityOpenClawPluginDefinition(pluginId)));
  }

  async listConfiguredManagedPluginIds(): Promise<string[]> {
    return await listConfiguredManagedPluginIdsFromConfig(await this.configRepository.read());
  }

  async ensureConfiguredManagedPluginsInstalled(options: { forceInstall?: boolean } = {}): Promise<string[]> {
    const enabledPluginIds = filterManagedPluginIds(await this.listConfiguredManagedPluginIds());
    for (const pluginId of enabledPluginIds) {
      await this.ensureManagedPluginInstalled(pluginId, { force: options.forceInstall === true });
    }
    await this.reconcileStartupPluginLifecycles(enabledPluginIds);
    return enabledPluginIds;
  }

  async ensureRuntimePluginEnabled(pluginId: string): Promise<string[]> {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      return await this.listEnabledPluginIds();
    }

    const currentEnabledPluginIds = await this.listEnabledPluginIds();
    const nextEnabledPluginIds = currentEnabledPluginIds.includes(normalizedPluginId)
      ? currentEnabledPluginIds
      : [...currentEnabledPluginIds, normalizedPluginId];
    return await this.setEnabledPluginIds(nextEnabledPluginIds);
  }

  async setEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
    const previousEnabledPluginIds = await this.listEnabledPluginIds();
    const normalizedManualPluginIds = normalizeManualPluginIds(pluginIds);

    for (const pluginId of normalizedManualPluginIds) {
      await this.ensureManagedPluginInstalled(pluginId);
    }

    const transitionState = await this.syncRuntimeEnabledPluginIds(normalizedManualPluginIds, previousEnabledPluginIds);
    return [...transitionState.nextEnabledPluginIds];
  }

  async getManagedPluginSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.installer.getSourceSignatures(pluginIds);
  }

  async getManagedPluginTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.installer.getTargetSignatures(pluginIds);
  }

  private async syncRuntimeEnabledPluginIds(
    manualPluginIds: readonly string[],
    previousEnabledPluginIds: readonly string[],
  ): Promise<RuntimePluginTransitionLifecycleState> {
    let transitionState: RuntimePluginTransitionLifecycleState = {
      previousEnabledPluginIds,
      nextEnabledPluginIds: previousEnabledPluginIds,
      newlyEnabledPluginIds: [],
      newlyDisabledPluginIds: [],
    };

    await this.configRepository.update(async (config) => {
      let nextConfig = await applyManuallyManagedPluginIdsToOpenClawConfig(
        this.configRepository,
        this.pluginFileSystem,
        config,
        manualPluginIds,
      );
      const nextEnabledPluginIds = resolveEffectivePluginIdsForConfig(nextConfig, manualPluginIds);
      transitionState = computeTransitionLifecycleState(previousEnabledPluginIds, nextEnabledPluginIds);
      nextConfig = await this.lifecycleRunner.applyTransitionConfig(nextConfig, transitionState);
      replaceConfigContents(config, nextConfig);
    });

    await this.lifecycleRunner.runTransitionSideEffects(transitionState);
    return transitionState;
  }

  private async reconcileStartupPluginLifecycles(enabledPluginIds: readonly string[]): Promise<void> {
    await this.configRepository.update(async (config) => {
      const nextConfig = await this.lifecycleRunner.applyStartupConfig(config, enabledPluginIds);
      replaceConfigContents(config, nextConfig);
    });

    await this.lifecycleRunner.runStartupSideEffects(enabledPluginIds);
  }
}
