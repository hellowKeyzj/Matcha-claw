import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

describe('capability routing client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists routing through the direct provider-routing endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({
      routing: {
        revision: 3,
        routes: [{
          capability: 'chat',
          primary: { accountId: 'custom-1', modelId: 'gpt-5.4' },
          fallbacks: [],
        }],
      },
    });

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(fetchCapabilityRouting()).resolves.toEqual({
      revision: 3,
      routing: {
        chat: {
          primary: { accountId: 'custom-1', modelId: 'gpt-5.4' },
          fallbacks: [],
        },
      },
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-routing', { method: 'GET' });
  });

  it('represents absent desired routing without inventing a revision', async () => {
    hostApiFetchMock.mockResolvedValue({ routing: null });

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(fetchCapabilityRouting()).resolves.toEqual({ revision: null, routing: {} });
  });

  it.each(['credential', 'credentialReference'])('rejects a routing response with a legacy %s reference', async (legacyKey) => {
    hostApiFetchMock.mockResolvedValue({
      routing: {
        revision: 3,
        routes: [{
          capability: 'chat',
          primary: { [legacyKey]: 'credential:v1:custom-1', modelId: 'gpt-5.4' },
          fallbacks: [],
        }],
      },
    });

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(fetchCapabilityRouting()).rejects.toThrow('Provider routing response is invalid');
  });

  it('rejects an invalid routing list response', async () => {
    hostApiFetchMock.mockResolvedValue({ routing: {} });

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(fetchCapabilityRouting()).rejects.toThrow('Provider routing response is invalid');
  });

  it('rejects unsupported routing capabilities without inventing transcribe', async () => {
    hostApiFetchMock.mockResolvedValue({
      routing: {
        revision: 3,
        routes: [{
          capability: 'transcribe',
          primary: { accountId: 'custom-1', modelId: 'whisper' },
          fallbacks: [],
        }],
      },
    });

    const { fetchCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(fetchCapabilityRouting()).rejects.toThrow('Provider routing response is invalid');
  });

  it('replaces routing through the direct endpoint and keeps desired/configuration separate', async () => {
    const routing = {
      chat: {
        primary: { accountId: 'custom-1', modelId: 'gpt-5.4' },
        fallbacks: [],
      },
    };
    hostApiFetchMock.mockResolvedValue({
      desired: { status: 'stored', revision: 5 },
      configuration: { status: 'unavailable' },
    });

    const { persistCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(persistCapabilityRouting(routing, 5)).resolves.toEqual({
      success: true,
      revision: 5,
      routing,
      configuration: { status: 'unavailable' },
      error: 'Provider routing configuration is unavailable',
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-routing', {
      method: 'POST',
      body: JSON.stringify({
        id: 'provider.routing',
        operationId: 'providerRouting.replace',
        scope: { kind: 'provider-routing' },
        target: { kind: 'provider-routing' },
        input: {
          kind: 'replace',
          routing: {
            revision: 5,
            routes: [{
              capability: 'chat',
              primary: { accountId: 'custom-1', modelId: 'gpt-5.4' },
              fallbacks: [],
            }],
          },
        },
      }),
    });
  });

  it('does not treat rejected desired state as a persisted routing', async () => {
    hostApiFetchMock.mockResolvedValue({ success: false, error: 'Provider routing request was rejected' });

    const { persistCapabilityRouting } = await import('@/lib/capability-routing');
    await expect(persistCapabilityRouting({}, 1)).resolves.toEqual({
      success: false,
      revision: 1,
      routing: {},
      error: 'Provider routing request was rejected',
    });
  });
});
