export const DEFAULT_ENABLED_PLUGIN_IDS: readonly string[] = [];

export type RuntimeHostCatalogPluginGroup = 'channel' | 'model' | 'general';

export interface RuntimeHostExecutionState {
  readonly enabledPluginIds: readonly string[];
}

export interface RuntimeHostCatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: 'builtin' | 'third-party';
  readonly platform: 'openclaw' | 'matchaclaw';
  readonly category: string;
  readonly group: RuntimeHostCatalogPluginGroup;
  readonly description?: string;
  readonly controlMode?: 'manual' | 'channel-config';
}

export function normalizePluginIds(ids: readonly string[]): string[] {
  return Array.from(new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ));
}
