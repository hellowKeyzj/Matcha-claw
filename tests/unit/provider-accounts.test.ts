import { beforeEach, describe, expect, it } from 'vitest';
import { hostApiFetchMock } from './helpers/mock-gateway-client';

describe('provider accounts helper', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
  });

  it('fetchProviderSnapshot 直接消费 /api/provider-accounts snapshot', async () => {
    hostApiFetchMock.mockResolvedValue({
      credentials: [{ id: 'acc-1' }],
      statuses: [{ id: 'acc-1', hasKey: true }],
      vendors: [{ id: 'openai' }],
    });

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      credentials: [{ id: 'acc-1' }],
      statuses: [{ id: 'acc-1', hasKey: true }],
      vendors: [{ id: 'openai' }],
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-accounts', undefined);
  });

  it('fetchProviderSnapshot 会归一化异常返回结构，避免空值崩溃', async () => {
    hostApiFetchMock.mockResolvedValue(undefined);

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      credentials: [],
      statuses: [],
      vendors: [],
    });
  });
});
