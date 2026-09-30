import type { IncomingMessage, ServerResponse } from 'http';
import type {
  PluginCatalogItem,
  PluginConfigurationInput,
  PluginMutationReceipt,
  PluginOperationInput,
  PluginRuntime,
  PluginsTransport,
} from '../../main/runtime-host-delivery/transport/plugins';
import { parseJsonBody, sendJson } from '../route-utils';

const CATALOG_INVALID = {
  success: false,
  error: 'Plugin catalog request is invalid',
} as const;
const CATALOG_UNAVAILABLE = {
  success: false,
  error: 'Plugin catalog is unavailable',
} as const;
const RUNTIME_INVALID = {
  success: false,
  error: 'Plugin runtime request is invalid',
} as const;
const RUNTIME_UNAVAILABLE = {
  success: false,
  error: 'Plugin runtime is unavailable',
} as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handlePluginsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: PluginsTransport,
): Promise<boolean> {
  if (url.pathname === '/api/plugins/catalog' && req.method === 'GET') {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, CATALOG_INVALID);
      return true;
    }
    if (!isEmptyObject(body)) {
      sendJson(res, 400, CATALOG_INVALID);
      return true;
    }
    try {
      const response = await transport.catalog();
      if (response.status === 200 && isCatalog(response.body)) sendJson(res, 200, response.body);
      else sendJson(res, 503, CATALOG_UNAVAILABLE);
    } catch {
      sendJson(res, 503, CATALOG_UNAVAILABLE);
    }
    return true;
  }
  if (url.pathname === '/api/plugins/runtime' && req.method === 'GET') {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, RUNTIME_INVALID);
      return true;
    }
    if (!isEmptyObject(body)) {
      sendJson(res, 400, RUNTIME_INVALID);
      return true;
    }
    try {
      const response = await transport.runtime();
      if (response.status === 200 && isRuntime(response.body)) sendJson(res, 200, response.body);
      else sendJson(res, 503, RUNTIME_UNAVAILABLE);
    } catch {
      sendJson(res, 503, RUNTIME_UNAVAILABLE);
    }
    return true;
  }
  if (url.pathname === '/api/plugins/configuration' && req.method === 'POST') {
    return await handleMutation(req, res, transport.configuration, isConfigurationInput, transport);
  }
  if (url.pathname === '/api/plugins/operation' && req.method === 'POST') {
    return await handleMutation(req, res, transport.operation, isOperationInput, transport);
  }
  return false;
}

async function handleMutation<T extends PluginConfigurationInput | PluginOperationInput>(
  req: IncomingMessage,
  res: ServerResponse,
  execute: (input: unknown) => Promise<PluginMutationReceipt>,
  validate: (value: unknown) => value is T,
  _transport: PluginsTransport,
): Promise<true> {
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, UNKNOWN);
    return true;
  }
  if (!validate(body)) {
    sendJson(res, 400, UNKNOWN);
    return true;
  }
  try {
    const result = await execute(body);
    if (isReceipt(result)) sendJson(res, 202, result);
    else sendJson(res, 503, UNKNOWN);
  } catch {
    sendJson(res, 503, UNKNOWN);
  }
  return true;
}

function isConfigurationInput(value: unknown): value is PluginConfigurationInput {
  return isRecord(value)
    && hasExactKeys(value, ['runtime', 'pluginId', 'enabled'])
    && value.runtime === 'openclaw'
    && isIdentity(value.pluginId)
    && typeof value.enabled === 'boolean';
}

function isOperationInput(value: unknown): value is PluginOperationInput {
  return isRecord(value)
    && hasExactKeys(value, ['runtime', 'operation', 'pluginId'])
    && value.runtime === 'openclaw'
    && (value.operation === 'install' || value.operation === 'update' || value.operation === 'uninstall')
    && isIdentity(value.pluginId);
}

function isReceipt(value: unknown): value is PluginMutationReceipt {
  return isRecord(value)
    && hasExactKeys(value, ['callId', 'accepted'])
    && typeof value.callId === 'string'
    && /^[a-f0-9]{32}$/.test(value.callId)
    && value.accepted === true;
}

function isCatalog(value: unknown): value is Readonly<{
  success: true;
  execution: Readonly<{ enabledPluginIds: string[] }>;
  plugins: readonly PluginCatalogItem[];
}> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'execution', 'plugins'])
    && value.success === true
    && isExecution(value.execution)
    && Array.isArray(value.plugins)
    && value.plugins.every(isCatalogItem);
}

function isCatalogItem(value: unknown): value is PluginCatalogItem {
  return isRecord(value)
    && hasRequiredKeys(value, ['runtime', 'id', 'name', 'version', 'kind', 'platform', 'enabled', 'installed', 'updateAvailable', 'companionSkillReady'])
    && hasOnlyKeys(value, ['runtime', 'id', 'name', 'version', 'kind', 'platform', 'enabled', 'installed', 'updateAvailable', 'companionSkillReady', 'description', 'companionSkillSlugs'])
    && value.runtime === 'openclaw'
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
    && (value.companionSkillSlugs === undefined || (Array.isArray(value.companionSkillSlugs) && value.companionSkillSlugs.every(isIdentity)));
}

function isRuntime(value: unknown): value is PluginRuntime {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'state', 'health', 'execution'])
    && value.success === true
    && isRuntimeState(value.state)
    && isRuntimeHealth(value.health)
    && isExecution(value.execution);
}

function isExecution(value: unknown): value is { enabledPluginIds: string[] } {
  return isRecord(value)
    && hasExactKeys(value, ['enabledPluginIds'])
    && Array.isArray(value.enabledPluginIds)
    && value.enabledPluginIds.every(isIdentity);
}

function isRuntimeState(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['lifecycle', 'runtimeLifecycle', 'activePluginCount', 'enabledPluginIds'])
    && isLifecycle(value.lifecycle)
    && isLifecycle(value.runtimeLifecycle)
    && isCount(value.activePluginCount)
    && Array.isArray(value.enabledPluginIds)
    && value.enabledPluginIds.every(isIdentity);
}

function isRuntimeHealth(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['ok', 'lifecycle', 'activePluginCount', 'degradedPlugins', 'error'])
    && hasRequiredKeys(value, ['ok', 'lifecycle', 'activePluginCount', 'degradedPlugins'])
    && typeof value.ok === 'boolean'
    && isLifecycle(value.lifecycle)
    && isCount(value.activePluginCount)
    && Array.isArray(value.degradedPlugins)
    && value.degradedPlugins.every(isIdentity)
    && (value.error === undefined || typeof value.error === 'string');
}

function isLifecycle(value: unknown): boolean {
  return value === 'starting'
    || value === 'running'
    || value === 'restarting'
    || value === 'stopping'
    || value === 'stopped'
    || value === 'error';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isNonblankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
