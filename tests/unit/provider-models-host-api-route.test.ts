import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handleProviderModelsRoutes } from '../../electron/api/routes/provider-models';

const request = {
  id: 'provider.models',
  operationId: 'providerModels.list',
  scope: { kind: 'provider-model-catalog' },
  target: { kind: 'provider-models' },
  input: { kind: 'list' },
};

const listBody = {
  models: [{
    accountId: 'account-main',
    label: 'Main provider',
    modelId: 'gpt-test',
    capabilities: ['chat'],
  }],
};

const selectableBody = {
  models: [{
    accountId: 'account-main',
    selectionId: 'openai/gpt-test',
    label: 'Main provider',
    modelId: 'gpt-test',
    capabilities: ['chat'],
    contextWindow: 128000,
    maxTokens: 8192,
  }],
};

function incoming(body: unknown, method = 'POST') {
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

describe('provider models Host API route', () => {
  it('reads the direct provider-model list without using the command transport', async () => {
    const read = vi.fn().mockResolvedValue({ status: 200, body: listBody });
    const readSelectable = vi.fn();
    const execute = vi.fn();
    const result = response();

    await expect(handleProviderModelsRoutes(
      incoming({}, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/provider-models'),
      { read, readSelectable, execute },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledOnce();
    expect(readSelectable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: listBody });
  });

  it('reads the direct chat-selectable path with canonical selectionId and accountId', async () => {
    const read = vi.fn();
    const readSelectable = vi.fn().mockResolvedValue({ status: 200, body: selectableBody });
    const execute = vi.fn();
    const result = response();

    await expect(handleProviderModelsRoutes(
      incoming({}, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/provider-models/selectable?capability=chat'),
      { read, readSelectable, execute },
    )).resolves.toBe(true);

    expect(readSelectable).toHaveBeenCalledWith('chat');
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: selectableBody });
  });

  it('rejects missing or invalid selectable queries without calling the transport', async () => {
    const read = vi.fn();
    const readSelectable = vi.fn();
    const execute = vi.fn();
    for (const url of [
      'http://127.0.0.1/api/provider-models/selectable',
      'http://127.0.0.1/api/provider-models/selectable?capability=unknown',
      'http://127.0.0.1/api/provider-models/selectable?capability=chat&capability=tts',
    ]) {
      const result = response();
      await expect(handleProviderModelsRoutes(
        incoming({}, 'GET') as never,
        result.raw as never,
        new URL(url),
        { read, readSelectable, execute },
      )).resolves.toBe(true);
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Provider model request is invalid' },
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(readSelectable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not claim nonmatching provider-model paths or methods', async () => {
    const read = vi.fn();
    const readSelectable = vi.fn();
    const execute = vi.fn();
    for (const [url, method] of [
      ['http://127.0.0.1/api/providers', 'POST'],
      ['http://127.0.0.1/api/provider-models/selectable', 'POST'],
      ['http://127.0.0.1/api/provider-models', 'PATCH'],
    ] as const) {
      const result = response();
      await expect(handleProviderModelsRoutes(
        incoming(request, method) as never,
        result.raw as never,
        new URL(url),
        { read, readSelectable, execute },
      )).resolves.toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    expect(readSelectable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts direct GET and command transport failures', async () => {
    const read = vi.fn().mockRejectedValue(new Error('private list loopback failure'));
    const readSelectable = vi.fn().mockRejectedValue(new Error('private selectable loopback failure'));
    const execute = vi.fn().mockRejectedValue(new Error('private POST loopback failure'));

    for (const [url, method, body] of [
      ['http://127.0.0.1/api/provider-models', 'GET', {}],
      ['http://127.0.0.1/api/provider-models/selectable?capability=chat', 'GET', {}],
      ['http://127.0.0.1/api/provider-models', 'POST', request],
    ] as const) {
      const result = response();
      await handleProviderModelsRoutes(
        incoming(body, method) as never,
        result.raw as never,
        new URL(url),
        { read, readSelectable, execute },
      );
      expect(result.state).toEqual({
        statusCode: 503,
        body: { success: false, error: 'Provider models are unavailable' },
      });
    }
  });
});
