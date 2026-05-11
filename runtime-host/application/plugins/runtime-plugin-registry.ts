import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import {
  buildLocalPluginsRuntimePayload,
  buildLocalRuntimeHealth,
  buildLocalRuntimeState,
} from '../runtime-host/runtime-state';
import {
  mergePluginCatalogSnapshots,
} from './catalog';
import { pickCatalogGroup } from './plugin-groups';
import type { RuntimePluginRepositoryPort } from './runtime-plugin-service';
import type { RuntimeJobSnapshot, RuntimeLifecycleState } from '../common/runtime-contracts';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { GatewayControlPort } from '../runtime-host/parent-shell-port';
import type { PluginRuntimeJobPort } from './plugin-runtime-jobs';

export interface RuntimePluginRegistryDeps {
  readonly fallbackEnabledPluginIds: string[];
  readonly injectedPluginCatalog: RuntimeHostCatalogPlugin[];
  readonly getLifecycleState: () => RuntimeLifecycleState;
  readonly logger: RuntimeHostLogger;
  readonly jobs: PluginRuntimeJobPort;
  readonly repository: RuntimePluginRepositoryPort;
}

export class RuntimePluginRegistry {
  private enabledPluginIds: string[];
  private pluginCatalog: RuntimeHostCatalogPlugin[];

  constructor(private readonly deps: RuntimePluginRegistryDeps) {
    this.enabledPluginIds = [...deps.fallbackEnabledPluginIds];
    this.pluginCatalog = [...deps.injectedPluginCatalog];
  }

  snapshotRuntimeState() {
    return buildLocalRuntimeState(this.snapshotParams());
  }

  snapshotRuntimeHealth(state: ReturnType<typeof buildLocalRuntimeState>) {
    return buildLocalRuntimeHealth(state);
  }

  snapshotPluginsRuntimePayload() {
    return buildLocalPluginsRuntimePayload(this.snapshotParams());
  }

  getEnabledPluginIds(): string[] {
    return [...this.enabledPluginIds];
  }

  getPluginCatalog(): RuntimeHostCatalogPlugin[] {
    return [...this.pluginCatalog];
  }

  enqueueRefresh(): RuntimeJobSnapshot {
    return this.deps.jobs.submitRefreshCatalog().job;
  }

  getRefreshJob(): RuntimeJobSnapshot | null {
    return this.deps.jobs.getRefreshCatalogJob();
  }

  async refreshNow(): Promise<void> {
    const enabledFromConfig = await this.deps.repository.listEnabledPluginIds();
    try {
      const discoveredCatalog = await this.deps.repository.listRuntimePluginCatalog();
      this.pluginCatalog = mergePluginCatalogSnapshots(discoveredCatalog, this.deps.injectedPluginCatalog);
      this.enabledPluginIds = enabledFromConfig.length > 0
        ? enabledFromConfig
        : [...this.deps.fallbackEnabledPluginIds];
    } catch (error) {
      this.pluginCatalog = [...this.deps.injectedPluginCatalog];
      this.enabledPluginIds = enabledFromConfig.length > 0
        ? enabledFromConfig
        : [...this.deps.fallbackEnabledPluginIds];
      this.deps.logger.warn('failed to refresh plugin catalog', error);
    }
  }

  async setEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
    this.enabledPluginIds = await this.deps.repository.setEnabledPluginIds(pluginIds);
    this.enqueueRefresh();
    return [...this.enabledPluginIds];
  }

  async executeSetEnabledPluginIds(
    pluginIds: readonly string[],
    gatewayControl: GatewayControlPort,
  ): Promise<unknown> {
    await this.setEnabledPluginIds(pluginIds);
    const restartResponse = await gatewayControl.restartGateway();
    if (!restartResponse.success) {
      throw new Error(restartResponse.error?.message ?? 'gateway restart failed');
    }
    return {
      ...(this.snapshotPluginsRuntimePayload() as Record<string, unknown>),
      refreshJob: this.getRefreshJob(),
    };
  }

  private snapshotParams() {
    return {
      lifecycle: this.deps.getLifecycleState(),
      enabledPluginIds: this.enabledPluginIds,
      pluginCatalog: this.pluginCatalog,
    };
  }
}

export function parseFallbackEnabledPluginIds(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseInjectedPluginCatalog(rawValue: string | undefined): RuntimeHostCatalogPlugin[] {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is RuntimeHostCatalogPlugin => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Record<string, unknown>;
        return typeof candidate.id === 'string'
          && typeof candidate.name === 'string'
          && typeof candidate.version === 'string'
          && typeof candidate.kind === 'string'
          && typeof candidate.category === 'string';
      })
      .map((item) => ({
        ...item,
        group: item.group === 'channel' || item.group === 'model' || item.group === 'general'
          ? item.group
          : pickCatalogGroup({
            id: item.id,
            category: item.category,
            description: item.description,
            controlMode: item.controlMode === 'channel-config' ? 'channel-config' : 'manual',
          }),
        platform: item.platform === 'matchaclaw' ? 'matchaclaw' : 'openclaw',
      }));
  } catch {
    return [];
  }
}
