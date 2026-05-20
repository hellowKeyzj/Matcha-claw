import { describe, expect, it, vi } from 'vitest';
import { ProviderModelsApplicationService } from '../../runtime-host/application/providers/provider-models-service';

describe('ProviderModelsApplicationService', () => {
  it('hydrates an empty catalog from existing OpenClaw provider models', async () => {
    const writeModels = vi.fn(async () => {});
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: writeModels,
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-completions',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      {
        readAll: vi.fn(async () => ({
          'custom-dd749b2e': [
            {
              modelId: 'gpt-5.4',
              contextWindow: 128000,
              input: ['text', 'image'],
            },
          ],
        })),
        replaceAll: vi.fn(async () => {}),
      } as any,
    );

    const result = await service.readAll();

    expect(result.models).toEqual([
      {
        credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
        modelId: 'gpt-5.4',
        capabilities: ['chat', 'imageUnderstand'],
        contextWindow: 128000,
      },
    ]);
    expect(writeModels).toHaveBeenCalledWith({
      schemaVersion: 1,
      models: result.models,
    });
  });

  it('adapts credentialId models to OpenClaw provider entries with transport config', async () => {
    const writeModels = vi.fn(async () => {});
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: writeModels,
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-completions',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      {
        replaceAll: vi.fn(async () => {}),
      } as any,
    );

    const result = await service.replace('custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a', {
      models: [
        {
          modelId: 'gpt-5.4',
          capabilities: ['chat'],
          contextWindow: 128000,
        },
      ],
    });

    expect(result.status).toBe(200);
    const writer = (service as any).writer.replaceAll as ReturnType<typeof vi.fn>;
    expect(writer).toHaveBeenCalledWith({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        replaceProviderKeys: ['custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a'],
        models: [
          {
            modelId: 'gpt-5.4',
            input: ['text'],
            contextWindow: 128000,
          },
        ],
      },
    }, ['custom-dd749b2e/gpt-5.4']);
  });

  it('marks image-understanding models as text and image input for OpenClaw', async () => {
    const writer = { readAll: vi.fn(async () => ({})), replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            ollama: {
              id: 'ollama',
              vendorId: 'ollama',
              baseUrl: 'http://localhost:11434',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    const result = await service.replace('ollama', {
      models: [
        {
          modelId: 'qwen2.5vl:7b',
          capabilities: ['chat', 'imageUnderstand'],
        },
      ],
    });

    expect(result.status).toBe(200);
    expect(writer.replaceAll).toHaveBeenCalledWith({
      ollama: {
        baseUrl: 'http://localhost:11434',
        api: 'openai-completions',
        models: [
          {
            modelId: 'qwen2.5vl:7b',
            input: ['text', 'image'],
          },
        ],
      },
    }, ['ollama/qwen2.5vl:7b']);
  });

  it('rejects media capabilities unsupported by custom text providers', async () => {
    const writer = { replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-responses',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    const result = await service.replace('custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a', {
      models: [
        {
          modelId: 'gpt-image-2',
          capabilities: ['imageGenerate'],
        },
      ],
    });

    expect(result.status).toBe(400);
    expect(writer.replaceAll).not.toHaveBeenCalled();
  });

  it('returns selectable models using OpenClaw provider refs', async () => {
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({
          schemaVersion: 1,
          models: [
            {
              credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              modelId: 'gpt-5.4',
              capabilities: ['chat'],
              contextWindow: 200000,
            },
          ],
        }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              label: '自定义',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-responses',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      {
        replaceAll: vi.fn(async () => {}),
      } as any,
    );

    await expect(service.readSelectable()).resolves.toEqual({
      models: [
        {
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerKey: 'custom-dd749b2e',
          openClawModelRef: 'custom-dd749b2e/gpt-5.4',
          label: '自定义',
          modelId: 'gpt-5.4',
          capabilities: ['chat'],
          contextWindow: 200000,
        },
      ],
    });
  });

  it('keeps an empty OpenClaw model array for custom credentials after model removal', async () => {
    const writer = { replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({
          schemaVersion: 1,
          models: [
            {
              credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              modelId: 'gpt-5.4',
              capabilities: ['chat'],
            },
          ],
        }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-completions',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    await service.replace('custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a', { models: [] });

    expect(writer.replaceAll).toHaveBeenCalledWith({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        replaceProviderKeys: ['custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a'],
        models: [],
      },
    }, []);
  });

  it('does not write model entries for credentials without OpenClaw provider transport config', async () => {
    const writer = { replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            openai: {
              id: 'openai',
              vendorId: 'openai',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    await service.replace('openai', {
      models: [
        {
          modelId: 'gpt-5.4',
          capabilities: ['chat'],
        },
      ],
    });

    expect(writer.replaceAll).toHaveBeenCalledWith({}, []);
  });

  it('writes custom media provider transport with an empty model list before models are added', async () => {
    const writer = { readAll: vi.fn(async () => ({})), replaceAll: vi.fn(async () => {}) };
    const customMediaWriter = { readAll: vi.fn(async () => ({})), replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-media-openai': {
              id: 'custom-media-openai',
              vendorId: 'custom',
              providerKind: 'media',
              label: 'image',
              baseUrl: 'http://pic2api.com/v1beta',
              mediaApiProtocol: 'google',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
      customMediaWriter as any,
    );

    await service.syncOpenClaw();

    expect(writer.replaceAll).toHaveBeenCalledWith({}, []);
    expect(customMediaWriter.replaceAll).toHaveBeenCalledWith({
      'custom-media-openai': {
        label: 'image',
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [],
      },
    });
  });

  it('adds custom media models without requiring a chat provider override', async () => {
    const writer = { replaceAll: vi.fn(async () => {}) };
    const customMediaWriter = { replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-media-openai': {
              id: 'custom-media-openai',
              vendorId: 'custom',
              providerKind: 'media',
              label: 'image',
              baseUrl: 'http://pic2api.com/v1beta',
              mediaApiProtocol: 'google',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
      customMediaWriter as any,
    );

    const result = await service.replace('custom-media-openai', {
      models: [
        {
          modelId: 'gemini-2.5-flash-image',
          capabilities: ['imageGenerate'],
          contextWindow: 128000,
          maxTokens: 8192,
          timeoutMs: 90_000,
          aspectRatio: '16:9',
          resolution: '2K',
          quality: 'high',
        },
      ],
    });

    expect(result.status).toBe(200);
    expect(writer.replaceAll).toHaveBeenCalledWith({}, ['matchaclaw-media/custom-media-openai/gemini-2.5-flash-image']);
    expect(customMediaWriter.replaceAll).toHaveBeenCalledWith({
      'custom-media-openai': {
        label: 'image',
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [
          {
            modelId: 'gemini-2.5-flash-image',
            capabilities: ['imageGenerate'],
            timeoutMs: 90_000,
            aspectRatio: '16:9',
            resolution: '2K',
            quality: 'high',
          },
        ],
      },
    });
  });

  it('syncs the existing catalog to OpenClaw with current valid model refs', async () => {
    const writer = { replaceAll: vi.fn(async () => {}) };
    const service = new ProviderModelsApplicationService(
      {
        read: async () => ({
          schemaVersion: 1,
          models: [
            {
              credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              modelId: 'gpt-5.4',
              capabilities: ['chat'],
            },
          ],
        }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              baseUrl: 'https://api.example.com/v1',
              apiProtocol: 'openai-completions',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    await service.syncOpenClaw();

    expect(writer.replaceAll).toHaveBeenCalledWith({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        replaceProviderKeys: ['custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a'],
        models: [
          {
            modelId: 'gpt-5.4',
            input: ['text'],
          },
        ],
      },
    }, ['custom-dd749b2e/gpt-5.4']);
  });
});
