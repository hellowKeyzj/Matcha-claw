import { normalizePluginIds } from '../../../../../bootstrap/runtime-config';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import type { OpenClawConfigRepositoryPort } from '../../infrastructure/openclaw-config-repository';
import { isChannelDerivedPluginId } from '../../projections/openclaw-channel-plugin-bindings';
import {
  cleanupUnconfiguredExternalChannelPluginDirs,
} from '../../projections/openclaw-plugin-channel-config';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
  resolveEffectivePluginIdsForConfig,
} from '../../projections/openclaw-plugin-config-service';
import { CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS } from '../../projections/openclaw-managed-plugin-catalog';

const MATCHACLAW_MANAGED_PLUGIN_IDS = new Set(
  CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.map((definition) => definition.id),
);

export interface OpenClawPluginConfigWorkflowDeps {
  readonly configRepository: OpenClawConfigRepositoryPort;
  readonly pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries' | 'remove'>;
}

export class OpenClawPluginConfigWorkflow {
  constructor(private readonly deps: OpenClawPluginConfigWorkflowDeps) {}

  async readEnabledPluginIds(): Promise<string[]> {
    return (await readManuallyManagedPluginIdsFromConfig(
      this.deps.configRepository,
      this.deps.pluginFileSystem,
      await this.deps.configRepository.read(),
    ))
      .filter((pluginId) => MATCHACLAW_MANAGED_PLUGIN_IDS.has(pluginId));
  }

  async syncEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
    const normalizedManualPluginIds = normalizePluginIds(pluginIds).filter((pluginId) => !isChannelDerivedPluginId(pluginId));
    let effectivePluginIds: string[] = [];
    let finalConfig: Record<string, unknown> | null = null;
    await this.deps.configRepository.updateDirty(async (config) => {
      const nextConfig = await applyManuallyManagedPluginIdsToOpenClawConfig(
        this.deps.configRepository,
        this.deps.pluginFileSystem,
        config,
        normalizedManualPluginIds,
      );
      effectivePluginIds = resolveEffectivePluginIdsForConfig(nextConfig, normalizedManualPluginIds);
      replaceConfigContents(config, nextConfig);
      finalConfig = nextConfig;
      return { result: undefined, changed: true };
    });
    if (finalConfig) {
      await cleanupUnconfiguredExternalChannelPluginDirs(this.deps.configRepository, this.deps.pluginFileSystem, finalConfig);
    }
    return effectivePluginIds;
  }
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
