import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import type { PluginCatalogDiscoveryWorkflow } from '../workflows/plugin-runtime/plugin-catalog-discovery-workflow';
export type {
  PluginCatalogKindPolicyPort,
  PluginCatalogLocationPort,
} from '../workflows/plugin-runtime/plugin-catalog-discovery-workflow';

function compareCatalogPlugins(
  left: RuntimeHostCatalogPlugin,
  right: RuntimeHostCatalogPlugin,
): number {
  if (left.platform !== right.platform) {
    return left.platform.localeCompare(right.platform, 'en');
  }
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind, 'en');
  }
  return left.id.localeCompare(right.id, 'en');
}

export function mergePluginCatalogSnapshots(
  preferred: readonly RuntimeHostCatalogPlugin[],
  fallback: readonly RuntimeHostCatalogPlugin[],
): RuntimeHostCatalogPlugin[] {
  const merged = new Map<string, RuntimeHostCatalogPlugin>();
  for (const plugin of fallback) {
    merged.set(plugin.id, plugin);
  }
  for (const plugin of preferred) {
    merged.set(plugin.id, plugin);
  }
  return Array.from(merged.values()).sort(compareCatalogPlugins);
}

export class PluginCatalogRepository {
  constructor(
    private readonly discoveryWorkflow: Pick<PluginCatalogDiscoveryWorkflow, 'discover'>,
  ) {}

  async discover(): Promise<RuntimeHostCatalogPlugin[]> {
    return await this.discoveryWorkflow.discover();
  }
}
