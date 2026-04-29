import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { importLocalSkillSource } from '../../services/skills/local-skill-import-service';

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/skills/import-local' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sourcePath?: string }>(req);
      if (typeof body.sourcePath !== 'string' || !body.sourcePath.trim()) {
        sendJson(res, 400, { success: false, error: 'sourcePath is required' });
        return true;
      }

      const result = await importLocalSkillSource(body.sourcePath);
      sendJson(res, 200, {
        success: true,
        ...result,
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}
