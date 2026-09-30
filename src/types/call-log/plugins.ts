import type { CallDetailByModule } from '../call-log';

export type PluginCallOutcome = 'configured' | 'rejected' | 'unknown';

export type PluginCallDetail =
  | {
      kind: 'catalog';
      pluginCount: number | null;
      installedCount: number | null;
      enabledCount: number | null;
    }
  | {
      kind: 'runtime';
      pluginCount: number | null;
      enabledCount: number | null;
      runningCount: number | null;
    }
  | {
      kind: 'configuration';
      pluginId: string | null;
      enabled: boolean;
      outcome: PluginCallOutcome | null;
    }
  | {
      kind: 'operation';
      pluginId: string | null;
      operation: 'install' | 'update' | 'uninstall';
      outcome: PluginCallOutcome | null;
    };

declare module '../call-log' {
  interface CallDetailByModule {
    plugins: PluginCallDetail;
  }
}

export type PluginsCallDetail = CallDetailByModule['plugins'];

export function decodePluginsCallDetail(value: unknown): PluginCallDetail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (detail.kind === 'catalog') {
    if (!hasKeys(detail, ['kind', 'pluginCount', 'installedCount', 'enabledCount'])
      || !count(detail.pluginCount) || !count(detail.installedCount) || !count(detail.enabledCount)) return null;
    return { kind: 'catalog', pluginCount: detail.pluginCount, installedCount: detail.installedCount, enabledCount: detail.enabledCount };
  }
  if (detail.kind === 'runtime') {
    if (!hasKeys(detail, ['kind', 'pluginCount', 'enabledCount', 'runningCount'])
      || !count(detail.pluginCount) || !count(detail.enabledCount) || !count(detail.runningCount)) return null;
    return { kind: 'runtime', pluginCount: detail.pluginCount, enabledCount: detail.enabledCount, runningCount: detail.runningCount };
  }
  if (!identity(detail.pluginId) || !outcome(detail.outcome)) return null;
  if (detail.kind === 'configuration') {
    if (!hasKeys(detail, ['kind', 'pluginId', 'enabled', 'outcome']) || typeof detail.enabled !== 'boolean') return null;
    return { kind: 'configuration', pluginId: detail.pluginId, enabled: detail.enabled, outcome: detail.outcome };
  }
  if (detail.kind === 'operation') {
    if (!hasKeys(detail, ['kind', 'pluginId', 'operation', 'outcome'])
      || (detail.operation !== 'install' && detail.operation !== 'update' && detail.operation !== 'uninstall')) return null;
    return { kind: 'operation', pluginId: detail.pluginId, operation: detail.operation, outcome: detail.outcome };
  }
  return null;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function count(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function identity(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value));
}

function outcome(value: unknown): value is PluginCallOutcome | null {
  return value === null || value === 'configured' || value === 'rejected' || value === 'unknown';
}
