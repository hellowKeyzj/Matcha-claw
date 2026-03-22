import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProviderAccount } from '../../electron/shared/providers/types';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();

const syncDefaultProviderToRuntimeMock = vi.fn();
const syncDeletedProviderApiKeyToRuntimeMock = vi.fn();
const syncDeletedProviderToRuntimeMock = vi.fn();
const syncSavedProviderToRuntimeMock = vi.fn();
const syncUpdatedProviderToRuntimeMock = vi.fn();

const validateApiKeyWithProviderMock = vi.fn();
const providerAccountToConfigMock = vi.fn();

const providerServiceMock = {
  getAccount: vi.fn(),
  getDefaultAccountId: vi.fn(),
  deleteAccount: vi.fn(),
  deleteAccountApiKey: vi.fn(),
  listAccounts: vi.fn(),
  setDefaultAccount: vi.fn(),
  listVendors: vi.fn(),
  listAccountStatuses: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  hasAccountApiKey: vi.fn(),
  getAccountApiKey: vi.fn(),
};

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../electron/services/providers/provider-runtime-sync', () => ({
  syncDefaultProviderToRuntime: (...args: unknown[]) => syncDefaultProviderToRuntimeMock(...args),
  syncDeletedProviderApiKeyToRuntime: (...args: unknown[]) => syncDeletedProviderApiKeyToRuntimeMock(...args),
  syncDeletedProviderToRuntime: (...args: unknown[]) => syncDeletedProviderToRuntimeMock(...args),
  syncSavedProviderToRuntime: (...args: unknown[]) => syncSavedProviderToRuntimeMock(...args),
  syncUpdatedProviderToRuntime: (...args: unknown[]) => syncUpdatedProviderToRuntimeMock(...args),
}));

vi.mock('../../electron/services/providers/provider-validation', () => ({
  validateApiKeyWithProvider: (...args: unknown[]) => validateApiKeyWithProviderMock(...args),
}));

vi.mock('../../electron/services/providers/provider-service', () => ({
  getProviderService: () => providerServiceMock,
}));

vi.mock('../../electron/services/providers/provider-store', () => ({
  providerAccountToConfig: (...args: unknown[]) => providerAccountToConfigMock(...args),
}));

vi.mock('../../electron/utils/provider-registry', () => ({
  getProviderConfig: vi.fn(),
}));

vi.mock('../../electron/utils/device-oauth', () => ({
  deviceOAuthManager: {
    startFlow: vi.fn(),
    stopFlow: vi.fn(),
  },
}));

vi.mock('../../electron/utils/browser-oauth', () => ({
  browserOAuthManager: {
    startFlow: vi.fn(),
    stopFlow: vi.fn(),
    submitManualCode: vi.fn(),
  },
}));

function buildAccount(input: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: 'provider-id',
    vendorId: 'openai',
    label: 'Provider',
    authMode: 'api_key',
    enabled: true,
    isDefault: false,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...input,
  };
}

describe('provider routes delete default', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    providerAccountToConfigMock.mockImplementation((account: ProviderAccount) => ({
      id: account.id,
      type: account.vendorId,
    }));
    syncDeletedProviderToRuntimeMock.mockResolvedValue(undefined);
    syncDefaultProviderToRuntimeMock.mockResolvedValue(undefined);
  });

  it('deleting default provider auto-selects a fallback default account', async () => {
    const deleting = buildAccount({
      id: 'openai-default',
      vendorId: 'openai',
      updatedAt: '2026-03-10T00:00:00.000Z',
    });
    const fallbackOlder = buildAccount({
      id: 'anthropic-a',
      vendorId: 'anthropic',
      updatedAt: '2026-03-09T00:00:00.000Z',
    });
    const fallbackNewer = buildAccount({
      id: 'moonshot-b',
      vendorId: 'moonshot',
      updatedAt: '2026-03-11T00:00:00.000Z',
    });

    providerServiceMock.getAccount.mockResolvedValue(deleting);
    providerServiceMock.getDefaultAccountId.mockResolvedValue('openai-default');
    providerServiceMock.deleteAccount.mockResolvedValue(true);
    providerServiceMock.listAccounts.mockResolvedValue([fallbackOlder, fallbackNewer]);
    providerServiceMock.setDefaultAccount.mockResolvedValue(undefined);

    const { handleProviderRoutes } = await import('../../electron/api/routes/providers');
    const handled = await handleProviderRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/provider-accounts/openai-default'),
      { gatewayManager: {} } as never,
    );

    expect(handled).toBe(true);
    expect(syncDeletedProviderToRuntimeMock).toHaveBeenCalledWith(
      { id: 'openai-default', type: 'openai' },
      'openai-default',
      {},
      undefined,
    );
    expect(providerServiceMock.setDefaultAccount).toHaveBeenCalledWith('moonshot-b');
    expect(syncDefaultProviderToRuntimeMock).toHaveBeenCalledWith('moonshot-b', {});
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('deleting non-default provider does not rebalance default account', async () => {
    const deleting = buildAccount({
      id: 'anthropic-a',
      vendorId: 'anthropic',
      updatedAt: '2026-03-09T00:00:00.000Z',
    });

    providerServiceMock.getAccount.mockResolvedValue(deleting);
    providerServiceMock.getDefaultAccountId.mockResolvedValue('openai-default');
    providerServiceMock.deleteAccount.mockResolvedValue(true);

    const { handleProviderRoutes } = await import('../../electron/api/routes/providers');
    const handled = await handleProviderRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/provider-accounts/anthropic-a'),
      { gatewayManager: {} } as never,
    );

    expect(handled).toBe(true);
    expect(providerServiceMock.listAccounts).not.toHaveBeenCalled();
    expect(providerServiceMock.setDefaultAccount).not.toHaveBeenCalled();
    expect(syncDefaultProviderToRuntimeMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });
});

