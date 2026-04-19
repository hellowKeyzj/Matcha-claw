import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const envBackup = { ...process.env };

import {
  createDefaultRuntimeHostHttpClient,
  createRuntimeHostHttpClient,
  getRuntimeHostBaseUrl,
  getRuntimeHostPort,
  RuntimeHostClientRequestError,
} from '../../electron/main/runtime-host-client';

describe('runtime-host http client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env = { ...envBackup };
    delete process.env.MATCHACLAW_RUNTIME_HOST_PORT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatch 成功时返回 route result', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        version: 1,
        success: true,
        status: 200,
        data: { source: 'child' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createRuntimeHostHttpClient({ baseUrl: 'http://127.0.0.1:3211' });
    const result = await client.request<{ source: string }>('GET', '/api/workbench/bootstrap');

    expect(result).toEqual({
      status: 200,
      data: { source: 'child' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3211/dispatch',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('dispatch 返回失败 payload 时抛出结构化错误', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        version: 1,
        success: false,
        status: 501,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'not implemented',
        },
      }), {
        status: 501,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createRuntimeHostHttpClient({ baseUrl: 'http://127.0.0.1:3211' });

    await expect(client.request('GET', '/api/workbench/bootstrap')).rejects.toMatchObject({
      status: 501,
      code: 'NOT_IMPLEMENTED',
      retryable: true,
    } satisfies Partial<RuntimeHostClientRequestError>);
  });

  it('网络异常时转换为 UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = createRuntimeHostHttpClient({ baseUrl: 'http://127.0.0.1:3211' });

    await expect(client.request('GET', '/api/workbench/bootstrap')).rejects.toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    } satisfies Partial<RuntimeHostClientRequestError>);
  });

  it('响应体不符合 v1 transport 合同时抛 INVALID_TRANSPORT_PAYLOAD', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        status: 200,
        data: { source: 'child' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createRuntimeHostHttpClient({ baseUrl: 'http://127.0.0.1:3211' });

    await expect(client.request('GET', '/api/workbench/bootstrap')).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_TRANSPORT_PAYLOAD',
      retryable: false,
    } satisfies Partial<RuntimeHostClientRequestError>);
  });

  it('默认客户端工厂使用统一 runtime-host 端口配置', async () => {
    process.env.MATCHACLAW_RUNTIME_HOST_PORT = '4325';
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        version: 1,
        success: true,
        status: 200,
        data: { ok: true },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(getRuntimeHostPort()).toBe(4325);
    expect(getRuntimeHostBaseUrl()).toBe('http://127.0.0.1:4325');

    const client = createDefaultRuntimeHostHttpClient();
    await client.request('GET', '/api/runtime-host/health');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4325/dispatch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('单次 request 支持覆盖默认超时', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        version: 1,
        success: true,
        status: 200,
        data: { ok: true },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const client = createRuntimeHostHttpClient({ baseUrl: 'http://127.0.0.1:3211', timeoutMs: 15000 });

    await client.request('POST', '/api/gateway/rpc', { method: 'chat.send' }, { timeoutMs: 45000 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 45000);
    setTimeoutSpy.mockRestore();
  });
});
