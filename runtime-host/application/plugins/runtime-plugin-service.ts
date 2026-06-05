import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import type { RuntimePluginLifecycleWorkflow } from '../workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow';

export interface RuntimePluginConfigStorePort {
  read(): Promise<Record<string, unknown>>;
  updateDirty<T>(mutate: (config: Record<string, unknown>) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T>;
}

export interface RuntimePluginConfigProjectionPort {
  readManuallyManagedPluginIds(config: Record<string, unknown>): Promise<string[]>;
  applyManuallyManagedPluginIds(config: Record<string, unknown>, manualPluginIds: readonly string[]): Promise<Record<string, unknown>>;
  resolveEffectivePluginIds(config: Record<string, unknown>, manualPluginIds: readonly string[]): string[];
}

export interface RuntimePluginCatalogProjectionPort {
  isChannelDerivedPluginId(pluginId: string): boolean;
}

export interface PluginRuntimePort {
  snapshotPluginsRuntimePayload(): unknown;
  enqueueRefresh(): unknown;
  getRefreshJob(): unknown;
  getEnabledPluginIds(): string[];
  getPluginCatalog(): Array<Record<string, any>>;
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
    private readonly lifecycleWorkflow: Pick<RuntimePluginLifecycleWorkflow,
      | 'ensureManagedPluginInstalled'
      | 'listRuntimePluginCatalog'
      | 'listEnabledPluginIds'
      | 'listConfiguredManagedPluginIds'
      | 'ensureConfiguredManagedPluginsInstalled'
      | 'ensureRuntimePluginEnabled'
      | 'setEnabledPluginIds'
      | 'getManagedPluginSourceSignatures'
      | 'getManagedPluginTargetSignatures'
    >,
  ) {}

  async ensureManagedPluginInstalled(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    await this.lifecycleWorkflow.ensureManagedPluginInstalled(pluginId, options);
  }

  async listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]> {
    return await this.lifecycleWorkflow.listRuntimePluginCatalog();
  }

  async listEnabledPluginIds(): Promise<string[]> {
    return await this.lifecycleWorkflow.listEnabledPluginIds();
  }

  async listConfiguredManagedPluginIds(): Promise<string[]> {
    return await this.lifecycleWorkflow.listConfiguredManagedPluginIds();
  }

  async ensureConfiguredManagedPluginsInstalled(options: { forceInstall?: boolean } = {}): Promise<string[]> {
    return await this.lifecycleWorkflow.ensureConfiguredManagedPluginsInstalled(options);
  }

  async ensureRuntimePluginEnabled(pluginId: string): Promise<string[]> {
    return await this.lifecycleWorkflow.ensureRuntimePluginEnabled(pluginId);
  }

  async setEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
    return await this.lifecycleWorkflow.setEnabledPluginIds(pluginIds);
  }

  async getManagedPluginSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.lifecycleWorkflow.getManagedPluginSourceSignatures(pluginIds);
  }

  async getManagedPluginTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    return await this.lifecycleWorkflow.getManagedPluginTargetSignatures(pluginIds);
  }
}
