import type { HostApiContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleLicenseRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: Pick<HostApiContext, 'licenseService'>,
): Promise<HostApiRouteResult> {
  const pathname = url.pathname;
  if (!(req.method === 'GET' && (pathname === '/api/license/gate' || pathname === '/api/license/stored-key'))
    && !(req.method === 'POST' && (pathname === '/api/license/validate'
      || pathname === '/api/license/revalidate' || pathname === '/api/license/clear'))) return undefined;

  let body: unknown;
  if (req.method === 'POST') {
    try {
      body = await req.readJson<unknown>();
    } catch {
      return jsonResult(400, { success: false, error: 'License request JSON is invalid' });
    }
  }
  if (pathname === '/api/license/validate'
    && (!body || typeof body !== 'object' || Array.isArray(body) || !('key' in body) || typeof body.key !== 'string')) {
    return jsonResult(400, { success: false, error: 'License key must be a string' });
  }

  try {
    const service = ctx.licenseService;
    switch (pathname) {
      case '/api/license/gate':
        return jsonResult(200, await service.gate());
      case '/api/license/stored-key':
        return jsonResult(200, await service.storedKey());
      case '/api/license/validate':
        return jsonResult(200, await service.validate((body as { key: string }).key));
      case '/api/license/revalidate':
        return jsonResult(200, await service.revalidate());
      case '/api/license/clear':
        return jsonResult(200, await service.clear());
    }
  } catch {
    return jsonResult(500, { success: false, error: 'License request failed. Please try again.' });
  }
}
