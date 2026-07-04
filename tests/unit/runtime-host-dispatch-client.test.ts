import { describe, expect, it, vi } from 'vitest';
import { dispatchRuntimeHostRoute, invokeRuntimeCapability, RuntimeHostDispatchClientError } from '../../runtime-host/application/runtime-cli/runtime-host-dispatch-client';

function jsonResponse(input: { readonly ok: boolean; readonly status: number; readonly body: unknown }) {
  return {
    ok: input.ok,
    status: input.status,
    json: async () => input.body,
  } as Response;
}

describe('runtime-host dispatch client', () => {
  it('posts dispatch envelopes and returns data', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      status: 200,
      body: { success: true, data: { accepted: true } },
    }));

    const data = await dispatchRuntimeHostRoute({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211/',
      timeoutMs: 1000,
      fetchImpl: fetchMock as never,
      method: 'POST',
      route: '/api/test',
      payload: { value: 1 },
    });

    expect(data).toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://127.0.0.1:3211/dispatch');
    expect(JSON.parse(init.body)).toMatchObject({
      version: 1,
      method: 'POST',
      route: '/api/test',
      payload: { value: 1 },
    });
  });

  it('classifies dispatch failure envelopes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: false,
      status: 404,
      body: { success: false, error: { code: 'NOT_FOUND', message: 'missing route' } },
    }));

    await expect(dispatchRuntimeHostRoute({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211',
      timeoutMs: 1000,
      fetchImpl: fetchMock as never,
      method: 'POST',
      route: '/api/missing',
    })).rejects.toMatchObject({
      kind: 'dispatchFailure',
      status: 404,
      code: 'NOT_FOUND',
      message: 'missing route',
    });
  });

  it('classifies non-JSON responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    }));

    await expect(dispatchRuntimeHostRoute({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211',
      timeoutMs: 1000,
      fetchImpl: fetchMock as never,
      method: 'POST',
      route: '/api/test',
    })).rejects.toMatchObject({
      kind: 'invalidResponse',
      status: 200,
    });
  });

  it('classifies runtime capability application failures', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      status: 200,
      body: { success: true, data: { success: false, error: { message: 'rejected' } } },
    }));

    await expect(invokeRuntimeCapability({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211',
      timeoutMs: 1000,
      fetchImpl: fetchMock as never,
      id: 'team.runtime',
      operationId: 'team.nodeEvent',
      scope: {
        kind: 'team-run',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        runId: 'run-1',
      },
      target: { kind: 'team-run', runId: 'run-1' },
      capabilityInput: {},
    })).rejects.toMatchObject({
      kind: 'applicationFailure',
      message: 'rejected',
    });
  });

  it('classifies aborted fetch as timeout', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

    await expect(dispatchRuntimeHostRoute({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211',
      timeoutMs: 1,
      fetchImpl: fetchMock as never,
      method: 'POST',
      route: '/api/test',
    })).rejects.toBeInstanceOf(RuntimeHostDispatchClientError);

    await expect(dispatchRuntimeHostRoute({
      runtimeHostBaseUrl: 'http://127.0.0.1:3211',
      timeoutMs: 1,
      fetchImpl: fetchMock as never,
      method: 'POST',
      route: '/api/test',
    })).rejects.toMatchObject({ kind: 'timeout' });
  });
});
