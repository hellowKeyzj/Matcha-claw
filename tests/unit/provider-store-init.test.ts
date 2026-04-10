import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const fetchProviderSnapshotMock = vi.fn();

vi.mock('@/lib/provider-accounts', () => ({
  fetchProviderSnapshot: (...args: unknown[]) => fetchProviderSnapshotMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

import { useProviderStore } from '@/stores/providers';

describe('useProviderStore.init', () => {
  beforeEach(() => {
    fetchProviderSnapshotMock.mockReset();
    useProviderStore.setState({
      statuses: [],
      accounts: [],
      vendors: [],
      defaultAccountId: null,
      loading: false,
      error: null,
    });
  });

  it('会触发 refreshProviderSnapshot 并写入快照', async () => {
    fetchProviderSnapshotMock.mockResolvedValueOnce({
      statuses: [{ id: 'openai-main', name: 'OpenAI', hasKey: true, keyMasked: 'sk-****' }],
      accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: 'openai-main',
    });

    await act(async () => {
      await useProviderStore.getState().init();
    });

    expect(fetchProviderSnapshotMock).toHaveBeenCalledTimes(1);
    const state = useProviderStore.getState();
    expect(state.defaultAccountId).toBe('openai-main');
    expect(state.accounts).toEqual([{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('快照失败时会收敛到 error 状态', async () => {
    fetchProviderSnapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));

    await act(async () => {
      await useProviderStore.getState().init();
    });

    const state = useProviderStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toContain('snapshot failed');
  });
});

