import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const CATALOG_UNAVAILABLE = {
  success: false,
  error: 'Plugin catalog is unavailable',
} as const;

const RUNTIME_UNAVAILABLE = {
  success: false,
  error: 'Plugin runtime is unavailable',
} as const;

export type PluginRuntimeId = 'openclaw';

export type PluginCatalogItem = Readonly<{
  runtime: PluginRuntimeId;
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw';
  enabled: boolean;
  installed: boolean;
  updateAvailable: boolean;
  companionSkillReady: boolean;
  description?: string;
  companionSkillSlugs?: string[];
}>;

export type PluginCatalog = Readonly<{
  success: true;
  execution: Readonly<{ enabledPluginIds: string[] }>;
  plugins: readonly PluginCatalogItem[];
}>;

type PluginLifecycle = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';

type PluginRuntimeState = Readonly<{
  lifecycle: PluginLifecycle;
  runtimeLifecycle: PluginLifecycle;
  activePluginCount: number;
  enabledPluginIds: string[];
}>;

type PluginRuntimeHealth = Readonly<{
  ok: boolean;
  lifecycle: PluginLifecycle;
  activePluginCount: number;
  degradedPlugins: string[];
  error?: string;
}>;

export type PluginRuntime = Readonly<{
  success: true;
  state: PluginRuntimeState;
  health: PluginRuntimeHealth;
  execution: Readonly<{ enabledPluginIds: string[] }>;
}>;

export type PluginConfigurationInput = Readonly<{
  runtime: PluginRuntimeId;
  pluginId: string;
  enabled: boolean;
}>;

export type PluginConfigurationOutcome = Readonly<{
  outcome: 'configured' | 'rejected' | 'unknown';
}>;

export type PluginOperation = 'install' | 'update' | 'uninstall';

export type PluginOperationInput = Readonly<{
  runtime: PluginRuntimeId;
  operation: PluginOperation;
  pluginId: string;
}>;

export type PluginOperationOutcome = Readonly<{
  outcome: 'configured' | 'rejected' | 'unknown';
}>;

export type PluginCatalogTransportResponse = Readonly<{
  status: 200 | 503;
  body: PluginCatalog | typeof CATALOG_UNAVAILABLE;
}>;

export type PluginRuntimeTransportResponse = Readonly<{
  status: 200 | 503;
  body: PluginRuntime | typeof RUNTIME_UNAVAILABLE;
}>;

export interface PluginsTransport {
  catalog(): Promise<PluginCatalogTransportResponse>;
  runtime(): Promise<PluginRuntimeTransportResponse>;
  configuration(input: unknown): Promise<PluginConfigurationOutcome>;
  operation(input: unknown): Promise<PluginOperationOutcome>;
}

export function createPluginsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): PluginsTransport {
  return {
    async catalog(): Promise<PluginCatalogTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/catalog',
        issuer,
        decision: {
          endpoint: '/api/plugins/catalog',
          scope: 'plugins:read',
          capability: 'plugins.catalog.read',
          subject: 'plugin-catalog',
        },
        method: 'GET',
        fetcher,
      });
      if (response?.status === 200 && isPluginCatalog(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: CATALOG_UNAVAILABLE };
    },
    async runtime(): Promise<PluginRuntimeTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/runtime',
        issuer,
        decision: {
          endpoint: '/api/plugins/runtime',
          scope: 'plugins:read',
          capability: 'plugins.runtime.read',
          subject: 'plugin-runtime',
        },
        method: 'GET',
        fetcher,
      });
      if (response?.status === 200 && isPluginRuntime(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: RUNTIME_UNAVAILABLE };
    },
    async configuration(input): Promise<PluginConfigurationOutcome> {
      if (!isPluginConfigurationInput(input)) return { outcome: 'unknown' };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/configuration',
        issuer,
        decision: {
          endpoint: '/api/plugins/configuration',
          scope: 'plugins:write',
          capability: 'plugins.configuration',
          subject: 'plugin-configuration',
        },
        method: 'POST',
        fetcher,
        body: input,
      });
      if (response?.status === 200 && isPluginConfigurationOutcome(response.body)) return response.body;
      return { outcome: 'unknown' };
    },
    async operation(input): Promise<PluginOperationOutcome> {
      if (!isPluginOperationInput(input)) return { outcome: 'unknown' };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/operation',
        issuer,
        decision: {
          endpoint: '/api/plugins/operation',
          scope: 'plugins:write',
          capability: 'plugins:operation',
          subject: 'plugin-operation',
        },
        method: 'POST',
        fetcher,
        body: input,
      });
      if (response?.status === 200 && isPluginOperationOutcome(response.body)) return response.body;
      return { outcome: 'unknown' };
    },
  };
}

function isPluginCatalog(value: unknown): value is PluginCatalog {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'execution', 'plugins'])
    && value.success === true
    && isPluginExecution(value.execution)
    && Array.isArray(value.plugins)
    && value.plugins.every(isPluginCatalogItem);
}

function isPluginCatalogItem(value: unknown): value is PluginCatalogItem {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['runtime', 'id', 'name', 'version', 'kind', 'platform', 'enabled', 'installed', 'updateAvailable', 'companionSkillReady', 'description', 'companionSkillSlugs'])
    || !hasOwnKeys(value, ['runtime', 'id', 'name', 'version', 'kind', 'platform', 'enabled', 'installed', 'updateAvailable', 'companionSkillReady'])) return false;
  return isPluginRuntimeId(value.runtime)
    && value.platform === 'openclaw'
    && isIdentity(value.id)
    && isNonblankText(value.name)
    && isNonblankText(value.version)
    && (value.kind === 'builtin' || value.kind === 'third-party')
    && typeof value.enabled === 'boolean'
    && typeof value.installed === 'boolean'
    && typeof value.updateAvailable === 'boolean'
    && typeof value.companionSkillReady === 'boolean'
    && (value.description === undefined || typeof value.description === 'string')
    && (value.companionSkillSlugs === undefined
      || (Array.isArray(value.companionSkillSlugs) && value.companionSkillSlugs.every(isIdentity)));
}

function isPluginRuntimeId(value: unknown): value is PluginRuntimeId {
  return value === 'openclaw';
}

function isPluginRuntime(value: unknown): value is PluginRuntime {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'state', 'health', 'execution'])
    && value.success === true
    && isPluginRuntimeState(value.state)
    && isPluginRuntimeHealth(value.health)
    && isPluginExecution(value.execution);
}

function isPluginExecution(value: unknown): value is { enabledPluginIds: string[] } {
  return isRecord(value)
    && hasExactKeys(value, ['enabledPluginIds'])
    && Array.isArray(value.enabledPluginIds)
    && value.enabledPluginIds.every(isIdentity);
}

function isPluginRuntimeState(value: unknown): value is PluginRuntimeState {
  return isRecord(value)
    && hasExactKeys(value, ['lifecycle', 'runtimeLifecycle', 'activePluginCount', 'enabledPluginIds'])
    && isPluginLifecycle(value.lifecycle)
    && isPluginLifecycle(value.runtimeLifecycle)
    && typeof value.activePluginCount === 'number'
    && Number.isInteger(value.activePluginCount)
    && value.activePluginCount >= 0
    && Array.isArray(value.enabledPluginIds)
    && value.enabledPluginIds.every(isIdentity);
}

function isPluginRuntimeHealth(value: unknown): value is PluginRuntimeHealth {
  return isRecord(value)
    && hasOnlyKeys(value, ['ok', 'lifecycle', 'activePluginCount', 'degradedPlugins', 'error'])
    && hasOwnKeys(value, ['ok', 'lifecycle', 'activePluginCount', 'degradedPlugins'])
    && typeof value.ok === 'boolean'
    && isPluginLifecycle(value.lifecycle)
    && typeof value.activePluginCount === 'number'
    && Number.isInteger(value.activePluginCount)
    && value.activePluginCount >= 0
    && Array.isArray(value.degradedPlugins)
    && value.degradedPlugins.every(isIdentity)
    && (value.error === undefined || typeof value.error === 'string');
}

function isPluginLifecycle(value: unknown): value is PluginLifecycle {
  return value === 'starting'
    || value === 'running'
    || value === 'restarting'
    || value === 'stopping'
    || value === 'stopped'
    || value === 'error';
}

function isPluginConfigurationInput(value: unknown): value is PluginConfigurationInput {
  return isRecord(value)
    && hasExactKeys(value, ['runtime', 'pluginId', 'enabled'])
    && isPluginRuntimeId(value.runtime)
    && isIdentity(value.pluginId)
    && typeof value.enabled === 'boolean';
}

function isPluginConfigurationOutcome(value: unknown): value is PluginConfigurationOutcome {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'configured' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isPluginOperationInput(value: unknown): value is PluginOperationInput {
  return isRecord(value)
    && hasExactKeys(value, ['runtime', 'operation', 'pluginId'])
    && isPluginRuntimeId(value.runtime)
    && (value.operation === 'install' || value.operation === 'update' || value.operation === 'uninstall')
    && isIdentity(value.pluginId);
}

function isPluginOperationOutcome(value: unknown): value is PluginOperationOutcome {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'configured' || value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/\s/.test(value);
}

function isNonblankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
