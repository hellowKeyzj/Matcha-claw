import type { IncomingMessage, ServerResponse } from 'http';
import type { SealedSkillsTransport } from '../../main/runtime-host-delivery/transport/skills/sealed';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

type SealedSkillsRouteOperation = Exclude<keyof SealedSkillsTransport, 'readStatus'> | 'status';

export async function handleSealedSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SealedSkillsTransport,
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

function routeOperation(pathname: string, method: string | undefined): SealedSkillsRouteOperation | undefined {
  if (method === 'GET' && pathname === '/api/sealed-skills/status') return 'status';
  if (method !== 'POST') return undefined;
  switch (pathname) {
    case '/api/sealed-skills/export': return 'export';
    case '/api/sealed-skills/install': return 'install';
    case '/api/sealed-skills/uninstall': return 'uninstall';
    default: return undefined;
  }
}
