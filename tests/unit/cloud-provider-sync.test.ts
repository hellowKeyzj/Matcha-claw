import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  storeProviderPrivateAccountMock: vi.fn(),
  deleteProviderPrivateAccountMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  awaitProviderCall: vi.fn(),
}));

vi.mock('../../electron/main/ipc/provider-private-auth', () => ({
  storeProviderPrivateAccount: (...args: unknown[]) => hoisted.storeProviderPrivateAccountMock(...args),
  deleteProviderPrivateAccount: (...args: unknown[]) => hoisted.deleteProviderPrivateAccountMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { warn: (...args: unknown[]) => hoisted.loggerWarnMock(...args) },
}));

const session = {
  accessToken: 'cloud-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  tokenType: 'Bearer',
  user: {
    id: 7,
    username: 'user',
    email: 'user@example.com',
    role: 'user',
    balance: 0,
    concurrency: 1,
    status: 'active',
    allowedGroups: null,
    balanceNotifyEnabled: false,
    balanceNotifyThreshold: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
} as const;

const bootstrap = {
  schemaVersion: 1,
  ready: true,
  needsSetup: false,
  baseUrl: 'https://gateway.example.com/v1',
  rootUrl: 'https://gateway.example.com',
  apiKey: { key: 'sk-live', status: 'active' },
  clients: {
    openai: {
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'sk-live',
      modelsUrl: 'https://gateway.example.com/v1/models',
    },
  },
} as const;

describe('cloud provider sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hoisted.storeProviderPrivateAccountMock.mockResolvedValue({ status: 'stored' });
    hoisted.deleteProviderPrivateAccountMock.mockResolvedValue({ status: 'deleted' });
    hoisted.awaitProviderCall.mockResolvedValue({
      command: 'providerModels.replace',
      status: 'succeeded',
      detail: {
        kind: 'replaceModels', phase: 'terminal', outcome: 'stored', count: null,
        acceptedCount: null, persisted: 'confirmed', commit: 'committed',
        accountId: 'matcha-cloud', accountRevision: null, diagnostic: null,
        native: { changed: true, applied: 'confirmed', observed: 'matches' },
      },
    });
  });

  it('stores the cloud gateway account and replaces discovered models', async () => {
    const fetchClientBootstrap = vi.fn().mockResolvedValue(bootstrap);
    const providerAccountsTransport = {
      execute: vi.fn().mockResolvedValue({ status: 404, body: { success: false, error: 'Provider account was not found' } }),
    };
    const providerModelsTransport = {
      discover: vi.fn().mockResolvedValue({
        status: 200,
        body: { models: [{ modelId: 'gpt-5.6', capabilities: ['chat'] }] },
      }),
      execute: vi.fn().mockResolvedValue({ status: 202, body: { callId: 'a'.repeat(32), accepted: true } }),
    };
    const { createCloudProviderSync } = await import('../../electron/main/cloud-account/provider-sync');

    await createCloudProviderSync({
      fetchClientBootstrap,
      providerAccountsTransport: providerAccountsTransport as never,
      awaitProviderCall: hoisted.awaitProviderCall,
      providerModelsTransport: providerModelsTransport as never,
    }).reconcile(session);

    expect(fetchClientBootstrap).toHaveBeenCalledWith('cloud-token');
    expect(hoisted.storeProviderPrivateAccountMock).toHaveBeenCalledWith(
      { transport: providerAccountsTransport, awaitProviderCall: hoisted.awaitProviderCall },
      {
        id: 'matcha-cloud',
        provider: 'custom',
        label: 'Matcha Cloud (7)',
        enabled: true,
        kind: 'chat',
        endpoint: 'https://gateway.example.com/v1',
        protocol: 'openAiCompletions',
        authMode: 'apiKey',
        revision: 1,
      },
      'sk-live',
    );
    expect(hoisted.awaitProviderCall).toHaveBeenCalledWith(
      { callId: 'a'.repeat(32), accepted: true },
      'providerModels.replace',
    );
    expect(providerModelsTransport.discover).toHaveBeenCalledWith('matcha-cloud');
    expect(providerModelsTransport.execute).toHaveBeenCalledWith({
      id: 'provider.models',
      operationId: 'providerModels.replace',
      scope: { kind: 'provider-model-catalog' },
      target: { kind: 'provider-models' },
      input: {
        kind: 'replace',
        accountId: 'matcha-cloud',
        models: [{ modelId: 'gpt-5.6', capabilities: ['chat'] }],
      },
    });
  });

  it('bumps the provider revision when the bootstrap endpoint changes', async () => {
    const fetchClientBootstrap = vi.fn().mockResolvedValue({
      ...bootstrap,
      clients: { openai: { ...bootstrap.clients.openai, baseUrl: 'https://gateway.example.com/v2' } },
    });
    const providerAccountsTransport = {
      execute: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          account: {
            id: 'matcha-cloud',
            provider: 'custom',
            label: 'Matcha Cloud (7)',
            enabled: true,
            kind: 'chat',
            endpoint: 'https://gateway.example.com/v1',
            protocol: 'openAiCompletions',
            authMode: 'apiKey',
            revision: 3,
          },
        },
      }),
    };
    const providerModelsTransport = {
      discover: vi.fn().mockResolvedValue({ status: 200, body: { models: [{ modelId: 'gpt-5.6', capabilities: ['chat'] }] } }),
      execute: vi.fn().mockResolvedValue({ status: 202, body: { callId: 'a'.repeat(32), accepted: true } }),
    };
    const { createCloudProviderSync } = await import('../../electron/main/cloud-account/provider-sync');

    await createCloudProviderSync({
      fetchClientBootstrap,
      providerAccountsTransport: providerAccountsTransport as never,
      awaitProviderCall: hoisted.awaitProviderCall,
      providerModelsTransport: providerModelsTransport as never,
    }).reconcile(session);

    expect(hoisted.storeProviderPrivateAccountMock).toHaveBeenCalledWith(
      { transport: providerAccountsTransport, awaitProviderCall: hoisted.awaitProviderCall },
      expect.objectContaining({ endpoint: 'https://gateway.example.com/v2', revision: 4 }),
      'sk-live',
    );
  });

  it('deletes the managed account when the cloud session is cleared', async () => {
    const providerAccountsTransport = {
      execute: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          account: {
            id: 'matcha-cloud',
            provider: 'custom',
            label: 'Matcha Cloud (7)',
            enabled: true,
            kind: 'chat',
            endpoint: 'https://gateway.example.com/v1',
            protocol: 'openAiCompletions',
            authMode: 'apiKey',
            revision: 3,
          },
        },
      }),
    };
    const { createCloudProviderSync } = await import('../../electron/main/cloud-account/provider-sync');

    await createCloudProviderSync({
      fetchClientBootstrap: vi.fn(),
      providerAccountsTransport: providerAccountsTransport as never,
      awaitProviderCall: hoisted.awaitProviderCall,
      providerModelsTransport: { discover: vi.fn(), execute: vi.fn() } as never,
    }).reconcile(null);

    expect(hoisted.deleteProviderPrivateAccountMock).toHaveBeenCalledWith(
      { transport: providerAccountsTransport, awaitProviderCall: hoisted.awaitProviderCall },
      'matcha-cloud',
      3,
    );
  });
});
