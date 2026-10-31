import type {
  PluginConfigurationInput, PluginMutationReceipt, PluginOperationInput, PluginsTransport,
} from '../../main/runtime-host-delivery/transport/plugins';
import {
  isPluginCatalog, isPluginRuntime, isPluginScope, isPluginConfigurationInput,
  isPluginOperationInput, isPluginMutationReceipt,
} from '../../../src/types/plugins';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const CATALOG_INVALID = { success: false, error: 'Plugin catalog request is invalid' } as const;
const CATALOG_UNAVAILABLE = { success: false, error: 'Plugin catalog is unavailable' } as const;
const RUNTIME_INVALID = { success: false, error: 'Plugin runtime request is invalid' } as const;
const RUNTIME_UNAVAILABLE = { success: false, error: 'Plugin runtime is unavailable' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handlePluginsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: PluginsTransport,
): Promise<HostApiRouteResult> {
  if ((url.pathname === '/api/plugins/catalog' || url.pathname === '/api/plugins/runtime') && req.method === 'GET') {
    const catalog = url.pathname === '/api/plugins/catalog';
    const invalid = catalog ? CATALOG_INVALID : RUNTIME_INVALID;
    const unavailable = catalog ? CATALOG_UNAVAILABLE : RUNTIME_UNAVAILABLE;
    let body: unknown;
    try { body = await req.readJson(); } catch {
      return jsonResult(400, invalid);
    }
    const scope = readRuntimeScopeQuery(url.searchParams);
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0
      || (scope !== undefined && (!isPluginScope(scope) || (!catalog && scope.kind !== 'runtime-instance')))) {
      return jsonResult(400, invalid);
    }
    try {
      const response = catalog ? await transport.catalog(scope) : await transport.runtime(scope);
      if (response.status === 200 && (catalog ? isPluginCatalog(response.body, scope) : isPluginRuntime(response.body))) {
        return jsonResult(200, response.body);
      } else return jsonResult(503, unavailable);
    } catch { return jsonResult(503, unavailable); }
  }
  if (url.pathname === '/api/plugins/configuration' && req.method === 'POST') {
    return handleMutation(req, (input) => transport.configuration(input), isPluginConfigurationInput);
  }
  if (url.pathname === '/api/plugins/operation' && req.method === 'POST') {
    return handleMutation(req, (input) => transport.operation(input), isPluginOperationInput);
  }
  return undefined;
}

async function handleMutation<T extends PluginConfigurationInput | PluginOperationInput>(
  req: HostApiRequest,
  execute: (input: unknown) => Promise<PluginMutationReceipt>,
  validate: (value: unknown) => value is T,
): Promise<HostApiRouteResult> {
  let body: unknown;
  try { body = await req.readJson(); } catch {
    return jsonResult(400, UNKNOWN);
  }
  if (!validate(body)) {
    return jsonResult(400, UNKNOWN);
  }
  try {
    const result = await execute(body);
    if (isPluginMutationReceipt(result)) return jsonResult(202, result);
    else return jsonResult(503, UNKNOWN);
  } catch { return jsonResult(503, UNKNOWN); }
}
