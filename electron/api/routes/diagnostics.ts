import { join } from 'node:path';
import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import { buildPublicGatewayStatus } from '../../main/process-runtime/openclaw-gateway/public-status';
import { getOpenClawConfigDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import type { DiagnosticsApiContext } from '../context';
import { readTail } from '../log-tail';
import { sendJson } from '../route-utils';

const DEFAULT_TAIL_LINES = 200;

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
  if (url.pathname === '/api/diagnostics/gateway-snapshot' && req.method === 'GET') {
    const runtimeGatewayStatus = await ctx.runtimeHost.readGatewayStatus().catch(() => null);
    const gateway = buildPublicGatewayStatus(
      ctx.gatewayManager.getStatus(),
      runtimeGatewayStatus,
    );
    const openClawConfigDir = getOpenClawConfigDir();
    sendJson(res, 200, {
      capturedAt: Date.now(),
      gateway,
      matchaclawLogTail: await logger.readLogFile(DEFAULT_TAIL_LINES),
      gatewayLogTail: await readTail(join(openClawConfigDir, 'logs', 'gateway.log'), DEFAULT_TAIL_LINES),
      gatewayErrLogTail: await readTail(join(openClawConfigDir, 'logs', 'gateway.err.log'), DEFAULT_TAIL_LINES),
    });
    return true;
  }

  if (url.pathname === '/api/diagnostics/memory' && req.method === 'GET') {
    sendJson(res, 200, {
      sampledAt: new Date().toISOString(),
      mainProcess: readMainProcessMemoryUsage(),
      electronProcesses: readElectronProcessMetrics(),
    });
    return true;
  }

  return false;
}
