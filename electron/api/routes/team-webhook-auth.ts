import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamWebhookAuthTransport } from '../../main/runtime-host-delivery/transport/teams/webhook-auth';
import { sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Team webhook auth is unavailable',
} as const;

export async function handleTeamWebhookAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport?: TeamWebhookAuthTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/runtime-host/team-webhook-auth' || req.method !== 'GET') {
    return false;
  }

  if (!transport) {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }

  try {
    const response = await transport.read();
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
