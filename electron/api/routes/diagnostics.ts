import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import { getAllSettings } from '../../utils/store';
import { logger } from '../../utils/logger';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

interface DiagnosticsBundlePayload {
  generatedAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  gatewayStatus: ReturnType<HostApiContext['gatewayManager']['getStatus']>;
  settings: Awaited<ReturnType<typeof getAllSettings>>;
  logFiles: Awaited<ReturnType<typeof logger.listLogFiles>>;
  recentLogs: string;
}

function safeFileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function handleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/diagnostics/collect' && req.method === 'POST') {
    try {
      const generatedAt = new Date();
      const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
      await mkdir(diagnosticsDir, { recursive: true });
      const filePath = path.join(diagnosticsDir, `diagnostics-${safeFileStamp(generatedAt)}.json`);

      const [settings, logFiles, recentLogs] = await Promise.all([
        getAllSettings(),
        logger.listLogFiles(),
        logger.readLogFile(500),
      ]);

      const payload: DiagnosticsBundlePayload = {
        generatedAt: generatedAt.toISOString(),
        appVersion: app.getVersion(),
        platform: process.platform,
        gatewayStatus: ctx.gatewayManager.getStatus(),
        settings,
        logFiles,
        recentLogs,
      };

      await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

      sendJson(res, 200, {
        zipPath: filePath,
        generatedAt: payload.generatedAt,
        fileCount: (logFiles?.length ?? 0) + 1,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
