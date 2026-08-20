import type { IncomingMessage, ServerResponse } from 'http';
import type { ClawHubSkillInstallTransport } from '../../main/runtime-host-delivery/transport/skills/clawhub-install';
import type { ClawHubSkillSearchTransport } from '../../main/runtime-host-delivery/transport/skills/clawhub-search';
import { parseJsonBody, sendJson } from '../route-utils';

const SEARCH_INVALID = { success: false, error: 'ClawHub search request is invalid' } as const;
const SEARCH_UNAVAILABLE = { success: false, error: 'ClawHub search is unavailable' } as const;

export async function handleClawHubSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  installTransport: ClawHubSkillInstallTransport,
  searchTransport: ClawHubSkillSearchTransport,
): Promise<boolean> {
  if (url.pathname === '/api/clawhub/search' && req.method === 'POST') {
    let request: unknown;
    try {
      request = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, SEARCH_INVALID);
      return true;
    }
    try {
      const response = await searchTransport.search(request);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, SEARCH_UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname !== '/api/clawhub/skills/install' || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, { outcome: 'rejected', slug: 'invalid' });
    return true;
  }
  try {
    const response = await installTransport.install(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, { outcome: 'unknown', slug: 'invalid' });
  }
  return true;
}
