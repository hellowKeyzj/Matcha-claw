type JsonRecord = Record<string, unknown>;

export type InstallSource = 'npm' | 'archive' | 'path';

export interface UpsertPluginInstallRecordParams {
  pluginId: string;
  source: InstallSource;
  installPath?: string;
  sourcePath?: string;
  spec?: string;
  version?: string;
  now?: () => string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function shallowEqualRecord(left: JsonRecord, right: JsonRecord): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

export function upsertPluginInstallRecord(
  config: JsonRecord,
  params: UpsertPluginInstallRecordParams,
): { nextConfig: JsonRecord; changed: boolean } {
  const pluginId = params.pluginId.trim();
  if (!pluginId) {
    return { nextConfig: config, changed: false };
  }

  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const installs = isRecord(plugins.installs) ? plugins.installs : {};
  const currentRaw = installs[pluginId];
  const current = isRecord(currentRaw) ? currentRaw : {};

  const now = params.now ?? (() => new Date().toISOString());
  const timestamp = now();

  const nextRecord: JsonRecord = {
    ...current,
    source: params.source,
  };

  const sourcePath = normalizeOptionalString(params.sourcePath);
  if (sourcePath) {
    nextRecord.sourcePath = sourcePath;
  }

  const installPath = normalizeOptionalString(params.installPath);
  if (installPath) {
    nextRecord.installPath = installPath;
  }

  const spec = normalizeOptionalString(params.spec);
  if (spec) {
    nextRecord.spec = spec;
  }

  const version = normalizeOptionalString(params.version);
  if (version) {
    nextRecord.version = version;
  }

  if (typeof nextRecord.installedAt !== 'string' || !nextRecord.installedAt.trim()) {
    nextRecord.installedAt = timestamp;
  }
  if (typeof nextRecord.resolvedAt !== 'string' || !nextRecord.resolvedAt.trim()) {
    nextRecord.resolvedAt = timestamp;
  }

  const installsChanged = !isRecord(plugins.installs) || !shallowEqualRecord(current, nextRecord);
  if (!installsChanged && isRecord(config.plugins)) {
    return { nextConfig: config, changed: false };
  }

  const nextInstalls: JsonRecord = {
    ...installs,
    [pluginId]: nextRecord,
  };
  const nextPlugins: JsonRecord = {
    ...plugins,
    installs: nextInstalls,
  };

  return {
    nextConfig: {
      ...config,
      plugins: nextPlugins,
    },
    changed: true,
  };
}

