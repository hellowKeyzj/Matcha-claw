import type { IncomingMessage, ServerResponse } from 'http';
import type { OpenClawMcpServersTransport } from '../../main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers';
import { sendJson } from '../route-utils';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw MCP servers are unavailable',
} as const;

type Operation = 'openClawMcpServers.list';

export async function handleOpenClawMcpServersRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: OpenClawMcpServersTransport,
): Promise<boolean> {
  if (url.pathname === '/api/openclaw/mcp-servers' && req.method === 'GET') {
    await deliver(transport, res, createRequest('openClawMcpServers.list', { kind: 'list' }, readRuntimeScopeQuery(url.searchParams)));
    return true;
  }


  return false;
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
  res: ServerResponse,
  request: unknown,
): Promise<void> {
  try {
    const response = await transport.execute(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
}

