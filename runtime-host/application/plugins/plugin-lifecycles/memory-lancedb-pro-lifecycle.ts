import type { RuntimePluginLifecycle } from '../plugin-lifecycle-types';

const MEMORY_PLUGIN_ID = 'memory-lancedb-pro';
const LOCAL_MINILM_PROVIDER = 'local-minilm';
const LOCAL_MINILM_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_EXTRACT_MAX_CHARS = 8000;
const DEFAULT_EXTRACT_MIN_MESSAGES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const currentValue = target[key];
  if (isRecord(currentValue)) {
    return currentValue;
  }
  const nextValue: Record<string, unknown> = {};
  target[key] = nextValue;
  return nextValue;
}

function ensureMemoryPluginConfigured(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = ensureRecord(config, 'plugins');
  const slots = ensureRecord(plugins, 'slots');
  slots.memory = MEMORY_PLUGIN_ID;

  const entries = ensureRecord(plugins, 'entries');
  const pluginEntry = ensureRecord(entries, MEMORY_PLUGIN_ID);
  const pluginConfig = ensureRecord(pluginEntry, 'config');
  const embedding = ensureRecord(pluginConfig, 'embedding');
  const provider = typeof embedding.provider === 'string' ? embedding.provider.trim() : '';
  const model = typeof embedding.model === 'string' ? embedding.model.trim() : '';

  if (typeof pluginConfig.autoCapture !== 'boolean') {
    pluginConfig.autoCapture = true;
  }
  if (typeof pluginConfig.autoRecall !== 'boolean') {
    pluginConfig.autoRecall = true;
  }
  if (typeof pluginConfig.smartExtraction !== 'boolean') {
    pluginConfig.smartExtraction = true;
  }
  if (typeof pluginConfig.extractMinMessages !== 'number') {
    pluginConfig.extractMinMessages = DEFAULT_EXTRACT_MIN_MESSAGES;
  }
  if (typeof pluginConfig.extractMaxChars !== 'number') {
    pluginConfig.extractMaxChars = DEFAULT_EXTRACT_MAX_CHARS;
  }

  const sessionMemory = ensureRecord(pluginConfig, 'sessionMemory');
  if (typeof sessionMemory.enabled !== 'boolean') {
    sessionMemory.enabled = false;
  }

  if (!provider) {
    embedding.provider = LOCAL_MINILM_PROVIDER;
    if (!model) {
      embedding.model = LOCAL_MINILM_MODEL;
    }
    return config;
  }

  if (provider === LOCAL_MINILM_PROVIDER && !model) {
    embedding.model = LOCAL_MINILM_MODEL;
  }

  return config;
}

function releaseMemorySlot(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.plugins)) {
    return config;
  }

  const plugins = config.plugins as Record<string, unknown>;
  if (!isRecord(plugins.slots)) {
    return config;
  }

  const slots = plugins.slots as Record<string, unknown>;
  if (slots.memory === MEMORY_PLUGIN_ID) {
    delete slots.memory;
  }

  if (Object.keys(slots).length === 0) {
    delete plugins.slots;
  }

  return config;
}

export const memoryLancedbProLifecycle: RuntimePluginLifecycle = {
  id: MEMORY_PLUGIN_ID,
  onEnableConfig: async (config) => ensureMemoryPluginConfigured(config),
  onDisableConfig: async (config) => releaseMemorySlot(config),
  onStartupConfig: async (config) => ensureMemoryPluginConfigured(config),
};
