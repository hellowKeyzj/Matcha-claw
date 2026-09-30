import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createProviderModelsTransport } from '../../electron/main/runtime-host-delivery/transport/providers/models';

const replaceRequest = {
  id: 'provider.models' as const,
  operationId: 'providerModels.replace' as const,
  scope: { kind: 'provider-model-catalog' as const },
  target: { kind: 'provider-models' as const },
  input: {
    kind: 'replace' as const,
    accountId: 'account-main',
    models: [{ modelId: 'gpt-test', capabilities: ['chat' as const] }],
  },
};

const selectable = {
  models: [{
    accountId: 'account-main',
    selectionId: 'model-selection:v1:6666666666666666666666666666666666666666666666666666666666666666',
    label: 'Main provider',
    modelId: 'gpt-test',
    capabilities: ['chat'],
    contextWindow: 128000,
    maxTokens: 8192,
    timeoutMs: 30000,
    modelReferences: ['openai/gpt-test'],
    aspectRatio: '16:9',
    resolution: '1080p',
    quality: 'high',
  }],
};

function decisionFrom(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const authorization = fetcher.mock.calls[call]?.[1]?.headers.Authorization as string;
  const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
  return JSON.parse(Buffer.from(decision, 'base64url').toString());
}

describe('provider models delivery transport', () => {
  it('binds a provider-model decision to the fixed localhost endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ models: [] }),
    });
    const transport = createProviderModelsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.read()).resolves.toEqual({ status: 200, body: { models: [] } });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/provider-models', expect.objectContaining({
      method: 'GET',
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/provider-models',
      scope: 'providers:models',
      capability: 'providerModels.list',
      subject: 'provider-models',
    });
  });

  it('reads the direct chat-selectable DTO through its signed GET endpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => selectable });
    const transport = createProviderModelsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.readSelectable('chat')).resolves.toEqual({ status: 200, body: selectable });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3227/api/provider-models/selectable?capability=chat',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(decisionFrom(fetcher)).toMatchObject({
      endpoint: '/api/provider-models/selectable',
      scope: 'providers:models',
      capability: 'providerModels.listSelectable',
      subject: 'provider-models',
      expiresAt: Date.now() + 30_000,
    });
    vi.useRealTimers();
  });

  it('keeps owner admission separate from durable storage and the private configuration effect', async () => {
    const receipt = { callId: '0123456789abcdef0123456789abcdef', accepted: true };
    const fetcher = vi.fn().mockResolvedValue({ status: 202, json: async () => receipt });
    const transport = createProviderModelsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.execute(replaceRequest)).resolves.toEqual({ status: 202, body: receipt });
    expect(decisionFrom(fetcher)).toMatchObject({ capability: 'providerModels.replace' });

    const finalResponse = {
      success: true,
      desired: { status: 'stored' },
      persisted: { status: 'confirmed' },
      native: { changed: false, applied: { status: 'unknown' }, observed: { status: 'unavailable' } },
      commit: 'committed',
    };
    for (const [status, body] of [
      [200, finalResponse],
      [409, finalResponse],
      [202, finalResponse],
      [202, { ...receipt, native: finalResponse.native }],
      [202, { ...receipt, callId: 'A'.repeat(32) }],
      [202, { ...receipt, accepted: false }],
    ]) {
      fetcher.mockResolvedValueOnce({ status, json: async () => body });
      await expect(transport.execute(replaceRequest)).resolves.toEqual({
        status: 503,
        body: { success: false, error: 'Provider models are unavailable' },
      });
    }
  });

  it('fails closed on malformed direct selectable responses without exposing details', async () => {
    const malformed = createProviderModelsTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          models: [{
            ...selectable.models[0],
            runtimeModelRef: 'private-reference',
          }],
        }),
      }),
    );

    await expect(malformed.readSelectable('chat')).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Provider models are unavailable' },
    });
  });

  it('rejects secret-bearing input and redacts malformed native responses', async () => {
    const fetcher = vi.fn();
    const transport = createProviderModelsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);
    await expect(transport.execute({
      ...replaceRequest,
      input: {
        ...replaceRequest.input,
        models: [{ ...replaceRequest.input.models[0], baseUrl: 'https://secret.example' }],
      },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Provider model request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();

    const malformed = createProviderModelsTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ models: [{ credential: 'private-reference' }] }),
      }),
    );
    await expect(malformed.read()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Provider models are unavailable' },
    });
  });
});
