import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityExecuteMock } from './helpers/mock-gateway-client';
import type { RuntimeScope } from '../../runtime-host/shared/runtime-address';

const modelProviderRuntimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
};

describe('provider accounts helper', () => {
  beforeEach(() => {
    capabilityExecuteMock.mockReset();
  });

  it('fetchProviderSnapshot 直接消费 /api/provider-accounts snapshot', async () => {
    capabilityExecuteMock.mockResolvedValue({
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
    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'model.provider',
      operationId: 'providers.listAccounts',
      scope: modelProviderRuntimeScope,
      target: null,
      input: {},
    }), { timeoutMs: undefined });
  });

  it('fetchProviderSnapshot 会归一化异常返回结构，避免空值崩溃', async () => {
    capabilityExecuteMock.mockResolvedValue(undefined);

    const { fetchProviderSnapshot } = await import('../../src/lib/provider-accounts');
    await expect(fetchProviderSnapshot()).resolves.toEqual({
      credentials: [],
      statuses: [],
      vendors: [],
    });
  });

  it('hostProviderValidate always uses provider-credential target', async () => {
    capabilityExecuteMock.mockResolvedValue({ valid: true });

    const { hostProviderValidate } = await import('../../src/lib/provider-projection');
    await expect(hostProviderValidate({
      vendorId: 'openai',
      apiKey: 'sk-test',
    })).resolves.toEqual({ valid: true });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'model.provider',
      operationId: 'providers.validate',
      scope: modelProviderRuntimeScope,
      target: { kind: 'provider-credential', accountId: 'openai', vendorId: 'openai' },
      input: {
        vendorId: 'openai',
        apiKey: 'sk-test',
      },
    }), { timeoutMs: undefined });
  });

  it('hostProviderSubmitOAuthCode binds full OAuth flow context in target and input', async () => {
    capabilityExecuteMock.mockResolvedValue({ success: true });

    const { hostProviderSubmitOAuthCode } = await import('../../src/lib/provider-projection');
    await expect(hostProviderSubmitOAuthCode({
      flowId: 'flow-openai-main',
      accountId: 'openai-main',
      vendorId: 'openai',
      code: 'oauth-code',
    })).resolves.toEqual({ success: true });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'model.provider',
      operationId: 'providers.oauthSubmit',
      scope: modelProviderRuntimeScope,
      target: { kind: 'provider-oauth', flowId: 'flow-openai-main', accountId: 'openai-main', vendorId: 'openai' },
      input: {
        code: 'oauth-code',
        flowId: 'flow-openai-main',
        accountId: 'openai-main',
        vendorId: 'openai',
      },
    }), { timeoutMs: undefined });
  });
});
