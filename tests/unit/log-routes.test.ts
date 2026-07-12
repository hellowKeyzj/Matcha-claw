import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hoisted = vi.hoisted(() => ({
  sendJsonMock: vi.fn(),
  openClawConfigDir: '',
  logger: {
    getLogDir: vi.fn(() => '/tmp/matchaclaw-logs'),
    listLogFiles: vi.fn(async () => []),
    readLogFile: vi.fn(async () => ''),
    getRecentLogs: vi.fn(() => [] as string[]),
  },
}));

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: hoisted.logger,
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => hoisted.openClawConfigDir,
}));

describe('log routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns OpenClaw gateway log tails separately from app logs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-logs-'));
    hoisted.openClawConfigDir = tempDir;
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    await writeFile(join(tempDir, 'logs', 'gateway.log'), 'g1\ng2\ng3\n', 'utf8');
    await writeFile(join(tempDir, 'logs', 'gateway.err.log'), 'e1\ne2\n', 'utf8');

    try {
      const { handleLogRoutes } = await import('../../electron/api/routes/logs');
      const handled = await handleLogRoutes(
        { method: 'GET' } as IncomingMessage,
        {} as ServerResponse,
        new URL('http://127.0.0.1:3210/api/openclaw/logs?tailLines=2'),
        {} as never,
      );

      expect(handled).toBe(true);
      expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
        expect.anything(),
        200,
        {
          content: '== gateway.log ==\ng2\ng3\n\n== gateway.err.log ==\ne1\ne2',
          gatewayLogTail: 'g2\ng3\n',
          gatewayErrLogTail: 'e1\ne2\n',
          hostGatewayLogTail: '',
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      hoisted.openClawConfigDir = '';
    }
  });

  it('falls back to host gateway events when OpenClaw files are empty', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-host-logs-'));
    hoisted.openClawConfigDir = tempDir;
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    hoisted.logger.readLogFile.mockResolvedValueOnce([
      '[2026-07-07T00:00:00.000Z] [INFO ] [Runtime Host] started',
      '[2026-07-07T00:00:01.000Z] [INFO ] [OpenClaw gateway] utility start requested',
      '[2026-07-07T00:00:02.000Z] [WARN ] [OpenClaw gateway:stderr] warning',
    ].join('\n'));
    hoisted.logger.getRecentLogs.mockReturnValueOnce([
      '[2026-07-07T00:00:02.000Z] [WARN ] [OpenClaw gateway:stderr] warning',
      '[2026-07-07T00:00:03.000Z] [INFO ] Gateway auto-start succeeded',
    ]);

    try {
      const { handleLogRoutes } = await import('../../electron/api/routes/logs');
      const handled = await handleLogRoutes(
        { method: 'GET' } as IncomingMessage,
        {} as ServerResponse,
        new URL('http://127.0.0.1:3210/api/openclaw/logs?tailLines=10'),
        {} as never,
      );

      expect(handled).toBe(true);
      expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
        expect.anything(),
        200,
        {
          content: [
            '== MatchaClaw host gateway events ==',
            '[2026-07-07T00:00:01.000Z] [INFO ] [OpenClaw gateway] utility start requested',
            '[2026-07-07T00:00:02.000Z] [WARN ] [OpenClaw gateway:stderr] warning',
            '[2026-07-07T00:00:03.000Z] [INFO ] Gateway auto-start succeeded',
          ].join('\n'),
          gatewayLogTail: '',
          gatewayErrLogTail: '',
          hostGatewayLogTail: [
            '[2026-07-07T00:00:01.000Z] [INFO ] [OpenClaw gateway] utility start requested',
            '[2026-07-07T00:00:02.000Z] [WARN ] [OpenClaw gateway:stderr] warning',
            '[2026-07-07T00:00:03.000Z] [INFO ] Gateway auto-start succeeded',
          ].join('\n'),
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      hoisted.openClawConfigDir = '';
    }
  });

  it('returns OpenClaw log directory', async () => {
    hoisted.openClawConfigDir = '/tmp/openclaw-config';

    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const handled = await handleLogRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/openclaw/logs/dir'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      { dir: join('/tmp/openclaw-config', 'logs') },
    );
    hoisted.openClawConfigDir = '';
  });
});
