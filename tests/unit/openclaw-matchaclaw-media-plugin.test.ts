import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveApiKeyForProviderMock = vi.fn();
const postJsonRequestMock = vi.fn();
const fetchWithTimeoutGuardedMock = vi.fn();
const assertOkOrThrowHttpErrorMock = vi.fn();
const resolveProviderHttpRequestConfigMock = vi.fn();

vi.mock('openclaw/plugin-sdk/provider-auth-runtime', () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock('openclaw/plugin-sdk/provider-http', () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: (input: {
    baseUrl: string;
    allowPrivateNetwork?: boolean;
    dispatcherPolicy?: unknown;
  }) => resolveProviderHttpRequestConfigMock(input) ?? ({
    baseUrl: input.baseUrl,
    allowPrivateNetwork: input.allowPrivateNetwork,
    dispatcherPolicy: input.dispatcherPolicy,
  }),
}));

describe('matchaclaw-media OpenClaw plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: 'sk-test' });
    assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
    resolveProviderHttpRequestConfigMock.mockImplementation((input) => ({
      baseUrl: input.baseUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      dispatcherPolicy: input.dispatcherPolicy,
    }));
  });

  async function loadImageProvider(pluginConfig?: Record<string, unknown>) {
    vi.resetModules();
    const plugin = (await import('../../packages/openclaw-matchaclaw-media-plugin/src/index')).default;
    const registerImageGenerationProvider = vi.fn();
    plugin.register({ pluginConfig, registerImageGenerationProvider } as never);
    return registerImageGenerationProvider.mock.calls[0]?.[0];
  }

  function makeConfig(apiProtocol: 'google' | 'openai' | 'openrouter', modelId = 'gemini-2.5-flash-image') {
    return {
      plugins: {
        entries: {
          'matchaclaw-media': {
            config: {
              providers: {
                'custom-592a8424': {
                  baseUrl: 'https://api.example.test/v1beta',
                  apiProtocol,
                  models: [{ id: modelId, capabilities: ['imageGenerate'] }],
                },
              },
            },
          },
        },
      },
    };
  }

  function makePluginConfig(apiProtocol: 'google' | 'openai' | 'openrouter', modelId = 'gemini-2.5-flash-image') {
    return {
      providers: {
        'custom-592a8424': {
          baseUrl: 'https://api.example.test/v1beta',
          apiProtocol,
          models: [{ id: modelId, capabilities: ['imageGenerate'] }],
        },
      },
    };
  }

  it('registers a lazy image provider and exposes configured model refs from startup config', async () => {
    const provider = await loadImageProvider(makePluginConfig('openai', 'gpt-image-1'));

    expect(provider).toMatchObject({
      id: 'matchaclaw-media',
      label: 'MatchaClaw Media',
      defaultModel: 'custom-592a8424/gpt-image-1',
      models: ['custom-592a8424/gpt-image-1'],
    });
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });

  function mockRemoteImageDownload(bytes = new Uint8Array([137, 80, 78, 71])) {
    const release = vi.fn();
    fetchWithTimeoutGuardedMock.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => bytes.buffer,
      },
      release,
    });
    return { bytes, release };
  }

  it('turns Google-compatible markdown image URLs into generated image assets', async () => {
    const provider = await loadImageProvider();

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: '![Generated Image](https://media.example.test/output.png)',
              }],
            },
          }],
        }),
      },
      release: vi.fn(),
    });

    const { bytes: pngBytes, release } = mockRemoteImageDownload();

    const result = await provider.generateImage({
      model: 'custom-592a8424/gemini-2.5-flash-image',
      prompt: 'red apple',
      timeoutMs: 10_000,
      cfg: {
        plugins: {
          entries: {
            'matchaclaw-media': {
              config: {
                providers: {
                  'custom-592a8424': {
                    baseUrl: 'https://api.example.test/v1beta',
                    apiProtocol: 'google',
                    models: [
                      {
                        id: 'gemini-2.5-flash-image',
                        capabilities: ['imageGenerate'],
                        timeoutMs: 90_000,
                        aspectRatio: '16:9',
                        resolution: '2K',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      fileName: 'image-1.png',
    });
    expect([...result.images[0].buffer]).toEqual([...pngBytes]);
    expect(postJsonRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 90_000,
      body: expect.objectContaining({
        generationConfig: expect.objectContaining({
          imageConfig: {
            aspectRatio: '16:9',
            imageSize: '2K',
          },
        }),
      }),
    }));
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      'https://media.example.test/output.png',
      { method: 'GET' },
      90_000,
      expect.any(Function),
      expect.objectContaining({
        auditContext: 'MatchaClaw image result',
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('turns OpenAI-compatible image URLs into generated image assets', async () => {
    const provider = await loadImageProvider();

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{
            url: 'https://media.example.test/openai-output.png',
          }],
        }),
      },
      release: vi.fn(),
    });

    const { bytes: pngBytes } = mockRemoteImageDownload();

    const result = await provider.generateImage({
      model: 'custom-592a8424/gpt-image-1',
      prompt: 'red apple',
      timeoutMs: 70_000,
      cfg: {
        plugins: {
          entries: {
            'matchaclaw-media': {
              config: {
                providers: {
                  'custom-592a8424': {
                    baseUrl: 'https://api.example.test/v1beta',
                    apiProtocol: 'openai',
                    models: [
                      {
                        id: 'gpt-image-1',
                        capabilities: ['imageGenerate'],
                        aspectRatio: '1:1',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.images).toHaveLength(1);
    expect([...result.images[0].buffer]).toEqual([...pngBytes]);
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      'https://media.example.test/openai-output.png',
      { method: 'GET' },
      70_000,
      expect.any(Function),
      expect.objectContaining({
        auditContext: 'MatchaClaw image result',
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        size: '1:1',
      }),
    }));
  });

  it('classifies OpenAI-compatible async task responses as unsupported protocol output', async () => {
    const provider = await loadImageProvider();

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: 'task-1',
          object: 'generation.task',
          status: 'queued',
        }),
      },
      release: vi.fn(),
    });

    await expect(provider.generateImage({
      model: 'custom-592a8424/gpt-image-1',
      prompt: 'red apple',
      cfg: makeConfig('openai', 'gpt-image-1'),
    })).rejects.toMatchObject({
      name: 'FailoverError',
      reason: 'format',
      code: 'matchaclaw_media_protocol',
    });
  });

  it('rejects models that are not configured for image generation', async () => {
    const provider = await loadImageProvider();

    await expect(provider.generateImage({
      model: 'custom-592a8424/text-only-model',
      prompt: 'red apple',
      cfg: {
        plugins: {
          entries: {
            'matchaclaw-media': {
              config: {
                providers: {
                  'custom-592a8424': {
                    baseUrl: 'https://api.example.test/v1beta',
                    apiProtocol: 'openai',
                    models: [{ id: 'text-only-model', capabilities: ['chat'] }],
                  },
                },
              },
            },
          },
        },
      },
    })).rejects.toMatchObject({
      name: 'FailoverError',
      reason: 'model_not_found',
      status: 404,
    });
  });

  it('turns OpenRouter-compatible image URLs into generated image assets', async () => {
    const provider = await loadImageProvider();

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [{
            message: {
              images: [{
                image_url: {
                  url: 'https://media.example.test/openrouter-output.png',
                },
              }],
            },
          }],
        }),
      },
      release: vi.fn(),
    });

    const { bytes: pngBytes } = mockRemoteImageDownload();

    const result = await provider.generateImage({
      model: 'custom-592a8424/openrouter-image',
      prompt: 'red apple',
      timeoutMs: 80_000,
      cfg: makeConfig('openrouter', 'openrouter-image'),
    });

    expect(result.images).toHaveLength(1);
    expect([...result.images[0].buffer]).toEqual([...pngBytes]);
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      'https://media.example.test/openrouter-output.png',
      { method: 'GET' },
      80_000,
      expect.any(Function),
      expect.objectContaining({
        auditContext: 'MatchaClaw image result',
      }),
    );
  });

  it('does not reuse direct provider dispatcher policy for returned image URLs', async () => {
    const provider = await loadImageProvider();
    const directDispatcherPolicy = { mode: 'direct', connect: { servername: 'api.example.test' } };
    resolveProviderHttpRequestConfigMock.mockImplementation((input) => ({
      baseUrl: input.baseUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      dispatcherPolicy: directDispatcherPolicy,
    }));

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: '![Generated Image](https://media.example.test/output.png)',
              }],
            },
          }],
        }),
      },
      release: vi.fn(),
    });

    mockRemoteImageDownload();

    await provider.generateImage({
      model: 'custom-592a8424/gemini-2.5-flash-image',
      prompt: 'red apple',
      cfg: {
        plugins: {
          entries: {
            'matchaclaw-media': {
              config: {
                providers: {
                  'custom-592a8424': {
                    baseUrl: 'https://api.example.test/v1beta',
                    apiProtocol: 'google',
                    models: [{ id: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'] }],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      dispatcherPolicy: directDispatcherPolicy,
    }));
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      'https://media.example.test/output.png',
      expect.any(Object),
      expect.any(Number),
      expect.any(Function),
      expect.not.objectContaining({
        dispatcherPolicy: directDispatcherPolicy,
      }),
    );
  });

  it('includes nested fetch cause details when returned image URL download fails', async () => {
    const provider = await loadImageProvider();

    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: '![Generated Image](https://media.example.test/output.png)',
              }],
            },
          }],
        }),
      },
      release: vi.fn(),
    });

    fetchWithTimeoutGuardedMock.mockRejectedValue(new TypeError('fetch failed', {
      cause: new Error('certificate has expired'),
    }));

    await expect(provider.generateImage({
      model: 'custom-592a8424/gemini-2.5-flash-image',
      prompt: 'red apple',
      cfg: {
        plugins: {
          entries: {
            'matchaclaw-media': {
              config: {
                providers: {
                  'custom-592a8424': {
                    baseUrl: 'https://api.example.test/v1beta',
                    apiProtocol: 'google',
                    models: [{ id: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'] }],
                  },
                },
              },
            },
          },
        },
      },
    })).rejects.toThrow('MatchaClaw image URL fetch failed for https://media.example.test/output.png after 3 attempts: fetch failed | caused by Error: certificate has expired');
  });
});
