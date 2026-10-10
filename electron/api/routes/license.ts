import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleLicenseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: Pick<HostApiContext, 'licenseService'>,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!(req.method === 'GET' && (pathname === '/api/license/gate' || pathname === '/api/license/stored-key'))
    && !(req.method === 'POST' && (pathname === '/api/license/validate'
      || pathname === '/api/license/revalidate' || pathname === '/api/license/clear'))) return false;

  let body: unknown;
  if (req.method === 'POST') {
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, { success: false, error: 'License request JSON is invalid' });
      return true;
    }
  }
  if (pathname === '/api/license/validate'
    && (!body || typeof body !== 'object' || Array.isArray(body) || !('key' in body) || typeof body.key !== 'string')) {
    sendJson(res, 400, { success: false, error: 'License key must be a string' });
    return true;
  }

  try {
    const service = ctx.licenseService;
    switch (pathname) {
      case '/api/license/gate':
        sendJson(res, 200, await service.gate());
        break;
      case '/api/license/stored-key':
        sendJson(res, 200, await service.storedKey());
        break;
      case '/api/license/validate':
        sendJson(res, 200, await service.validate((body as { key: string }).key));
        break;
      case '/api/license/revalidate':
        sendJson(res, 200, await service.revalidate());
        break;
      case '/api/license/clear':
        sendJson(res, 200, await service.clear());
        break;
    }
  } catch {
    sendJson(res, 500, { success: false, error: 'License request failed. Please try again.' });
  }
  return true;
}
