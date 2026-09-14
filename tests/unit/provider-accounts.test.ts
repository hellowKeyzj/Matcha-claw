import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityExecuteMock, hostApiFetchMock } from './helpers/mock-gateway-client';
describe('provider accounts helper', () => {
  beforeEach(() => {
    capabilityExecuteMock.mockReset();
    hostApiFetchMock.mockReset();
  });

  it('fetchProviderSnapshot 仅消费固定的公开 provider account delivery', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        accounts: [{
          id: 'acc-1', provider: 'openai', label: 'OpenAI', enabled: true, kind: 'chat',
          authMode: 'apiKey', revision: 1,
        }, {
          id: 'zai', provider: 'zai-global', label: 'Z.AI Global', enabled: true, kind: 'chat',
          authMode: 'apiKey', revision: 2,
        }],
      })
      .mockResolvedValueOnce({ hasKey: true })
      .mockResolvedValueOnce({ hasKey: true });

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      credentials: [{
        id: 'acc-1', vendorId: 'openai', label: 'OpenAI', authMode: 'api_key', enabled: true,
        createdAt: '', updatedAt: '', providerKind: 'chat', apiProtocol: undefined,
      }, {
        id: 'zai', vendorId: 'zai-global', label: 'Z.AI Global', authMode: 'api_key', enabled: true,
        createdAt: '', updatedAt: '', providerKind: 'chat', apiProtocol: undefined,
      }],
      statuses: [{
        id: 'acc-1', name: 'OpenAI', type: 'openai', providerKind: 'chat', enabled: true,
        createdAt: '', updatedAt: '', hasKey: true, keyMasked: '****',
      }, {
        id: 'zai', name: 'Z.AI Global', type: 'zai-global', providerKind: 'chat', enabled: true,
        createdAt: '', updatedAt: '', hasKey: true, keyMasked: '****',
      }],
      vendors: expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          category: 'official',
          supportedAuthModes: ['api_key', 'oauth_browser'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: true,
        }),
        expect.objectContaining({
          id: 'zai',
          category: 'official',
          envVar: 'ZAI_API_KEY',
          supportedAuthModes: ['api_key'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: false,
        }),
        expect.objectContaining({
          id: 'zai-global',
          category: 'official',
          envVar: 'ZAI_API_KEY',
          supportedAuthModes: ['api_key'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: false,
        }),
      ]),
      revisions: { 'acc-1': 1, zai: 2 },
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/provider-accounts', undefined);
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/provider-accounts/acc-1/has-api-key', undefined);
    expect(capabilityExecuteMock).not.toHaveBeenCalled();
  });

  it('fetchProviderSnapshot 会拒绝包含私密字段的异常返回结构', async () => {
    hostApiFetchMock.mockResolvedValue({
      accounts: [{ id: 'acc-1', provider: 'openai', label: 'OpenAI', enabled: true, authMode: 'apiKey', credentialReference: 'credential:v1:acc-1', revision: 1, apiKey: 'secret-canary' }],
    });

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({ credentials: [], statuses: [], vendors: [], revisions: {} });
  });

  it('normalizeProviderSnapshot 严格保留无私密字段的 vendor metadata', async () => {
    const { normalizeProviderSnapshot } = await import('../../src/lib/provider-accounts');
    const validVendor = {
      id: 'openai',
      name: 'OpenAI',
      icon: 'openai',
      placeholder: 'sk-...',
      requiresApiKey: true,
      category: 'official',
      supportedAuthModes: ['api_key', 'oauth_browser'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
      modelCapabilities: ['chat', 'imageUnderstand'],
    };
    expect(normalizeProviderSnapshot({
      vendors: [
        validVendor,
        { ...validVendor, apiKey: 'secret-canary' },
        { ...validVendor, supportedAuthModes: ['api_key', 'api_key'] },
        { ...validVendor, defaultAuthMode: 'local' },
        { ...validVendor, modelCapabilities: ['not-a-capability'] },
      ],
    }).vendors).toEqual([validVendor]);
  });

  it('buildProviderCredentialId keeps Z.AI global on the OpenClaw zai key alias', async () => {
    const { buildProviderCredentialId } = await import('../../src/lib/provider-accounts');
    expect(buildProviderCredentialId('zai-global', null, [])).toBe('zai');
    expect(buildProviderCredentialId('zai', null, [{
      id: 'zai' as never,
      name: 'Z.AI (CN)',
      icon: 'Z',
      placeholder: 'zai-...',
      requiresApiKey: true,
      category: 'official',
      envVar: 'ZAI_API_KEY',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: false,
    }])).toBe('zai');
  });

  it('public provider account projection keeps account mutations on the revision contract', async () => {
    const projection = await import('../../src/lib/provider-projection');
    expect(Object.keys(projection)).toEqual(expect.arrayContaining([
      'hostProviderCreateAccount',
      'hostProviderUpdateAccount',
      'hostProviderDeleteAccount',
    ]));
    expect(capabilityExecuteMock).not.toHaveBeenCalled();
  });
});
