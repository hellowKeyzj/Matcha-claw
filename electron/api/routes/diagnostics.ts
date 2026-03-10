import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import { collectDiagnosticsBundle } from '../../utils/diagnostics-bundle';
import { getLicenseGateSnapshot } from '../../utils/license';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/diagnostics/collect' && req.method === 'POST') {
    try {
      const result = await collectDiagnosticsBundle({
        userDataDir: app.getPath('userData'),
        openclawConfigDir: getOpenClawConfigDir(),
        appInfo: {
          name: app.getName(),
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
        },
        gateway: {
          status: ctx.gatewayManager.getStatus(),
        },
        license: {
          gateSnapshot: getLicenseGateSnapshot(),
        },
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
