import type { SkillsManagementTransport } from '../../main/runtime-host-delivery/transport/skills/management';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

type SkillsRouteOperation = Exclude<keyof SkillsManagementTransport, 'readStatus'> | 'status';

export async function handleSkillsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: SkillsManagementTransport,
): Promise<HostApiRouteResult> {
  const operation = routeOperation(url.pathname, req.method);
  if (!operation) return undefined;

  if (operation === 'status') {
    try {
      const response = await transport.readStatus(readRuntimeScopeQuery(url.searchParams));
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNKNOWN);
    }
  }

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  try {
    const response = await transport[operation](body);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNKNOWN);
  }
}

function routeOperation(pathname: string, method: string | undefined): SkillsRouteOperation | undefined {
  if (method === 'GET' && pathname === '/api/skills/status') return 'status';
  if (method !== 'POST') return undefined;
  switch (pathname) {
    case '/api/skills/operations/result': return 'operationResult';
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
