import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sendLoopbackJson } from '../client';
import {
  isPluginCatalog, isPluginRuntime, isPluginScope, isPluginConfigurationInput,
  isPluginOperationInput, isPluginMutationReceipt,
  type PluginCatalog, type PluginRuntime, type PluginScope, type PluginMutationReceipt,
} from '../../../../../src/types/plugins';
export type {
  PluginCatalog, PluginCatalogItem, PluginRuntimeId, PluginConfigurationInput,
  PluginMutationReceipt, PluginOperation, PluginOperationInput, PluginRuntime, PluginScope,
} from '../../../../../src/types/plugins';

const CATALOG_UNAVAILABLE = { success: false, error: 'Plugin catalog is unavailable' } as const;
const RUNTIME_UNAVAILABLE = { success: false, error: 'Plugin runtime is unavailable' } as const;

export type PluginCatalogTransportResponse = Readonly<{
  status: 200 | 503;
  body: PluginCatalog | typeof CATALOG_UNAVAILABLE;
}>;
export type PluginRuntimeTransportResponse = Readonly<{
  status: 200 | 503;
  body: PluginRuntime | typeof RUNTIME_UNAVAILABLE;
}>;
export interface PluginsTransport {
  catalog(scope?: PluginScope): Promise<PluginCatalogTransportResponse>;
  runtime(scope?: PluginScope): Promise<PluginRuntimeTransportResponse>;
  configuration(input: unknown): Promise<PluginMutationReceipt>;
  operation(input: unknown): Promise<PluginMutationReceipt>;
}

export function createPluginsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): PluginsTransport {
  return {
    async catalog(scope): Promise<PluginCatalogTransportResponse> {
      if (scope !== undefined && !isPluginScope(scope)) return { status: 503, body: CATALOG_UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/catalog',
        query: scope === undefined ? undefined : new URLSearchParams({ scope: JSON.stringify(scope) }),
        issuer,
        decision: {
          endpoint: '/api/plugins/catalog', scope: 'plugins:read',
          capability: 'plugins.catalog.read', subject: 'plugin-catalog',
        },
        method: 'GET', fetcher,
      });
      if (response?.status === 200 && isPluginCatalog(response.body, scope)) return { status: 200, body: response.body };
      return { status: 503, body: CATALOG_UNAVAILABLE };
    },
    async runtime(scope): Promise<PluginRuntimeTransportResponse> {
      if (scope !== undefined && (!isPluginScope(scope) || scope.kind !== 'runtime-instance')) return { status: 503, body: RUNTIME_UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/plugins/runtime',
        query: scope === undefined ? undefined : new URLSearchParams({ scope: JSON.stringify(scope) }),
        issuer,
        decision: {
          endpoint: '/api/plugins/runtime', scope: 'plugins:read',
          capability: 'plugins.runtime.read', subject: 'plugin-runtime',
        },
        method: 'GET', fetcher,
      });
      if (response?.status === 200 && isPluginRuntime(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: RUNTIME_UNAVAILABLE };
    },
    async configuration(input): Promise<PluginMutationReceipt> {
      if (!isPluginConfigurationInput(input)) throw new Error('Plugin mutation admission is unavailable');
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort, path: '/api/plugins/configuration', issuer,
        decision: {
          endpoint: '/api/plugins/configuration', scope: 'plugins:write',
          capability: 'plugins.configuration', subject: 'plugin-configuration',
        },
        method: 'POST', fetcher, body: input,
      });
      if (response?.status === 202 && isPluginMutationReceipt(response.body)) return response.body;
      throw new Error('Plugin mutation admission is unavailable');
    },
    async operation(input): Promise<PluginMutationReceipt> {
      if (!isPluginOperationInput(input)) throw new Error('Plugin mutation admission is unavailable');
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort, path: '/api/plugins/operation', issuer,
        decision: {
          endpoint: '/api/plugins/operation', scope: 'plugins:write',
          capability: 'plugins:operation', subject: 'plugin-operation',
        },
        method: 'POST', fetcher, body: input,
      });
      if (response?.status === 202 && isPluginMutationReceipt(response.body)) return response.body;
      throw new Error('Plugin mutation admission is unavailable');
    },
  };
}
