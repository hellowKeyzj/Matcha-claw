import type { RuntimeHostCatalogPlugin, RuntimeHostCatalogPluginGroup } from '../../bootstrap/runtime-config';
import type { RuntimeHostPluginManifest } from '../../shared/types';

const CHANNEL_GROUP_CATEGORIES = new Set(['channel', 'channels']);
const CHANNEL_GROUP_PLUGIN_IDS = new Set(['voice-call']);
const MODEL_RUNTIME_DESCRIPTION_PATTERN = /runtime package/i;

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase();
}

export function pickCatalogGroup(params: {
  id?: string;
  category: string;
  description?: string;
  controlMode?: RuntimeHostCatalogPlugin['controlMode'];
  groupHints?: RuntimeHostPluginManifest['groupHints'];
}): RuntimeHostCatalogPluginGroup {
  if (params.controlMode === 'channel-config' || params.groupHints?.channel) {
    return 'channel';
  }

  if (typeof params.id === 'string' && CHANNEL_GROUP_PLUGIN_IDS.has(params.id)) {
    return 'channel';
  }

  const category = normalizeCategory(params.category);
  if (CHANNEL_GROUP_CATEGORIES.has(category)) {
    return 'channel';
  }

  if (params.groupHints?.model) {
    return 'model';
  }

  if (
    typeof params.id === 'string'
    && params.id.startsWith('@openclaw/')
    && typeof params.description === 'string'
    && MODEL_RUNTIME_DESCRIPTION_PATTERN.test(params.description)
  ) {
    return 'model';
  }

  return 'general';
}
