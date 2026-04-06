export const DEFAULT_ENABLED_PLUGIN_IDS: readonly string[] = [];
export const DEFAULT_PLUGIN_EXECUTION_ENABLED = true;

export interface RuntimeHostExecutionState {
  readonly pluginExecutionEnabled: boolean;
  readonly enabledPluginIds: readonly string[];
}

export interface RuntimeHostCatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: 'builtin' | 'third-party';
  readonly platform: 'openclaw' | 'matchaclaw';
  readonly category: string;
  readonly description?: string;
}

export function normalizePluginIds(ids: readonly string[]): string[] {
  return Array.from(new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ));
}
