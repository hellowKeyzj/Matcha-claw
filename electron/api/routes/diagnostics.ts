import { app } from 'electron';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import { readGatewayStatusProjection, unavailableGatewayStatus } from './app';
import { logger } from '../../utils/logger';
import type { DiagnosticsApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const DEFAULT_TAIL_LINES = 200;
const MAX_OPENCLAW_LOG_ENTRIES = 1024;
const MAX_OPENCLAW_LOG_LINE_BYTES = 1024;
const OPENCLAW_LOG_SOURCES = ['stdout', 'stderr', 'gateway'] as const;

type OpenClawLogSource = (typeof OPENCLAW_LOG_SOURCES)[number];

type OpenClawLogEntry = Readonly<{
  source: OpenClawLogSource;
  line: string;
}>;

type RuntimeHostControl = Pick<DiagnosticsApiContext['runtimeHost'], 'command'>;

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

async function readOpenClawLogTails(runtimeHost: RuntimeHostControl): Promise<{
  gatewayLogTail: string;
  gatewayErrLogTail: string;
}> {
  try {
    const entries = decodeOpenClawLogEntries(await runtimeHost.command({
      name: 'openclaw.logs',
      input: {},
    }));
    if (!entries) return emptyOpenClawLogTails();
    return {
      gatewayLogTail: entries
        .filter(({ source }) => source === 'stdout' || source === 'gateway')
        .slice(-DEFAULT_TAIL_LINES)
        .map(({ line }) => line)
        .join('\n'),
      gatewayErrLogTail: entries
        .filter(({ source }) => source === 'stderr')
        .slice(-DEFAULT_TAIL_LINES)
        .map(({ line }) => line)
        .join('\n'),
    };
  } catch {
    return emptyOpenClawLogTails();
  }
}

function emptyOpenClawLogTails() {
  return { gatewayLogTail: '', gatewayErrLogTail: '' };
}

function decodeOpenClawLogEntries(outcome: RuntimeHostControlOutcome): OpenClawLogEntry[] | null {
  if (outcome.kind !== 'succeeded'
    || !isRecord(outcome.result)
    || !hasExactKeys(outcome.result, ['result'])) {
    return null;
  }

  const result = outcome.result.result;
  if (!isRecord(result)
    || !hasExactKeys(result, ['entries', 'cursor', 'reset', 'truncated', 'lifecycleTailEvicted'])
    || !Array.isArray(result.entries)
    || result.entries.length > MAX_OPENCLAW_LOG_ENTRIES
    || !isSafeNonNegativeInteger(result.cursor)
    || typeof result.reset !== 'boolean'
    || typeof result.truncated !== 'boolean'
    || typeof result.lifecycleTailEvicted !== 'boolean') {
    return null;
  }

  const entries: OpenClawLogEntry[] = [];
  for (const value of result.entries) {
    const entry = decodeOpenClawLogEntry(value);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

function decodeOpenClawLogEntry(value: unknown): OpenClawLogEntry | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['source', 'line'])
    || !isOpenClawLogSource(value.source)
    || !isBoundedLogLine(value.line)) {
    return null;
  }
  return { source: value.source, line: value.line };
}

function isOpenClawLogSource(value: unknown): value is OpenClawLogSource {
  return typeof value === 'string' && OPENCLAW_LOG_SOURCES.includes(value as OpenClawLogSource);
}

function isBoundedLogLine(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_OPENCLAW_LOG_LINE_BYTES
    && !value.includes('\r')
    && !value.includes('\n')
    && !value.includes('\0');
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function decodeArchiveDownloadRequest(value: unknown): string | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['archiveId'])
    || typeof value.archiveId !== 'string'
    || !/^[a-f0-9]{32}$/.test(value.archiveId)) {
    return null;
  }
  return value.archiveId;
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
    const gateway = await readGatewayStatusProjection(ctx.runtimeHost)
      .then((status) => status ?? unavailableGatewayStatus());
    const logs = await readOpenClawLogTails(ctx.runtimeHost);
    sendJson(res, 200, {
      capturedAt: Date.now(),
      gateway,
      matchaclawLogTail: await logger.readLogFile(DEFAULT_TAIL_LINES),
      ...logs,
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

  if (url.pathname === '/api/diagnostics/archive' && req.method === 'POST') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const response = await ctx.diagnosticsArchiveTransport.archive(controller.signal);
      if (!controller.signal.aborted) sendJson(res, response.status, response.body);
    } finally {
      res.off('close', abort);
    }
    return true;
  }

  if (url.pathname === '/api/diagnostics/archive/download' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      body = null;
    }
    const archiveId = decodeArchiveDownloadRequest(body);
    if (!archiveId) {
      sendJson(res, 404, {
        success: false,
        error: 'Diagnostics archive was not found',
      });
      return true;
    }
    const response = await ctx.diagnosticsArchiveTransport.download(archiveId);
    if (response.status !== 200) {
      sendJson(res, response.status, response.body);
      return true;
    }
    if (!(response.body instanceof Uint8Array)) {
      sendJson(res, 503, {
        success: false,
        error: 'Diagnostics archive is unavailable',
      });
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.end(Buffer.from(response.body));
    return true;
  }

  return false;
}
