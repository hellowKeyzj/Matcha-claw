import { describe, expect, it, vi } from 'vitest';
import { handleRuntimeDirectoryRoutes } from '../../electron/api/routes/runtime-directory';

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(payload: string) {
      this.body = payload;
    },
  };
}

const transport = {
  list: vi.fn(),
  listAdapters: vi.fn(),
  listAdapterInstances: vi.fn(),
  listConnectors: vi.fn(),
  rejectLegacyConnectorLifecycle: vi.fn(),
  listPlatformTools: vi.fn(),
};

describe('runtime directory routes', () => {
  it.each([
    ['/api/runtime-adapters/list', 'listAdapters', { adapters: [] }],
    ['/api/runtime-adapters/instances/list', 'listAdapterInstances', { instances: [] }],
    ['/api/runtime-connectors/list', 'listConnectors', { connectors: [] }],
    ['/api/platform/tools', 'listPlatformTools', { success: true, tools: [{ id: 'shell', name: 'Shell', source: 'native', enabled: true }] }],
  ] as const)('claims %s and delegates to %s', async (pathname, method, body) => {
    vi.clearAllMocks();
    transport[method].mockResolvedValue({ status: 200, body });
    const res = response();

    await expect(handleRuntimeDirectoryRoutes(
      { method: 'GET' } as never,
      res as never,
      new URL(`http://127.0.0.1${pathname}?includeDisabled=true&refresh=true`),
      transport,
    )).resolves.toBe(true);

    expect(transport[method]).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(body);
  });

  it.each([
    '/api/runtime-connectors/connect',
    '/api/runtime-connectors/disconnect',
  ] as const)('keeps %s as the legacy rejection', async (pathname) => {
    vi.clearAllMocks();
    const rejection = {
      success: false,
      error: 'Legacy runtime connector lifecycle route is disabled; use /api/capabilities/execute with a runtime-endpoint target',
    };
    transport.rejectLegacyConnectorLifecycle.mockResolvedValue({ status: 400, body: rejection });
    const res = response();

    await expect(handleRuntimeDirectoryRoutes(
      { method: 'POST' } as never,
      res as never,
      new URL(`http://127.0.0.1${pathname}`),
      transport,
    )).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual(rejection);
  });
});
