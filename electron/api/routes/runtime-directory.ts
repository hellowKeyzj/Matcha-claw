import type { RuntimeEndpointDirectoryTransport } from '../../main/runtime-host-delivery/transport/runtime-directory';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const UNAVAILABLE = {
  success: false,
  error: 'Runtime endpoint directory is unavailable',
} as const;

export async function handleRuntimeDirectoryRoutes(
  req: HostApiRequest,
  url: URL,
  transport: RuntimeEndpointDirectoryTransport,
): Promise<HostApiRouteResult> {
  if (req.method === 'GET') {
    const read = readRuntimeDirectoryRoute(url.pathname, transport);
    if (!read) return undefined;
    try {
      const response = await read();
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  if (req.method === 'POST'
    && (url.pathname === '/api/runtime-connectors/connect' || url.pathname === '/api/runtime-connectors/disconnect')) {
    const response = await transport.rejectLegacyConnectorLifecycle();
    return jsonResult(response.status, response.body);
  }

  return undefined;
}

function readRuntimeDirectoryRoute(pathname: string, transport: RuntimeEndpointDirectoryTransport) {
  if (pathname === '/api/runtime-endpoints/list') return () => transport.list();
  if (pathname === '/api/runtime-adapters/list') return () => transport.listAdapters();
  if (pathname === '/api/runtime-adapters/instances/list') return () => transport.listAdapterInstances();
  if (pathname === '/api/runtime-connectors/list') return () => transport.listConnectors();
  if (pathname === '/api/platform/tools') return () => transport.listPlatformTools();
  return null;
}
