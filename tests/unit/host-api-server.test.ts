import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handleAppRoutesMock: vi.fn(),
  sendJsonMock: vi.fn(),
  setCorsHeadersMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock('../../electron/api/routes/app', () => ({
  handleAppRoutes: (...args: unknown[]) => hoisted.handleAppRoutesMock(...args),
}));
vi.mock('../../electron/api/routes/files', () => ({ handleFileRoutes: vi.fn() }));
vi.mock('../../electron/api/routes/diagnostics', () => ({ handleDiagnosticsRoutes: vi.fn() }));
vi.mock('../../electron/api/routes/license', () => ({ handleLicenseRoutes: vi.fn() }));
vi.mock('../../electron/api/routes/capabilities', () => ({ handleCapabilityRoutes: vi.fn() }));
vi.mock('../../electron/api/routes/openclaw', () => ({ handleOpenClawRoutes: vi.fn() }));
vi.mock('../../electron/api/route-utils', () => ({
  requireJsonContentType: vi.fn(() => true),
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
  setCorsHeaders: (...args: unknown[]) => hoisted.setCorsHeadersMock(...args),
}));
vi.mock('../../electron/utils/config', () => ({ getPort: vi.fn(() => 0) }));
vi.mock('../../electron/utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => hoisted.loggerErrorMock(...args),
    info: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
  },
}));

type CapturedRuntimeAgentIngress = Readonly<{
  path: string | undefined;
  body: string;
  authorization: string | string[] | undefined;
  ingressCredential: string | string[] | undefined;
}>;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('Host API server public error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not project a route failure detail or credential through the public API', async () => {
    hoisted.handleAppRoutesMock.mockRejectedValue(
      new Error('failed with Authorization: Bearer private-token at /private/native/path'),
    );
    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 13210);

    await handler(
      { url: '/api/app/browser-relay-info', method: 'GET', headers: {} } as never,
      {} as never,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      { success: false, error: 'Host API request failed.' },
    );
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('private-token');
    expect(JSON.stringify(hoisted.sendJsonMock.mock.calls)).not.toContain('/private/native/path');
    expect(hoisted.loggerErrorMock).toHaveBeenCalledWith('Host API request failed.');
  });
});

describe('Host API server Fleet runtime-agent ingress proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies RuntimeAgent ingress auth and body when Host API token exists', async () => {
    hoisted.sendJsonMock.mockImplementation((res, status, body) => {
      const response = res as { statusCode: number; end: (chunk: string) => void };
      response.statusCode = status as number;
      response.end(JSON.stringify(body));
    });
    const body = JSON.stringify({ kind: 'heartbeat', agentId: 'agent-1' });
    let resolveCaptured!: (value: CapturedRuntimeAgentIngress) => void;
    const captured = new Promise<CapturedRuntimeAgentIngress>((resolve) => {
      resolveCaptured = resolve;
    });
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      resolveCaptured({
        path: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
        ingressCredential: req.headers['x-matchaclaw-runtime-agent-ingress-credential'],
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"accepted":true}');
    });
    const upstreamPort = await listen(upstream);
    const { getHostApiToken, startHostApiServer, waitForHostApiServerListening } = await import('../../electron/api/server');
    const hostApiServer = startHostApiServer({} as never, 0, upstreamPort);

    try {
      await waitForHostApiServerListening(hostApiServer);
      expect(getHostApiToken()).not.toBe('');
      expect(getHostApiToken()).not.toBe('runtime-agent-token');
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: (hostApiServer.address() as AddressInfo).port,
          method: 'POST',
          path: '/api/remote-fleet/runtime-agent/ingress',
          headers: {
            Authorization: 'Bearer runtime-agent-token',
            'Content-Type': 'application/json',
            'X-MatchaClaw-Runtime-Agent-Ingress-Credential': 'agent-ingress-secret',
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(body);
      });

      expect(response).toEqual({ status: 202, body: '{"accepted":true}' });
      await expect(captured).resolves.toEqual({
        path: '/api/remote-fleet/runtime-agent/ingress',
        body,
        authorization: 'Bearer runtime-agent-token',
        ingressCredential: 'agent-ingress-secret',
      });
      expect(hoisted.sendJsonMock).not.toHaveBeenCalledWith(
        expect.anything(),
        401,
        { success: false, error: 'Unauthorized' },
      );
    } finally {
      await close(hostApiServer);
      await close(upstream);
    }
  });
});
