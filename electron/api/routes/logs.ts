import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import { logger } from '../../utils/logger';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { LogApiContext } from '../context';
import { readTail } from '../log-tail';
import { sendJson } from '../route-utils';

const DEFAULT_TAIL_LINES = 100;
const HOST_GATEWAY_LOG_SCAN_LINES = 1_000;
const HOST_GATEWAY_LOG_PATTERN = /\[OpenClaw gateway(?::stderr)?\]|\bOpenClaw\b|\bGateway\b/;

function parseTailLines(url: URL): number {
  const tailLines = Number(url.searchParams.get('tailLines') || String(DEFAULT_TAIL_LINES));
  return Number.isFinite(tailLines) ? Math.max(1, Math.floor(tailLines)) : DEFAULT_TAIL_LINES;
}

function getOpenClawLogDir(): string {
  return join(getOpenClawConfigDir(), 'logs');
}

function selectHostGatewayLogTail(content: string, tailLines: number): string {
  const seen = new Set<string>();
  const lines = content
    .split('\n')
    .filter((line) => HOST_GATEWAY_LOG_PATTERN.test(line))
    .filter((line) => {
      if (seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    });
  return lines.slice(-tailLines).join('\n');
}

async function readHostGatewayLogTail(tailLines: number): Promise<string> {
  const scanLines = Math.max(HOST_GATEWAY_LOG_SCAN_LINES, tailLines * 10);
  const logFileTail = await logger.readLogFile(scanLines);
  const recentLogTail = logger.getRecentLogs(scanLines).join('\n');
  return selectHostGatewayLogTail([logFileTail, recentLogTail].filter(Boolean).join('\n'), tailLines);
}

export async function handleLogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: LogApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    sendJson(res, 200, { content: await logger.readLogFile(parseTailLines(url)) });
    return true;
  }

  if (url.pathname === '/api/logs/dir' && req.method === 'GET') {
    sendJson(res, 200, { dir: logger.getLogDir() });
    return true;
  }

  if (url.pathname === '/api/logs/files' && req.method === 'GET') {
    sendJson(res, 200, { files: await logger.listLogFiles() });
    return true;
  }

  if (url.pathname === '/api/openclaw/logs' && req.method === 'GET') {
    const logDir = getOpenClawLogDir();
    const tailLines = parseTailLines(url);
    const gatewayLogTail = await readTail(join(logDir, 'gateway.log'), tailLines);
    const gatewayErrLogTail = await readTail(join(logDir, 'gateway.err.log'), tailLines);
    const hostGatewayLogTail = await readHostGatewayLogTail(tailLines);
    const content = [
      gatewayLogTail ? `== gateway.log ==\n${gatewayLogTail.trimEnd()}` : '',
      gatewayErrLogTail ? `== gateway.err.log ==\n${gatewayErrLogTail.trimEnd()}` : '',
      hostGatewayLogTail ? `== MatchaClaw host gateway events ==\n${hostGatewayLogTail.trimEnd()}` : '',
    ].filter(Boolean).join('\n\n');
    sendJson(res, 200, { content, gatewayLogTail, gatewayErrLogTail, hostGatewayLogTail });
    return true;
  }

  if (url.pathname === '/api/openclaw/logs/dir' && req.method === 'GET') {
    sendJson(res, 200, { dir: getOpenClawLogDir() });
    return true;
  }

  return false;
}
