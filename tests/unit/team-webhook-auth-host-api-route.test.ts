import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamWebhookAuthRoutes } from '../../electron/api/routes/team-webhook-auth';

function request(method = 'GET') {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('Team webhook auth Host API route', () => {
  it('forwards the sealed projection from the typed transport', async () => {
    const result = response();
    const transport = {
      read: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          success: true,
          enabled: true,
          source: 'settings',
          headerName: 'x-matchaclaw-webhook-token',
          authorizationScheme: 'Bearer',
          maskedToken: 'mctwh_…beef',
          copySupported: false,
        },
      }),
    };

    await expect(handleTeamWebhookAuthRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/runtime-host/team-webhook-auth'),
      transport,
    )).resolves.toBe(true);

    expect(transport.read).toHaveBeenCalledOnce();
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        enabled: true,
        source: 'settings',
        headerName: 'x-matchaclaw-webhook-token',
        authorizationScheme: 'Bearer',
        maskedToken: 'mctwh_…beef',
        copySupported: false,
      },
    });
    expect(JSON.stringify(result.state.body)).not.toMatch(/mctwh_[0-9a-f]{64}/);
  });

  it('fails closed without reading or projecting webhook token material', async () => {
    const result = response();

    await expect(handleTeamWebhookAuthRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/runtime-host/team-webhook-auth'),
    )).resolves.toBe(true);

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Team webhook auth is unavailable' },
    });
    expect(JSON.stringify(result.state.body)).not.toMatch(/mctwh_|token|authorization/i);
  });

  it('returns unavailable when the typed transport fails', async () => {
    const result = response();
    const transport = { read: vi.fn().mockRejectedValue(new Error('private loopback failure')) };

    await expect(handleTeamWebhookAuthRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/runtime-host/team-webhook-auth'),
      transport,
    )).resolves.toBe(true);

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Team webhook auth is unavailable' },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('private loopback failure');
  });

  it('does not claim non-GET requests or unrelated paths', async () => {
    for (const [url, method] of [
      ['http://127.0.0.1/api/runtime-host/team-webhook-auth', 'POST'],
      ['http://127.0.0.1/api/team-runtime/webhooks/example', 'GET'],
    ] as const) {
      await expect(handleTeamWebhookAuthRoutes(
        request(method) as never,
        response().raw as never,
        new URL(url),
      )).resolves.toBe(false);
    }
  });
});
