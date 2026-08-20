import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hostApiFetchMock } = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

describe('license runtime Host API client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads license state through the Host API', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ key: 'stored-license-key' });

    const { hostLicenseGate, hostLicenseStoredKey } = await import('@/lib/license-runtime');

    await expect(hostLicenseGate<{ allowed: boolean }>()).resolves.toEqual({ allowed: true });
    await expect(hostLicenseStoredKey<{ key: string }>()).resolves.toEqual({ key: 'stored-license-key' });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/license/gate');
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/license/stored-key');
  });

  it('executes license mutations through the Host API capability contract', async () => {
    hostApiFetchMock.mockResolvedValue({ success: true });

    const { hostLicenseClear, hostLicenseRevalidate, hostLicenseValidate } = await import('@/lib/license-runtime');

    await hostLicenseValidate('test-license-key');
    await hostLicenseRevalidate();
    await hostLicenseClear();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'license.runtime',
        operationId: 'license.validate',
        scope: { kind: 'app' },
        target: { kind: 'license', subject: 'key' },
        input: { key: 'test-license-key' },
      }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'license.runtime',
        operationId: 'license.revalidate',
        scope: { kind: 'app' },
        target: { kind: 'license', subject: 'key' },
        input: {},
      }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(3, '/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'license.runtime',
        operationId: 'license.clear',
        scope: { kind: 'app' },
        target: { kind: 'license', subject: 'key' },
        input: {},
      }),
    });
  });
});
