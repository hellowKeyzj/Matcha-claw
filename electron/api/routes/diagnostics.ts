import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import { getLicenseGateSnapshot } from '../../services/license/license-gate-service';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { DiagnosticsApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DiagnosticsApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/diagnostics/collect' && req.method === 'POST') {
    try {
      const result = await ctx.runtimeHost.request(
        'POST',
        '/api/diagnostics/collect',
        {
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
        gatewayStatus: ctx.gatewayManager.getStatus(),
        licenseGateSnapshot: getLicenseGateSnapshot(),
      },
      );
      sendJson(res, result.status, result.data);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
