import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import { getLicenseGateSnapshot } from '../../services/license/license-gate-service';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { DiagnosticsApiContext } from '../context';
import { sendJson } from '../route-utils';

function readMainProcessMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function readElectronProcessMetrics() {
  const metrics = app.getAppMetrics().map((metric) => {
    const rawMemory = metric.memory as Record<string, unknown> | undefined;
    return {
      pid: metric.pid,
      type: metric.type,
      creationTime: metric.creationTime,
      workingSetSizeKb: toNumberOrNull(rawMemory?.workingSetSize),
      peakWorkingSetSizeKb: toNumberOrNull(rawMemory?.peakWorkingSetSize),
      privateBytesKb: toNumberOrNull(rawMemory?.privateBytes),
      sharedBytesKb: toNumberOrNull(rawMemory?.sharedBytes),
    };
  });

  const byTypeMap = new Map<string, { processCount: number; totalWorkingSetKb: number; totalPrivateBytesKb: number }>();
  let totalWorkingSetKb = 0;
  for (const metric of metrics) {
    totalWorkingSetKb += metric.workingSetSizeKb ?? 0;
    const current = byTypeMap.get(metric.type) ?? {
      processCount: 0,
      totalWorkingSetKb: 0,
      totalPrivateBytesKb: 0,
    };
    current.processCount += 1;
    current.totalWorkingSetKb += metric.workingSetSizeKb ?? 0;
    current.totalPrivateBytesKb += metric.privateBytesKb ?? 0;
    byTypeMap.set(metric.type, current);
  }

  return {
    processCount: metrics.length,
    totalWorkingSetKb,
    byType: Array.from(byTypeMap.entries())
      .map(([type, summary]) => ({
        type,
        ...summary,
      }))
      .sort((left, right) => right.totalWorkingSetKb - left.totalWorkingSetKb),
    processes: metrics,
  };
}

export async function handleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DiagnosticsApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/diagnostics/memory' && req.method === 'GET') {
    sendJson(res, 200, {
      sampledAt: new Date().toISOString(),
      mainProcess: readMainProcessMemoryUsage(),
      electronProcesses: readElectronProcessMetrics(),
    });
    return true;
  }

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
