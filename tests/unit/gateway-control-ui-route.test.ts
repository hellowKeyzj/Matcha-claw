import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGatewayRoutes } from '../../electron/api/routes/gateway';

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
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
    const command = vi.fn().mockResolvedValue(succeeded({
      result: { url: 'http://127.0.0.1:18789/#token=gateway-token' },
    }));
    const res = response();

    await handleGatewayRoutes(
      request('GET'),
      res.raw,
      new URL('http://127.0.0.1/api/gateway/control-ui'),
      { runtimeHost: { command } } as never,
    );

    expect(res.status()).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      url: 'http://127.0.0.1:18789/#token=gateway-token',
      port: 18789,
    });
  });
});
