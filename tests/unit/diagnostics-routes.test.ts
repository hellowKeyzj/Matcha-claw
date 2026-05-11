import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hoisted = vi.hoisted(() => ({
  sendJsonMock: vi.fn(),
  readLogFileMock: vi.fn(async () => 'matchaclaw-log-tail'),
  openClawConfigDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
}));

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    readLogFile: (...args: unknown[]) => hoisted.readLogFileMock(...args),
  },
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => hoisted.openClawConfigDir,
}));

describe('diagnostics routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/diagnostics/gateway-snapshot 只返回宿主网关诊断和日志尾部', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-diagnostics-'));
    hoisted.openClawConfigDir = tempDir;
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    await writeFile(join(tempDir, 'logs', 'gateway.log'), 'g1\ng2\ng3\n', 'utf8');
    await writeFile(join(tempDir, 'logs', 'gateway.err.log'), 'e1\ne2\n', 'utf8');

    try {
      const ctx = {
        gatewayManager: {
          getStatus: vi.fn(() => ({
            processState: 'running',
            port: 18789,
            pid: 4321,
            connectedAt: 123,
          })),
        },
        runtimeHost: {
          readGatewayStatus: vi.fn(async () => ({
            state: 'connected',
            portReachable: true,
            gatewayReady: true,
            healthSummary: 'healthy',
            diagnostics: {
              lastAliveAt: 100,
              lastRpcSuccessAt: 101,
              consecutiveHeartbeatMisses: 0,
              consecutiveRpcFailures: 0,
            },
            updatedAt: 200,
          })),
          request: vi.fn(),
        },
      };

      const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');
      const handled = await handleDiagnosticsRoutes(
        { method: 'GET' } as IncomingMessage,
        {} as ServerResponse,
        new URL('http://127.0.0.1:3210/api/diagnostics/gateway-snapshot'),
        ctx as never,
      );

      expect(handled).toBe(true);
      expect(ctx.runtimeHost.request).not.toHaveBeenCalled();
      expect(hoisted.readLogFileMock).toHaveBeenCalledWith(200);
      expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
        expect.anything(),
        200,
        expect.objectContaining({
          capturedAt: expect.any(Number),
          gateway: expect.objectContaining({
            processState: 'running',
            gatewayReady: true,
            healthSummary: 'healthy',
            transportState: 'connected',
          }),
          clawxLogTail: 'matchaclaw-log-tail',
          gatewayLogTail: 'g1\ng2\ng3\n',
          gatewayErrLogTail: 'e1\ne2\n',
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      hoisted.openClawConfigDir = '';
    }
  });
});
