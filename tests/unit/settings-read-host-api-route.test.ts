import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSettingsRoutes } from '../../electron/api/routes/settings';

function request() {
  return Object.assign(Readable.from([]), {
    method: 'GET',
    headers: {},
  });
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

const snapshot = {
  browserMode: 'relay',
  launchAtStartup: false,
  gatewayAutoStart: true,
  proxyEnabled: true,
  proxyServer: 'http://proxy.example.test:8080',
  proxyBypassRules: 'localhost',
} as const;

describe('Settings read Host API routes', () => {
  it('reads the source-backed public snapshot', async () => {
    const read = vi.fn().mockResolvedValue(snapshot);
    const result = response();

    await expect(handleSettingsRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/settings'),
      { read, submit: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledOnce();
    expect(result.state).toEqual({ statusCode: 200, body: snapshot });
  });

  it('preserves historical single-key and unknown-key JSON semantics', async () => {
    const transport = { read: vi.fn().mockResolvedValue(snapshot), submit: vi.fn() };

    for (const [key, value] of Object.entries(snapshot)) {
      const result = response();
      await handleSettingsRoutes(
        request() as never,
        result.raw as never,
        new URL(`http://127.0.0.1/api/settings/${key}`),
        transport,
      );
      expect(result.state).toEqual({ statusCode: 200, body: { value } });
    }

    const unknown = response();
    await handleSettingsRoutes(
      request() as never,
      unknown.raw as never,
      new URL('http://127.0.0.1/api/settings/theme'),
      transport,
    );
    expect(unknown.state).toEqual({ statusCode: 200, body: {} });
  });

  it('rejects empty and malformed encoded keys', async () => {
    const transport = { read: vi.fn(), submit: vi.fn() };
    for (const pathname of ['/api/settings/', '/api/settings/%E0%A4%A']) {
      const result = response();
      await handleSettingsRoutes(
        request() as never,
        result.raw as never,
        new URL(`http://127.0.0.1${pathname}`),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Settings key is invalid' },
      });
    }
    expect(transport.read).not.toHaveBeenCalled();
  });

  it('returns stable unavailable errors and never exposes transport failures', async () => {
    const result = response();
    await handleSettingsRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/settings'),
      { read: vi.fn().mockRejectedValue(new Error('private settings path')), submit: vi.fn() },
    );
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Settings are unavailable' },
    });
  });
});
