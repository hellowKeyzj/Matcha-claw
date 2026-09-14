import type { IncomingMessage, ServerResponse } from 'http';
import type { OpenClawMcpServersTransport } from '../../main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers';
import { sendJson } from '../route-utils';

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
    await deliver(transport, res, createRequest('openClawMcpServers.list', { kind: 'list' }));
    return true;
  }


  return false;
}

function createRequest(operationId: Operation, input: Record<string, unknown>) {
  return {
    id: 'openclaw.mcpServers',
    operationId,
    scope: { kind: 'openclaw-mcp-servers' },
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

