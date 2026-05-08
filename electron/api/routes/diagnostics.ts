import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import { buildPublicGatewayStatus } from '../../gateway/public-status';
import { getLicenseGateSnapshot } from '../../services/license/license-gate-service';
import { getOpenClawConfigDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import type { DiagnosticsApiContext } from '../context';
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

async function readTail(filePath: string, tailLines = DEFAULT_TAIL_LINES): Promise<string> {
  const safeTailLines = Math.max(1, Math.floor(tailLines));
  try {
    const file = await open(filePath, 'r');
    try {
      const stat = await file.stat();
      if (stat.size === 0) {
        return '';
      }

      const chunkSize = 64 * 1024;
      let position = stat.size;
      let content = '';
      let lineCount = 0;

      while (position > 0 && lineCount <= safeTailLines) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
        content = `${buffer.subarray(0, bytesRead).toString('utf8')}${content}`;
        lineCount = content.split('\n').length - 1;
      }

      const lines = content.split('\n');
      return lines.length <= safeTailLines ? content : lines.slice(-safeTailLines).join('\n');
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}

async function readChannelSnapshot(
  ctx: DiagnosticsApiContext,
): Promise<{ snapshot: unknown | null; error?: string }> {
  try {
    const result = await ctx.runtimeHost.request<{
      success?: boolean;
      snapshot?: unknown;
      error?: string;
    }>('GET', '/api/channels/snapshot');
    if (result.data?.success === true) {
      return {
        snapshot: result.data.snapshot ?? null,
      };
    }
    return {
      snapshot: null,
      error: result.data?.error || `channels snapshot request failed (${result.status})`,
    };
  } catch (error) {
    return {
      snapshot: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    const channelSnapshot = await readChannelSnapshot(ctx);
    const openClawConfigDir = getOpenClawConfigDir();
    sendJson(res, 200, {
      capturedAt: Date.now(),
      gateway,
      channelSnapshot: channelSnapshot.snapshot,
      ...(channelSnapshot.error ? { channelSnapshotError: channelSnapshot.error } : {}),
      clawxLogTail: await logger.readLogFile(DEFAULT_TAIL_LINES),
      gatewayLogTail: await readTail(join(openClawConfigDir, 'logs', 'gateway.log')),
      gatewayErrLogTail: await readTail(join(openClawConfigDir, 'logs', 'gateway.err.log')),
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
