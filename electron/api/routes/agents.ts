import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentsTransport } from '../../main/runtime-host-delivery/products/agents';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Subagent management request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Subagent management is unavailable',
} as const;

export async function handleAgentsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: AgentsTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/subagents/agents' || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.execute(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
