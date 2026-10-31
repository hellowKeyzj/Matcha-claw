import type { SkillBundleTransport } from '../../main/runtime-host-delivery/transport/skills/bundle';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleSkillBundleRoutes(
  req: HostApiRequest,
  url: URL,
  transport: SkillBundleTransport,
): Promise<HostApiRouteResult> {
  const operation = url.pathname === '/api/subagents/skill-bundles/export'
    ? 'export'
    : url.pathname === '/api/subagents/skill-bundles/import'
      ? 'import'
      : undefined;
  if (operation === undefined || req.method !== 'POST') return undefined;

  let request: unknown;
  try {
    request = await req.readJson();
  } catch {
    return jsonResult(400, { outcome: 'rejected' });
  }
  try {
    const response = operation === 'export'
      ? await transport.exportBundles(request)
      : await transport.importBundles(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, { outcome: 'unknown' });
  }
}
