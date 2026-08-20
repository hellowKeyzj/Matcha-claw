import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  sendJson: vi.fn(),
  logger: {
    getLogDir: vi.fn(() => '/tmp/matchaclaw-logs'),
    listLogFiles: vi.fn(async () => [{
      name: 'main.log',
      path: '/tmp/matchaclaw-logs/main.log',
      size: 12,
      modified: '2026-08-07T00:00:00.000Z',
    }]),
    readLogFile: vi.fn(async () => 'local logs'),
  },
  openClawConfigDir: '/tmp/openclaw-config',
}));

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => hoisted.sendJson(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: hoisted.logger,
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => hoisted.openClawConfigDir,
}));

function request(method = 'GET') {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

function context(command: ReturnType<typeof vi.fn>) {
  return { runtimeHost: { command } } as never;
}

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
}

describe('log routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Electron local logs, directory, and files under Main ownership', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn();

    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/logs?tailLines=12'),
      context(command),
    )).resolves.toBe(true);
    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/logs/dir'),
      context(command),
    )).resolves.toBe(true);
    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/logs/files'),
      context(command),
    )).resolves.toBe(true);

    expect(hoisted.logger.readLogFile).toHaveBeenCalledWith(12);
    expect(hoisted.sendJson).toHaveBeenNthCalledWith(1, expect.anything(), 200, {
      content: 'local logs',
    });
    expect(hoisted.sendJson).toHaveBeenNthCalledWith(2, expect.anything(), 200, {
      dir: '/tmp/matchaclaw-logs',
    });
    expect(hoisted.sendJson).toHaveBeenNthCalledWith(3, expect.anything(), 200, {
      files: [{
        name: 'main.log',
        path: '/tmp/matchaclaw-logs/main.log',
        size: 12,
        modified: '2026-08-07T00:00:00.000Z',
      }],
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('renders the sealed Rust log snapshot as the frozen content DTO', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn().mockResolvedValue(succeeded({
      result: {
        entries: [
          { source: 'stdout', line: 'started' },
          { source: 'stdout', line: 'ready' },
          { source: 'stderr', line: 'warning' },
          { source: 'gateway', line: 'served request' },
        ],
        cursor: 17,
        reset: false,
        truncated: false,
        lifecycleTailEvicted: false,
      },
    }));

    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/openclaw/logs?tailLines=1&cursor=9'),
      context(command),
    )).resolves.toBe(true);

    expect(command).toHaveBeenCalledWith({ name: 'openclaw.logs', input: { cursor: 9 } });
    expect(hoisted.sendJson).toHaveBeenCalledWith(expect.anything(), 200, {
      content: [
        '== OpenClaw stdout ==\nready',
        '== OpenClaw stderr ==\nwarning',
        '== OpenClaw gateway ==\nserved request',
      ].join('\n\n'),
    });
  });

  it('uses the typed command without a cursor when none is supplied', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn().mockResolvedValue(succeeded({
      result: {
        entries: [],
        cursor: 0,
        reset: false,
        truncated: false,
        lifecycleTailEvicted: false,
      },
    }));

    await handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/openclaw/logs'),
      context(command),
    );

    expect(command).toHaveBeenCalledWith({ name: 'openclaw.logs', input: {} });
    expect(hoisted.sendJson).toHaveBeenCalledWith(expect.anything(), 200, { content: '' });
  });

  it('fails closed when the typed result contains unsealed fields or malformed entries', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn().mockResolvedValue(succeeded({
      result: {
        entries: [{ source: 'gateway', line: 'token=private' }],
        cursor: 0,
        reset: false,
        truncated: false,
        lifecycleTailEvicted: false,
        path: 'E:/private/openclaw.log',
      },
    }));

    await handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/openclaw/logs'),
      context(command),
    );

    expect(hoisted.sendJson).toHaveBeenCalledWith(expect.anything(), 503, {
      success: false,
      error: 'OpenClaw logs are unavailable',
    });
    expect(JSON.stringify(hoisted.sendJson.mock.calls)).not.toContain('E:/private/openclaw.log');
  });

  it('maps typed command failure to the stable public unavailable DTO', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn().mockResolvedValue({
      kind: 'rejected',
      error: { code: 'UNAVAILABLE', message: 'private detail' },
    });

    await handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/openclaw/logs'),
      context(command),
    );

    expect(hoisted.sendJson).toHaveBeenCalledWith(expect.anything(), 503, {
      success: false,
      error: 'OpenClaw logs are unavailable',
    });
    expect(JSON.stringify(hoisted.sendJson.mock.calls)).not.toContain('private detail');
  });

  it('keeps the OpenClaw log directory as an Electron-known safe directory projection', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn();

    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/openclaw/logs/dir'),
      context(command),
    )).resolves.toBe(true);

    expect(hoisted.sendJson).toHaveBeenCalledWith(expect.anything(), 200, {
      dir: join('/tmp/openclaw-config', 'logs'),
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('does not handle unrelated paths or methods', async () => {
    const { handleLogRoutes } = await import('../../electron/api/routes/logs');
    const command = vi.fn();

    await expect(handleLogRoutes(
      request('POST'),
      {} as never,
      new URL('http://localhost/api/logs'),
      context(command),
    )).resolves.toBe(false);
    await expect(handleLogRoutes(
      request(),
      {} as never,
      new URL('http://localhost/api/logs/unknown'),
      context(command),
    )).resolves.toBe(false);
  });
});
