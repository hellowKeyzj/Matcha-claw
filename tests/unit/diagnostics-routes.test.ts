import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hoisted = vi.hoisted(() => ({
  sendJsonMock: vi.fn(),
  parseJsonBodyMock: vi.fn(),
  getAppMetricsMock: vi.fn(() => []),
  archiveMock: vi.fn(),
  downloadMock: vi.fn(),
  readLogFileMock: vi.fn(async () => 'matchaclaw-log-tail'),
}));

vi.mock('electron', () => ({
  app: {
    getAppMetrics: (...args: unknown[]) => hoisted.getAppMetricsMock(...args),
  },
}));

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => hoisted.parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    readLogFile: (...args: unknown[]) => hoisted.readLogFileMock(...args),
  },
}));

describe('diagnostics routes', () => {
  const diagnosticsArchiveTransport = {
    archive: hoisted.archiveMock,
    download: hoisted.downloadMock,
  };
  const diagnosticsContext = { diagnosticsArchiveTransport } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.parseJsonBodyMock.mockResolvedValue({});
  });

  it('GET /api/diagnostics/gateway-snapshot projects sealed Rust logs into legacy tails', async () => {
    const command = vi.fn().mockResolvedValue({
      kind: 'succeeded',
      result: {
        result: {
          entries: [
            { source: 'stdout', line: 'startup' },
            { source: 'stderr', line: 'warning' },
            { source: 'gateway', line: 'request served' },
          ],
          cursor: 17,
          reset: false,
          truncated: false,
          lifecycleTailEvicted: false,
        },
      },
    });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');

    const handled = await handleDiagnosticsRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/diagnostics/gateway-snapshot'),
      { runtimeHost: { command }, diagnosticsArchiveTransport } as never,
    );

    expect(handled).toBe(true);
    expect(command).toHaveBeenCalledWith({ name: 'openclaw.logs', input: {} });
    expect(hoisted.readLogFileMock).toHaveBeenCalledWith(200);
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        matchaclawLogTail: 'matchaclaw-log-tail',
        gatewayLogTail: 'startup\nrequest served',
        gatewayErrLogTail: 'warning',
      }),
    );
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('path');
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('token');
  });

  it('GET /api/diagnostics/gateway-snapshot keeps empty tails for unavailable Rust logs', async () => {
    const command = vi.fn().mockResolvedValue({
      kind: 'rejected',
      error: { code: 'UNAVAILABLE', message: 'private runtime detail' },
    });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');

    await handleDiagnosticsRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/diagnostics/gateway-snapshot'),
      { runtimeHost: { command }, diagnosticsArchiveTransport } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'openclaw.logs', input: {} });
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ gatewayLogTail: '', gatewayErrLogTail: '' }),
    );
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('private runtime detail');
  });

  it('GET /api/diagnostics/gateway-snapshot rejects malformed Rust logs without leaking fields', async () => {
    const command = vi.fn().mockResolvedValue({
      kind: 'succeeded',
      result: {
        result: {
          entries: [{ source: 'gateway', line: 'safe' }],
          cursor: 0,
          reset: false,
          truncated: false,
          lifecycleTailEvicted: false,
          path: 'C:\\private\\gateway.log',
        },
      },
    });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');

    await handleDiagnosticsRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/diagnostics/gateway-snapshot'),
      { runtimeHost: { command }, diagnosticsArchiveTransport } as never,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ gatewayLogTail: '', gatewayErrLogTail: '' }),
    );
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('private');
  });

  it('GET /api/diagnostics/memory returns Electron process metrics', async () => {
    hoisted.getAppMetricsMock.mockReturnValueOnce([{
      pid: 4321,
      type: 'Renderer',
      creationTime: 123,
      memory: {
        workingSetSize: 1024,
        peakWorkingSetSize: 2048,
        privateBytes: 512,
        sharedBytes: 256,
      },
    }]);
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');

    const handled = await handleDiagnosticsRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/diagnostics/memory'),
      diagnosticsContext,
    );

    expect(handled).toBe(true);
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        sampledAt: expect.any(String),
        mainProcess: expect.objectContaining({ rss: expect.any(Number) }),
        electronProcesses: expect.objectContaining({
          processCount: 1,
          totalWorkingSetKb: 1024,
        }),
      }),
    );
  });

  it('POST /api/diagnostics/archive forwards only the opaque Rust receipt', async () => {
    hoisted.archiveMock.mockResolvedValueOnce({
      status: 200,
      body: {
        archiveId: '0123456789abcdef0123456789abcdef',
        terminal: 'completed',
        entries: 1,
        bytes: 512,
      },
    });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');
    const req = { method: 'POST' } as IncomingMessage;
    const res = Object.assign({}, { once: vi.fn(), off: vi.fn() }) as ServerResponse;

    const handled = await handleDiagnosticsRoutes(
      req,
      res,
      new URL('http://127.0.0.1:3210/api/diagnostics/archive'),
      diagnosticsContext,
    );

    expect(handled).toBe(true);
    expect(hoisted.archiveMock).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      archiveId: '0123456789abcdef0123456789abcdef',
      terminal: 'completed',
      entries: 1,
      bytes: 512,
    });
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('path');
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('reveal');
  });

  it('POST /api/diagnostics/archive aborts delivery and sends no receipt after the client closes', async () => {
    let close: (() => void) | undefined;
    let resolveArchive: ((value: unknown) => void) | undefined;
    hoisted.archiveMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveArchive = resolve;
    }));
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');
    const res = Object.assign({}, {
      once: vi.fn((_event: string, listener: () => void) => { close = listener; }),
      off: vi.fn(),
    }) as ServerResponse;

    const handling = handleDiagnosticsRoutes(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL('http://127.0.0.1:3210/api/diagnostics/archive'),
      diagnosticsContext,
    );
    close?.();
    resolveArchive?.({
      status: 200,
      body: {
        archiveId: '0123456789abcdef0123456789abcdef',
        terminal: 'completed',
        entries: 1,
        bytes: 512,
      },
    });

    await expect(handling).resolves.toBe(true);
    expect(hoisted.archiveMock).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }));
    expect(hoisted.sendJsonMock).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('POST /api/diagnostics/archive redacts an unavailable archive', async () => {
    hoisted.archiveMock.mockResolvedValueOnce({
      status: 503,
      body: { success: false, error: 'Diagnostics archive is unavailable' },
    });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');
    const req = { method: 'POST' } as IncomingMessage;
    const res = Object.assign({}, { once: vi.fn(), off: vi.fn() }) as ServerResponse;

    await handleDiagnosticsRoutes(
      req,
      res,
      new URL('http://127.0.0.1:3210/api/diagnostics/archive'),
      diagnosticsContext,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(expect.anything(), 503, {
      success: false,
      error: 'Diagnostics archive is unavailable',
    });
  });

  it('POST /api/diagnostics/archive/download streams only archive bytes for a valid opaque id', async () => {
    const archiveId = '0123456789abcdef0123456789abcdef';
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ archiveId });
    hoisted.downloadMock.mockResolvedValueOnce({ status: 200, body: bytes });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');
    const res = Object.assign({}, {
      setHeader: vi.fn(),
      end: vi.fn(),
    }) as unknown as ServerResponse;

    const handled = await handleDiagnosticsRoutes(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL('http://127.0.0.1:3210/api/diagnostics/archive/download'),
      diagnosticsContext,
    );

    expect(handled).toBe(true);
    expect(hoisted.downloadMock).toHaveBeenCalledWith(archiveId);
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
    expect(res.end).toHaveBeenCalledWith(Buffer.from(bytes));
    expect(hoisted.sendJsonMock).not.toHaveBeenCalled();
  });

  it('POST /api/diagnostics/archive/download rejects non-opaque ids before transport', async () => {
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ archiveId: '../private.zip' });
    const { handleDiagnosticsRoutes } = await import('../../electron/api/routes/diagnostics');

    const handled = await handleDiagnosticsRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/diagnostics/archive/download'),
      diagnosticsContext,
    );

    expect(handled).toBe(true);
    expect(hoisted.downloadMock).not.toHaveBeenCalled();
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(expect.anything(), 404, {
      success: false,
      error: 'Diagnostics archive was not found',
    });
  });
});
