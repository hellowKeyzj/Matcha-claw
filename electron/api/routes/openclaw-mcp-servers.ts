import type { OpenClawMcpServersTransport } from '../../main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw MCP servers are unavailable',
} as const;

type Operation = 'openClawMcpServers.list';

export async function handleOpenClawMcpServersRoutes(
  req: HostApiRequest,
  url: URL,
  transport: OpenClawMcpServersTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/openclaw/mcp-servers' && req.method === 'GET') {
    return deliver(transport, createRequest('openClawMcpServers.list', { kind: 'list' }, readRuntimeScopeQuery(url.searchParams)));
  }


  return undefined;
}

function createRequest(operationId: Operation, input: Record<string, unknown>, scope?: unknown) {
  return {
    id: 'openclaw.mcpServers',
    operationId,
    scope: scope === undefined ? { kind: 'openclaw-mcp-servers' } : scope,
    target: { kind: 'openclaw-mcp-servers' },
    input,
  };
}


async function deliver(
  transport: OpenClawMcpServersTransport,
  request: unknown,
): Promise<HostApiRouteResult> {
  try {
    const response = await transport.execute(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

