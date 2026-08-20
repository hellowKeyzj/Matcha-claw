import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handleAppRoutesMock: vi.fn(),
  sendJsonMock: vi.fn(),
  setCorsHeadersMock: vi.fn(),
  loggerErrorMock: vi.fn(),
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
vi.mock('../../electron/utils/config', () => ({ getPort: vi.fn() }));
vi.mock('../../electron/utils/logger', () => ({
  logger: { error: (...args: unknown[]) => hoisted.loggerErrorMock(...args) },
}));

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
