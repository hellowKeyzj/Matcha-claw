import type { IncomingMessage, ServerResponse } from 'http';
import type { SkillBundleTransport } from '../../main/runtime-host-delivery/transport/skills/bundle';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleSkillBundleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SkillBundleTransport,
): Promise<boolean> {
  const operation = url.pathname === '/api/subagents/skill-bundles/export'
    ? 'export'
    : url.pathname === '/api/subagents/skill-bundles/import'
      ? 'import'
      : undefined;
  if (operation === undefined || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, { outcome: 'rejected' });
    return true;
  }
  try {
    const response = operation === 'export'
      ? await transport.exportBundles(request)
      : await transport.importBundles(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, { outcome: 'unknown' });
  }
  return true;
}
