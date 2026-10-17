import type { IncomingMessage, ServerResponse } from 'http';
import type {
  PluginConfigurationInput, PluginMutationReceipt, PluginOperationInput, PluginsTransport,
} from '../../main/runtime-host-delivery/transport/plugins';
import {
  isPluginCatalog, isPluginRuntime, isPluginScope, isPluginConfigurationInput,
  isPluginOperationInput, isPluginMutationReceipt,
} from '../../../src/types/plugins';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { parseJsonBody, sendJson } from '../route-utils';

const CATALOG_INVALID = { success: false, error: 'Plugin catalog request is invalid' } as const;
const CATALOG_UNAVAILABLE = { success: false, error: 'Plugin catalog is unavailable' } as const;
const RUNTIME_INVALID = { success: false, error: 'Plugin runtime request is invalid' } as const;
const RUNTIME_UNAVAILABLE = { success: false, error: 'Plugin runtime is unavailable' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handlePluginsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: PluginsTransport,
): Promise<boolean> {
  if ((url.pathname === '/api/plugins/catalog' || url.pathname === '/api/plugins/runtime') && req.method === 'GET') {
    const catalog = url.pathname === '/api/plugins/catalog';
    const invalid = catalog ? CATALOG_INVALID : RUNTIME_INVALID;
    const unavailable = catalog ? CATALOG_UNAVAILABLE : RUNTIME_UNAVAILABLE;
    let body: unknown;
    try { body = await parseJsonBody(req); } catch {
      sendJson(res, 400, invalid);
      return true;
    }
    const scope = readRuntimeScopeQuery(url.searchParams);
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0
      || (scope !== undefined && (!isPluginScope(scope) || (!catalog && scope.kind !== 'runtime-instance')))) {
      sendJson(res, 400, invalid);
      return true;
    }
    try {
      const response = catalog ? await transport.catalog(scope) : await transport.runtime(scope);
      if (response.status === 200 && (catalog ? isPluginCatalog(response.body, scope) : isPluginRuntime(response.body))) {
        sendJson(res, 200, response.body);
      } else sendJson(res, 503, unavailable);
    } catch { sendJson(res, 503, unavailable); }
    return true;
  }
  if (url.pathname === '/api/plugins/configuration' && req.method === 'POST') {
    return handleMutation(req, res, (input) => transport.configuration(input), isPluginConfigurationInput);
  }
  if (url.pathname === '/api/plugins/operation' && req.method === 'POST') {
    return handleMutation(req, res, (input) => transport.operation(input), isPluginOperationInput);
  }
  return false;
}

async function handleMutation<T extends PluginConfigurationInput | PluginOperationInput>(
  req: IncomingMessage,
  res: ServerResponse,
  execute: (input: unknown) => Promise<PluginMutationReceipt>,
  validate: (value: unknown) => value is T,
): Promise<true> {
  let body: unknown;
  try { body = await parseJsonBody(req); } catch {
    sendJson(res, 400, UNKNOWN);
    return true;
  }
  if (!validate(body)) {
    sendJson(res, 400, UNKNOWN);
    return true;
  }
  try {
    const result = await execute(body);
    if (isPluginMutationReceipt(result)) sendJson(res, 202, result);
    else sendJson(res, 503, UNKNOWN);
  } catch { sendJson(res, 503, UNKNOWN); }
  return true;
}
