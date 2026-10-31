import type { TeamWebhookAuthTransport } from '../../main/runtime-host-delivery/transport/teams/webhook-auth';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const UNAVAILABLE = {
  success: false,
  error: 'Team webhook auth is unavailable',
} as const;

export async function handleTeamWebhookAuthRoutes(
  req: HostApiRequest,
  url: URL,
  transport?: TeamWebhookAuthTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/runtime-host/team-webhook-auth' || req.method !== 'GET') {
    return undefined;
  }

  if (!transport) {
    return jsonResult(503, UNAVAILABLE);
  }

  try {
    const response = await transport.read();
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}
