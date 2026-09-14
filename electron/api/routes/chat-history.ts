import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MatchaAgentHistoryTransport } from '../../main/runtime-host-delivery/transport/sessions/matcha-history';
import { parseJsonBody, sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Matcha Agent chat history is unavailable',
} as const;

type ChatHistoryRouteDeps = Readonly<{
  matchaAgentHistoryTransport: MatchaAgentHistoryTransport;
}>;

export async function handleChatHistoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ChatHistoryRouteDeps,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  if (url.pathname !== '/api/matcha-agent/chat/history') return false;
  const transport = deps.matchaAgentHistoryTransport;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    request = undefined;
  }

  try {
    const response = await transport.read(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
