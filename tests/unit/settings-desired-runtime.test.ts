import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();
const hostApiFetchMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('settings desired runtime helper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it('sends only the non-secret proxy projection with a fixed null reference', async () => {
    invokeIpcMock.mockResolvedValue({
      enabled: true,
      server: 'http://proxy.example.test:8080',
      bypassRules: '<local>',
      credentialReference: 'ignored',
    });
    hostApiFetchMock
      .mockResolvedValueOnce({
        browserMode: 'native',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '',
      })
      .mockResolvedValueOnce({ desired: { revision: 1, outcome: 'confirmed' } });
    const { hostSettingsPutPatch } = await import('@/lib/settings-runtime');

    await expect(hostSettingsPutPatch({
      browserMode: 'relay',
      proxyEnabled: true,
      proxyServer: 'proxy.example.test:8080',
      proxyBypassRules: '<local>',
    })).resolves.toEqual({ desired: { revision: 1, outcome: 'confirmed' } });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/settings/desired', {
      method: 'POST',
      body: JSON.stringify({
        browserMode: 'relay',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: true,
        proxyServer: 'http://proxy.example.test:8080',
        proxyBypassRules: '<local>',
      }),
    });
  });

  it('propagates IPC and desired transport failures without a local fallback', async () => {
    const { hostSettingsPutPatch } = await import('@/lib/settings-runtime');
    const input = { browserMode: 'off' as const, launchAtStartup: false, gatewayAutoStart: true, proxyEnabled: false, proxyServer: '', proxyBypassRules: '' };

    hostApiFetchMock.mockResolvedValueOnce({
      browserMode: 'native',
      launchAtStartup: false,
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '',
    });
    invokeIpcMock.mockRejectedValueOnce(new Error('invalid proxy'));
    await expect(hostSettingsPutPatch(input)).rejects.toThrow('invalid proxy');
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    hostApiFetchMock.mockResolvedValueOnce({
      browserMode: 'native',
      launchAtStartup: false,
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '',
    });
    invokeIpcMock.mockResolvedValueOnce({ enabled: false, server: '', bypassRules: '' });
    hostApiFetchMock.mockRejectedValueOnce(new Error('unavailable'));
    await expect(hostSettingsPutPatch(input)).rejects.toThrow('unavailable');
  });
});
