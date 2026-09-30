import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchProviderSnapshotMock = vi.hoisted(() => vi.fn());
const hostProviderUpdateAccountMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/provider-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/provider-accounts')>();
  return {
    ...actual,
    fetchProviderSnapshot: (...args: unknown[]) => fetchProviderSnapshotMock(...args),
  };
});

vi.mock('@/lib/provider-projection', () => ({
  hostProviderCreateAccount: vi.fn(),
  hostProviderDeleteAccount: vi.fn(),
  hostProviderUpdateAccount: (...args: unknown[]) => hostProviderUpdateAccountMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
  startUiTiming: vi.fn(() => () => 1),
}));

import { normalizeProviderSnapshot } from '@/lib/provider-accounts';
import { useProviderStore } from '@/stores/providers';

describe('provider account public round trip', () => {
  beforeEach(() => {
    fetchProviderSnapshotMock.mockReset();
    hostProviderUpdateAccountMock.mockReset();
    localStorage.clear();
  });

  it('保留 direct public snapshot 的 endpoint、protocol 和 mediaProtocol 到 account 更新输入', async () => {
    const snapshot = normalizeProviderSnapshot({
      credentials: [
        {
          id: 'custom-chat',
          vendorId: 'custom',
          providerKind: 'chat',
          label: 'Custom chat',
          enabled: true,
          baseUrl: 'https://chat.example.test/v1',
          apiProtocol: 'google-generative-ai',
          authMode: 'api_key',
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'custom-media',
          vendorId: 'custom',
          providerKind: 'media',
          label: 'Custom media',
          enabled: true,
          baseUrl: 'https://media.example.test/v1',
          mediaApiProtocol: 'openrouter',
          authMode: 'api_key',
          createdAt: '',
          updatedAt: '',
        },
      ],
      statuses: [],
      vendors: [],
      revisions: {
        'custom-chat': 3,
        'custom-media': 5,
      },
    });
    fetchProviderSnapshotMock.mockResolvedValue(snapshot);
    hostProviderUpdateAccountMock.mockImplementation(async (account, revision) => ({
      success: true,
      receipt: {
        kind: 'replaceAccount',
        phase: 'terminal',
        outcome: 'stored',
        count: null,
        acceptedCount: null,
        persisted: 'confirmed',
        commit: 'committed',
        accountId: account.id,
        accountRevision: revision,
        diagnostic: null,
        native: { changed: false, applied: 'unknown', observed: 'unavailable' },
      },
    }));
    useProviderStore.setState({
      providerSnapshot: snapshot,
      snapshotReady: true,
      scopeKey: 'default',
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });

    await useProviderStore.getState().updateAccount('custom-chat', { label: 'Custom chat updated' }, 'next-chat-key');
    await useProviderStore.getState().updateAccount('custom-media', { label: 'Custom media updated' }, 'next-media-key');

    expect(hostProviderUpdateAccountMock).toHaveBeenNthCalledWith(1, {
      id: 'custom-chat',
      vendorId: 'custom',
      providerKind: 'chat',
      label: 'Custom chat updated',
      authMode: 'api_key',
      baseUrl: 'https://chat.example.test/v1',
      apiProtocol: 'google-generative-ai',
      enabled: true,
      createdAt: '',
      updatedAt: expect.any(String),
    }, 4, 'next-chat-key', undefined);
    expect(hostProviderUpdateAccountMock).toHaveBeenNthCalledWith(2, {
      id: 'custom-media',
      vendorId: 'custom',
      providerKind: 'media',
      label: 'Custom media updated',
      authMode: 'api_key',
      baseUrl: 'https://media.example.test/v1',
      mediaApiProtocol: 'openrouter',
      enabled: true,
      createdAt: '',
      updatedAt: expect.any(String),
    }, 6, 'next-media-key', undefined);
  });

  it('拒绝携带私密、未知或无效字段的 public vendor metadata', () => {
    const validVendor = {
      id: 'custom',
      name: 'Custom',
      icon: 'C',
      placeholder: 'API key...',
      requiresApiKey: true,
      category: 'custom',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
    };

    expect(normalizeProviderSnapshot({
      credentials: [],
      statuses: [],
      vendors: [
        validVendor,
        { ...validVendor, apiKey: 'secret-canary' },
        { ...validVendor, id: 'unknown-provider' },
        { ...validVendor, supportedAuthModes: ['unsupported'] },
      ],
      revisions: {},
    })).toEqual({
      credentials: [],
      statuses: [],
      vendors: [validVendor],
      revisions: {},
    });
  });
});
