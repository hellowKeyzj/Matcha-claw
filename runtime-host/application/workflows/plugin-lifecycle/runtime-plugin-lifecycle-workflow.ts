import { normalizePluginIds, type RuntimeHostCatalogPlugin } from '../../../bootstrap/runtime-config';
import type { ManagedPluginCatalogPort, ManagedPluginInstallerPort, ManagedRegistryPluginSnapshot } from '../../plugins/managed-plugin-catalog';
import type { RuntimePluginLifecycleRunner } from '../../plugins/plugin-lifecycle-registry';
import type { RuntimePluginTransitionLifecycleState } from '../../plugins/plugin-lifecycle-types';
import type {
  RuntimePluginCatalogProjectionPort,
  RuntimePluginConfigProjectionPort,
  RuntimePluginConfigStorePort,
} from '../../plugins/runtime-plugin-service';

export interface RuntimePluginLifecycleWorkflowDeps {
  readonly configRepository: RuntimePluginConfigStorePort;
  readonly configProjection: RuntimePluginConfigProjectionPort;
  readonly catalogProjection: RuntimePluginCatalogProjectionPort;
  readonly installer: ManagedPluginInstallerPort;
  readonly managedPluginCatalog: ManagedPluginCatalogPort;
  readonly lifecycleRunner: RuntimePluginLifecycleRunner;
}

export class RuntimePluginLifecycleWorkflow {
  constructor(private readonly deps: RuntimePluginLifecycleWorkflowDeps) {}

  async ensureManagedPluginInstalled(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    const definition = this.deps.managedPluginCatalog.findCapabilityDefinition(pluginId);
    if (!definition) {
      throw new Error(`Plugin ${pluginId} is not managed by the MatchaClaw plugin center`);
    }
    await this.deps.installer.ensureDefinitionInstalled(definition, options);
  }

  async listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]> {
    const managedRegistryCatalog = await Promise.all(
      this.deps.managedPluginCatalog.listCapabilityDefinitions().map(async (definition) => await this.deps.installer.discoverRegistryPlugin(definition)),
    );
    return managedRegistryCatalog
      .filter((plugin): plugin is ManagedRegistryPluginSnapshot => Boolean(plugin))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }

  async listEnabledPluginIds(): Promise<string[]> {
    return (await this.deps.configProjection.readManuallyManagedPluginIds(await this.deps.configRepository.read()))
      .filter((pluginId) => Boolean(this.deps.managedPluginCatalog.findCapabilityDefinition(pluginId)));
  }

  async listConfiguredManagedPluginIds(): Promise<string[]> {
    return await listConfiguredManagedPluginIdsFromConfig(await this.deps.configRepository.read(), this.deps.managedPluginCatalog);
  }

  async getManagedPluginSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.deps.installer.getSourceSignatures(pluginIds);
  }

  async getManagedPluginTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.deps.installer.getTargetSignatures(pluginIds);
  }

  async ensureConfiguredManagedPluginsInstalled(options: { forceInstall?: boolean } = {}): Promise<string[]> {
    const enabledPluginIds = filterManagedPluginIds(await this.listConfiguredManagedPluginIds(), this.deps.managedPluginCatalog);
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
    const normalizedManualPluginIds = normalizeManualPluginIds(
      pluginIds,
      this.deps.managedPluginCatalog,
      this.deps.catalogProjection,
    );

    for (const pluginId of normalizedManualPluginIds) {
      await this.ensureManagedPluginInstalled(pluginId);
    }

    const transitionState = await this.syncRuntimeEnabledPluginIds(normalizedManualPluginIds, previousEnabledPluginIds);
    return [...transitionState.nextEnabledPluginIds];
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

    await this.deps.configRepository.updateDirty(async (config) => {
      let nextConfig = await this.deps.configProjection.applyManuallyManagedPluginIds(config, manualPluginIds);
      const nextEnabledPluginIds = this.deps.configProjection.resolveEffectivePluginIds(nextConfig, manualPluginIds);
      transitionState = computeTransitionLifecycleState(previousEnabledPluginIds, nextEnabledPluginIds);
      nextConfig = await this.deps.lifecycleRunner.applyTransitionConfig(nextConfig, transitionState);
      replaceConfigContents(config, nextConfig);
      return { result: undefined, changed: true };
    });

    await this.deps.lifecycleRunner.runTransitionSideEffects(transitionState);
    return transitionState;
  }

  private async reconcileStartupPluginLifecycles(enabledPluginIds: readonly string[]): Promise<void> {
    await this.deps.configRepository.updateDirty(async (config) => {
      const nextConfig = await this.deps.lifecycleRunner.applyStartupConfig(config, enabledPluginIds);
      replaceConfigContents(config, nextConfig);
      return { result: undefined, changed: true };
    });

    await this.deps.lifecycleRunner.runStartupSideEffects(enabledPluginIds);
  }
}

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

function normalizeManualPluginIds(
  pluginIds: readonly string[],
  catalog: ManagedPluginCatalogPort,
  catalogProjection: RuntimePluginCatalogProjectionPort,
): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => (
    !catalogProjection.isChannelDerivedPluginId(pluginId)
    && Boolean(catalog.findCapabilityDefinition(pluginId))
  ));
}

function filterManagedPluginIds(pluginIds: readonly string[], catalog: ManagedPluginCatalogPort): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => Boolean(catalog.findCapabilityDefinition(pluginId)));
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

async function listConfiguredManagedPluginIdsFromConfig(config: Record<string, unknown>, catalog: ManagedPluginCatalogPort): Promise<string[]> {
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
    (pluginId) => Boolean(catalog.findDefinition(pluginId)),
  );
}
