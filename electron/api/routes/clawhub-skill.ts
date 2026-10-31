import type { ClawHubSkillInstallTransport } from '../../main/runtime-host-delivery/transport/skills/clawhub-install';
import type { ClawHubSkillSearchTransport } from '../../main/runtime-host-delivery/transport/skills/clawhub-search';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const SEARCH_INVALID = { success: false, error: 'ClawHub search request is invalid' } as const;
const SEARCH_UNAVAILABLE = { success: false, error: 'ClawHub search is unavailable' } as const;

export async function handleClawHubSkillRoutes(
  req: HostApiRequest,
  url: URL,
  installTransport: ClawHubSkillInstallTransport,
  searchTransport: ClawHubSkillSearchTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/clawhub/search' && req.method === 'POST') {
    let request: unknown;
    try {
      request = await req.readJson();
    } catch {
      return jsonResult(400, SEARCH_INVALID);
    }
    try {
      const response = await searchTransport.search(request);
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, SEARCH_UNAVAILABLE);
    }
  }

  if (url.pathname !== '/api/clawhub/skills/install' || req.method !== 'POST') return undefined;

  let request: unknown;
  try {
    request = await req.readJson();
  } catch {
    return jsonResult(400, { outcome: 'rejected', slug: 'invalid' });
  }
  try {
    const response = await installTransport.install(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, { outcome: 'unknown', slug: 'invalid' });
  }
}
