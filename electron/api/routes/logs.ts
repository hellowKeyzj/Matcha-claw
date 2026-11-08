import type { RuntimeControlTransportResponse, RuntimeLogsResponse } from '../../main/runtime-host-delivery/transport/runtime-control';
import { logger } from '../../utils/logger';
import type { RuntimeHostTransportContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiResponse, type HostApiRouteResult } from '../execution';

const DEFAULT_TAIL_LINES = 100;
const OPENCLAW_LOGS_UNAVAILABLE = 'OpenClaw logs are unavailable';
const MAX_OPENCLAW_LOG_ENTRIES = 1024;
const MAX_OPENCLAW_LOG_LINE_BYTES = 1024;
const OPENCLAW_LOG_SOURCES = ['stdout', 'stderr', 'gateway'] as const;

type OpenClawLogSource = (typeof OPENCLAW_LOG_SOURCES)[number];

type OpenClawLogEntry = Readonly<{
  source: OpenClawLogSource;
  line: string;
}>;

type OpenClawLogSnapshot = Readonly<{
  entries: readonly OpenClawLogEntry[];
  cursor: number;
  reset: boolean;
  truncated: boolean;
  lifecycleTailEvicted: boolean;
}>;

function parseTailLines(url: URL): number {
  const tailLines = Number(url.searchParams.get('tailLines') || String(DEFAULT_TAIL_LINES));
  return Number.isFinite(tailLines) ? Math.max(1, Math.floor(tailLines)) : DEFAULT_TAIL_LINES;
}

function parseCursor(url: URL): number | undefined {
  const value = url.searchParams.get('cursor');
  if (!value) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

export async function handleMainLogRoutes(
  req: HostApiRequest,
  url: URL,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    return jsonResult(200, { content: await logger.readLogFile(parseTailLines(url)) });
  }

  if (url.pathname === '/api/logs/dir' && req.method === 'GET') {
    return jsonResult(200, { dir: logger.getLogDir() });
  }

  if (url.pathname === '/api/logs/files' && req.method === 'GET') {
    return jsonResult(200, { files: await logger.listLogFiles() });
  }

  return undefined;
}

export async function handleLogRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: RuntimeHostTransportContext<'runtimeControlTransport' | 'openClawPlatformTransport'>,
): Promise<HostApiRouteResult> {
  const mainResult = await handleMainLogRoutes(req, url);
  if (mainResult !== undefined) return mainResult;

  if (url.pathname === '/api/openclaw/logs' && req.method === 'GET') {
    return handleOpenClawLogs(url, ctx);
  }

  if (url.pathname === '/api/openclaw/logs/dir' && req.method === 'GET') {
    try {
      const response = await ctx.runtimeHostTransports.openClawPlatformTransport.logDirectory();
      if (response.status !== 200
        || !isRecord(response.body)
        || !hasExactKeys(response.body, ['dir'])
        || (response.body.dir !== null && typeof response.body.dir !== 'string')) {
        return sendOpenClawLogsUnavailable();
      }
      return jsonResult(200, { dir: response.body.dir });
    } catch {
      return sendOpenClawLogsUnavailable();
    }
  }

  return undefined;
}

async function handleOpenClawLogs(
  url: URL,
  ctx: RuntimeHostTransportContext<'runtimeControlTransport'>,
): Promise<HostApiResponse> {
  try {
    const cursor = parseCursor(url);
    const logs = decodeOpenClawLogs(await ctx.runtimeHostTransports.runtimeControlTransport.logs(
      cursor === undefined ? undefined : { cursor },
    ));
    if (!logs) {
      return sendOpenClawLogsUnavailable();
    }
    return jsonResult(200, { content: renderOpenClawLogContent(logs, parseTailLines(url)) });
  } catch {
    return sendOpenClawLogsUnavailable();
  }
}

function decodeOpenClawLogs(response: RuntimeControlTransportResponse<RuntimeLogsResponse>): OpenClawLogSnapshot | null {
  if (response.status !== 200) {
    return null;
  }

  const result = response.body.result;
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

  return {
    entries,
    cursor: result.cursor,
    reset: result.reset,
    truncated: result.truncated,
    lifecycleTailEvicted: result.lifecycleTailEvicted,
  };
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

function renderOpenClawLogContent(snapshot: OpenClawLogSnapshot, tailLines: number): string {
  return OPENCLAW_LOG_SOURCES.flatMap((source) => {
    const lines = snapshot.entries
      .filter((entry) => entry.source === source)
      .slice(-tailLines)
      .map((entry) => entry.line);
    return lines.length === 0 ? [] : [`== OpenClaw ${source} ==\n${lines.join('\n')}`];
  }).join('\n\n');
}

function sendOpenClawLogsUnavailable(): HostApiResponse {
  return jsonResult(503, { success: false, error: OPENCLAW_LOGS_UNAVAILABLE });
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
