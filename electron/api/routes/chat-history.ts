import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MatchaAgentHistoryTransport } from '../../main/runtime-host-delivery/transport/sessions/matcha-history';
import type { OpenClawHistoryTransport } from '../../main/runtime-host-delivery/transport/sessions/openclaw-history';
import { parseJsonBody, sendJson } from '../route-utils';

const UNAVAILABLE = {
  '/api/openclaw/chat/history': {
    success: false,
    error: 'OpenClaw chat history is unavailable',
  },
  '/api/matcha-agent/chat/history': {
    success: false,
    error: 'Matcha Agent chat history is unavailable',
  },
} as const;

type ChatHistoryRouteDeps = Readonly<{
  openClawHistoryTransport: OpenClawHistoryTransport;
  matchaAgentHistoryTransport: MatchaAgentHistoryTransport;
}>;

export async function handleChatHistoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ChatHistoryRouteDeps,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const transport = url.pathname === '/api/openclaw/chat/history'
    ? deps.openClawHistoryTransport
    : url.pathname === '/api/matcha-agent/chat/history'
      ? deps.matchaAgentHistoryTransport
      : undefined;
  if (!transport) return false;

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
    sendJson(res, 503, UNAVAILABLE[url.pathname]);
  }
  return true;
}
