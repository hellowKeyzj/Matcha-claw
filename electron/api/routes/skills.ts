import type { IncomingMessage, ServerResponse } from 'http';
import type { SkillsManagementTransport } from '../../main/runtime-host-delivery/transport/skills/management';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

type SkillsRouteOperation = Exclude<keyof SkillsManagementTransport, 'readStatus'> | 'status';

export async function handleSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SkillsManagementTransport,
): Promise<boolean> {
  const operation = routeOperation(url.pathname, req.method);
  if (!operation) return false;

  if (operation === 'status') {
    try {
      const response = await transport.readStatus();
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNKNOWN);
    }
    return true;
  }

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  try {
    const response = await transport[operation](body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNKNOWN);
  }
  return true;
}

function routeOperation(pathname: string, method: string | undefined): SkillsRouteOperation | undefined {
  if (method === 'GET' && pathname === '/api/skills/status') return 'status';
  if (method !== 'POST') return undefined;
  switch (pathname) {
    case '/api/skills/search': return 'search';
    case '/api/skills/detail': return 'detail';
    case '/api/skills/config': return 'mutateConfig';
    case '/api/skills/clawhub/install': return 'installClawHub';
    case '/api/skills/clawhub/update': return 'updateClawHub';
    case '/api/skills/upload/begin': return 'beginUpload';
    case '/api/skills/upload/chunk': return 'appendUploadChunk';
    case '/api/skills/upload/commit': return 'commitUpload';
    case '/api/skills/uninstall': return 'uninstall';
    case '/api/skills/import/markdown': return 'importMarkdown';
    case '/api/skills/import/bundle': return 'importBundle';
    case '/api/skills/readme': return 'readme';
    default: return undefined;
  }
}
