import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverProviderModels } from '@/lib/provider-model-catalog';
import {
  getMainApiBoundarySnapshot,
  isHostApiRequestAllowed,
  isMainOwnedRoute,
} from '../../electron/api/route-boundary';
import { handleProviderModelsRoutes } from '../../electron/api/routes/provider-models';
import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import { createProviderModelsTransport } from '../../electron/main/runtime-host-delivery/transport/providers/models';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

const discoverBody = {
  models: [{
    modelId: 'gpt-5.5',
    capabilities: ['chat', 'imageUnderstand'],
    contextWindow: 128000,
    maxTokens: 8192,
    timeoutMs: 30000,
    aspectRatio: '16:9',
    resolution: '1K',
    quality: 'high',
  }],
};

const invalidBody = {
  success: false,
  error: 'Provider model request is invalid',
} as const;

const rejectedBody = {
  success: false,
  error: 'Provider model request was rejected',
} as const;

const unavailableBody = {
  success: false,
  error: 'Provider models are unavailable',
} as const;

function decisionFrom(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const authorization = fetcher.mock.calls[call]?.[1]?.headers.Authorization as string;
  const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
  return JSON.parse(Buffer.from(decision, 'base64url').toString());
}

function incoming(body: unknown, method = 'GET') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('provider models discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiFetchMock.mockReset();
  });

  it('renderer decoder accepts discovery drafts and removes duplicate ids', async () => {
    hostApiFetchMock.mockResolvedValue({
      models: [
        { modelId: 'gpt-5.5', capabilities: ['chat', 'chat', 'imageUnderstand'], contextWindow: 128000 },
        { modelId: 'gpt-5.5', capabilities: ['chat'], contextWindow: 256000 },
      ],
    });

    await expect(discoverProviderModels(' account-main ')).resolves.toEqual({
      models: [{ modelId: 'gpt-5.5', capabilities: ['chat', 'imageUnderstand'], contextWindow: 128000 }],
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-models/discover?accountId=account-main');
  });

  it('renderer decoder rejects discovery drafts with legacy or private fields', async () => {
    for (const body of [
      { models: [{ ...discoverBody.models[0], runtimeModelRef: 'private-reference' }] },
      { models: [{ ...discoverBody.models[0], credentialId: 'credential-main' }] },
      { models: [{ ...discoverBody.models[0], accountId: 'account-main' }] },
      { models: [{ ...discoverBody.models[0], apiKey: 'sk-private' }] },
    ]) {
      hostApiFetchMock.mockResolvedValueOnce(body);
      await expect(discoverProviderModels('account-main')).rejects.toThrow('Provider model discovery is unavailable');
    }
  });

  it('decodes public discover responses and sends only the account identity to Rust', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => discoverBody });
    const transport = createProviderModelsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.discover('account-main')).resolves.toEqual({
      status: 200,
      body: discoverBody,
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/provider-models', expect.objectContaining({
      method: 'POST',
    }));
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      id: 'provider.models',
      operationId: 'providerModels.discover',
      scope: { kind: 'provider-model-catalog' },
      target: { kind: 'provider-models' },
      input: { kind: 'discover', accountId: 'account-main' },
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain('apiKey');
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain('baseUrl');
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain('secret');
    expect(decisionFrom(fetcher)).toMatchObject({
      endpoint: '/api/provider-models',
      scope: 'providers:models',
      capability: 'providerModels.discover',
      subject: 'provider-models',
    });
  });

  it('redacts malformed discover responses that contain legacy or private fields', async () => {
    for (const body of [
      { models: [{ ...discoverBody.models[0], runtimeModelRef: 'private-reference' }] },
      { models: [{ ...discoverBody.models[0], credentialId: 'credential-main' }] },
      { models: [{ ...discoverBody.models[0], accountId: 'account-main' }] },
      { models: [{ ...discoverBody.models[0], apiKey: 'sk-private' }] },
    ]) {
      const transport = createProviderModelsTransport(
        createRuntimeHostDeliveryIssuer(),
        3227,
        vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
      );

      await expect(transport.discover('account-main')).resolves.toEqual({
        status: 503,
        body: unavailableBody,
      });
    }
  });

  it('maps discover invalid and rejected responses to fixed public errors', async () => {
    const invalid = createProviderModelsTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({ status: 400, json: async () => ({ detail: 'private invalid' }) }),
    );
    await expect(invalid.discover('account-main')).resolves.toEqual({
      status: 400,
      body: invalidBody,
    });

    const rejected = createProviderModelsTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({ status: 422, json: async () => ({ detail: 'private rejected' }) }),
    );
    await expect(rejected.discover('account-main')).resolves.toEqual({
      status: 422,
      body: rejectedBody,
    });
  });

  it('routes GET discovery by accountId without touching list or replace transports', async () => {
    const read = vi.fn();
    const readSelectable = vi.fn();
    const discover = vi.fn().mockResolvedValue({ status: 200, body: discoverBody });
    const execute = vi.fn();
    const result = response();

    await expect(handleProviderModelsRoutes(
      incoming({}, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/provider-models/discover?accountId=account-main'),
      { read, readSelectable, discover, execute },
    )).resolves.toBe(true);

    expect(discover).toHaveBeenCalledWith('account-main');
    expect(read).not.toHaveBeenCalled();
    expect(readSelectable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: discoverBody });
  });

  it('rejects invalid discovery accountId queries before transport dispatch', async () => {
    const read = vi.fn();
    const readSelectable = vi.fn();
    const discover = vi.fn();
    const execute = vi.fn();

    for (const url of [
      'http://127.0.0.1/api/provider-models/discover',
      'http://127.0.0.1/api/provider-models/discover?accountId=',
      'http://127.0.0.1/api/provider-models/discover?accountId=../private',
      'http://127.0.0.1/api/provider-models/discover?accountId=account-main&extra=1',
      'http://127.0.0.1/api/provider-models/discover?accountId=account-main&accountId=account-next',
    ]) {
      const result = response();
      await expect(handleProviderModelsRoutes(
        incoming({}, 'GET') as never,
        result.raw as never,
        new URL(url),
        { read, readSelectable, discover, execute },
      )).resolves.toBe(true);
      expect(result.state).toEqual({ statusCode: 400, body: invalidBody });
    }

    expect(discover).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(readSelectable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps GET discovery in the Host API allowlist only for its public route', () => {
    const snapshot = getMainApiBoundarySnapshot();

    expect(isMainOwnedRoute('/api/provider-models/discover')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/provider-models/discover')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/provider-models/discover')).toBe(false);
    expect(snapshot.mainOwnedExactRoutes).toContain('/api/provider-models/discover');
    expect(snapshot.hostApiAllowedRequests).toContainEqual(['GET', '/api/provider-models/discover']);
  });
});
