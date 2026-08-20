import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeEndpointDirectoryTransport } from '../../main/runtime-host-delivery/transport/runtime-directory';
import { sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Runtime endpoint directory is unavailable',
} as const;

export async function handleRuntimeDirectoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: RuntimeEndpointDirectoryTransport,
): Promise<boolean> {
  if (req.method === 'GET') {
    const read = readRuntimeDirectoryRoute(url.pathname, transport);
    if (!read) return false;
    try {
      const response = await read();
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  if (req.method === 'POST'
    && (url.pathname === '/api/runtime-connectors/connect' || url.pathname === '/api/runtime-connectors/disconnect')) {
    const response = await transport.rejectLegacyConnectorLifecycle();
    sendJson(res, response.status, response.body);
    return true;
  }

  return false;
}

function readRuntimeDirectoryRoute(pathname: string, transport: RuntimeEndpointDirectoryTransport) {
  if (pathname === '/api/runtime-endpoints/list') return () => transport.list();
  if (pathname === '/api/runtime-adapters/list') return () => transport.listAdapters();
  if (pathname === '/api/runtime-adapters/instances/list') return () => transport.listAdapterInstances();
  if (pathname === '/api/runtime-connectors/list') return () => transport.listConnectors();
  if (pathname === '/api/platform/tools') return () => transport.listPlatformTools();
  return null;
}
