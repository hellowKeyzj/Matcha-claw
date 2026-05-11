import { beforeEach, describe, expect, it } from 'vitest';
import { hostApiFetchMock } from './helpers/mock-gateway-client';

describe('provider accounts helper', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
  });

  it('fetchProviderSnapshot 直接消费 /api/provider-accounts snapshot', async () => {
    hostApiFetchMock.mockResolvedValue({
      accounts: [{ id: 'acc-1' }],
      statuses: [{ id: 'acc-1', hasKey: true }],
      vendors: [{ id: 'openai' }],
      defaultAccountId: 'acc-1',
    });

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      accounts: [{ id: 'acc-1' }],
      statuses: [{ id: 'acc-1', hasKey: true }],
      vendors: [{ id: 'openai' }],
      defaultAccountId: 'acc-1',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-accounts', undefined);
  });

  it('fetchProviderSnapshot 会归一化异常返回结构，避免空值崩溃', async () => {
    hostApiFetchMock.mockResolvedValue(undefined);

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      accounts: [],
      statuses: [],
      vendors: [],
      defaultAccountId: null,
    });
  });
});
