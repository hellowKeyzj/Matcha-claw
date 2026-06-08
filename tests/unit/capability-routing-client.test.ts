import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const resolveSingleCapabilityScopeMock = vi.hoisted(() => vi.fn());
const modelProviderRuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
} as const;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  resolveSingleCapabilityScope: resolveSingleCapabilityScopeMock,
}));

describe('capability routing client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSingleCapabilityScopeMock.mockResolvedValue(modelProviderRuntimeScope);
  });

  it('fetchCapabilityRouting uses no capability target', async () => {
    hostApiFetchMock.mockResolvedValue({});

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await fetchCapabilityRouting();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'model.provider',
        operationId: 'capabilityRouting.read',
        scope: modelProviderRuntimeScope,
        target: null,
        input: {},
      }),
    });
  });

  it('persistCapabilityRouting uses capability-route target', async () => {
    hostApiFetchMock.mockResolvedValue({ success: true, routing: {} });

    const { persistCapabilityRouting } = await import('@/lib/capability-routing');
    await persistCapabilityRouting({
      chat: {
        primary: { credentialId: 'custom-1', modelId: 'gpt-5.4' },
        fallbacks: [],
      },
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'model.provider',
        operationId: 'capabilityRouting.write',
        scope: modelProviderRuntimeScope,
        target: { kind: 'capability-route', capabilityId: 'model.provider' },
        input: {
          chat: {
            primary: { credentialId: 'custom-1', modelId: 'gpt-5.4' },
            fallbacks: [],
          },
        },
      }),
    });
  });
});
