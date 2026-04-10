import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('validateApiKeyWithProvider', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('openai-responses 在 /models 不可用时回退到 /responses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Not Found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unknown model' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-response-test', {
      baseUrl: 'https://responses.example.com/v1',
      apiProtocol: 'openai-responses',
    });

    expect(result).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://responses.example.com/v1/models?limit=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-response-test',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://responses.example.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('openai-completions 在 /models 不可用时回退到 /chat/completions', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Not Found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unknown model' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-chat-test', {
      baseUrl: 'https://chat.example.com/v1',
      apiProtocol: 'openai-completions',
    });

    expect(result).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://chat.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('baseUrl 已含 /responses 时不重复拼接', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Not Found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unknown model' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-endpoint-test', {
      baseUrl: 'https://openrouter.ai/api/v1/responses',
      apiProtocol: 'openai-responses',
    });

    expect(result).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://openrouter.ai/api/v1/models?limit=1',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://openrouter.ai/api/v1/responses',
      expect.anything(),
    );
  });

  it('会把 options.headers 合并到校验请求头（用于 custom User-Agent）', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-custom-test', {
      baseUrl: 'https://gateway.example.com/v1',
      apiProtocol: 'openai-completions',
      headers: { 'User-Agent': 'MatchaClaw/1.0' },
    });

    expect(result).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/models?limit=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-custom-test',
          'User-Agent': 'MatchaClaw/1.0',
        }),
      }),
    );
  });

  it('openai-completions 在 /models 返回非鉴权错误时也会回退到 /chat/completions', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unknown model' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-non-auth-fallback', {
      baseUrl: 'https://fallback.example.com/v1',
      apiProtocol: 'openai-completions',
    });

    expect(result).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://fallback.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('openai-completions 在 /models 返回 400 且为鉴权失败时不应回退探测', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid API key provided' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { validateApiKeyWithProvider } = await import('../../runtime-host/application/providers/provider-validation');
    const result = await validateApiKeyWithProvider('custom', 'sk-bad-key', {
      baseUrl: 'https://auth400.example.com/v1',
      apiProtocol: 'openai-completions',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid API key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth400.example.com/v1/models?limit=1',
      expect.anything(),
    );
  });
});
