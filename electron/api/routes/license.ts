import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

const LICENSE_UNAVAILABLE = {
  success: false,
  error: 'License service is unavailable',
} as const;

type LicenseApiContext = Pick<HostApiContext, 'licenseService'>;

export async function handleLicenseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: LicenseApiContext,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/api/license/gate') {
    try {
      sendJson(res, 200, await ctx.licenseService.gate());
    } catch {
      sendJson(res, 503, LICENSE_UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname === '/api/license/stored-key') {
    try {
      sendJson(res, 200, await ctx.licenseService.storedKey());
    } catch {
      sendJson(res, 503, LICENSE_UNAVAILABLE);
    }
    return true;
  }

  return false;
}
