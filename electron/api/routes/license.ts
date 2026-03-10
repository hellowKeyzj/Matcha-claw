import type { IncomingMessage, ServerResponse } from 'http';
import {
  clearStoredLicenseData,
  forceRevalidateStoredLicense,
  getLicenseGateSnapshot,
  getStoredLicenseKey,
  validateLicenseKey,
  waitForLicenseGateBootstrap,
} from '../../utils/license';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

interface ValidateLicenseBody {
  key?: string;
}

export async function handleLicenseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/license/gate' && req.method === 'GET') {
    await waitForLicenseGateBootstrap();
    sendJson(res, 200, getLicenseGateSnapshot());
    return true;
  }

  if (url.pathname === '/api/license/stored-key' && req.method === 'GET') {
    await waitForLicenseGateBootstrap();
    const key = await getStoredLicenseKey();
    sendJson(res, 200, { key });
    return true;
  }

  if (url.pathname === '/api/license/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<ValidateLicenseBody>(req);
      const result = await validateLicenseKey(body.key ?? '');
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { valid: false, code: 'unknown', error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/license/revalidate' && req.method === 'POST') {
    try {
      const result = await forceRevalidateStoredLicense('manual');
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { valid: false, code: 'unknown', error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/license/clear' && req.method === 'POST') {
    try {
      await clearStoredLicenseData();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
