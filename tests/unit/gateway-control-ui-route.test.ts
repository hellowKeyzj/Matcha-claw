import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGatewayRoutes } from '../../electron/api/routes/gateway';

function runtimeControlResponse(body: unknown) {
  return { status: 200 as const, body };
}

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response() {
  let body = '';
  const raw = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn((chunk: string) => {
      body = chunk;
    }),
  };
  return {
    raw: raw as unknown as ServerResponse,
    json: () => JSON.parse(body) as unknown,
    status: () => raw.statusCode,
  };
}

describe('gateway control UI route', () => {
  it('preserves the runtime-issued gateway URL fragment token', async () => {
    const command = vi.fn();
    const controlUiUrl = vi.fn().mockResolvedValue(runtimeControlResponse({
      result: { url: 'http://127.0.0.1:18789/#token=gateway-token' },
    }));
    const res = response();

    await handleGatewayRoutes(
      request('GET'),
      res.raw,
      new URL('http://127.0.0.1/api/gateway/control-ui'),
      {
        runtimeHost: { command },
        runtimeHostTransports: { runtimeControlTransport: { controlUiUrl } },
      } as never,
    );

    expect(controlUiUrl).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(res.status()).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      url: 'http://127.0.0.1:18789/#token=gateway-token',
      port: 18789,
    });
  });

  it.each([
    ['/api/gateway/start', 'lifecycleStart'],
    ['/api/gateway/stop', 'lifecycleStop'],
    ['/api/gateway/restart', 'lifecycleRestart'],
  ] as const)('routes %s lifecycle mutation through runtime control transport', async (pathname, method) => {
    const command = vi.fn();
    const receipt = { callId: 'call-gateway-lifecycle', accepted: true };
    const transport = {
      lifecycleStart: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
      lifecycleStop: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
      lifecycleRestart: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
    };
    const res = response();

    await handleGatewayRoutes(
      request('POST'),
      res.raw,
      new URL(`http://127.0.0.1${pathname}`),
      {
        runtimeHost: { command },
        runtimeHostTransports: { runtimeControlTransport: transport },
      } as never,
    );

    expect(transport[method]).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(res.status()).toBe(202);
    expect(res.json()).toEqual(receipt);
  });
});
