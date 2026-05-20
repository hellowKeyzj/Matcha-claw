import { describe, expect, it, vi } from 'vitest';
import { CapabilityRoutingApplicationService } from '../../runtime-host/application/providers/capability-routing-service';

describe('CapabilityRoutingApplicationService', () => {
  it('imports existing OpenClaw routing refs into credential-scoped routing', async () => {
    const writeStore = vi.fn(async () => {});
    const service = new CapabilityRoutingApplicationService(
      {
        read: async () => ({ schemaVersion: 1, routing: {} }),
        write: writeStore,
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
              label: '自定义',
            },
            'ark-main': {
              id: 'ark-main',
              vendorId: 'ark',
              label: 'Ark',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      {
        read: vi.fn(async () => ({
          chat: {
            primary: { providerKey: 'custom-dd749b2e', modelId: 'gpt-5.4' },
            fallbacks: [{ providerKey: 'ark', modelId: 'ark-code-latest' }],
          },
          tts: { providerKey: 'openai' },
        })),
        replace: vi.fn(async () => {}),
      } as any,
    );

    await expect(service.read()).resolves.toEqual({
      chat: {
        primary: {
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          modelId: 'gpt-5.4',
        },
        fallbacks: [{ credentialId: 'ark-main', modelId: 'ark-code-latest' }],
      },
    });
    expect(writeStore).toHaveBeenCalledWith({
      schemaVersion: 1,
      routing: {
        chat: {
          primary: {
            credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
            modelId: 'gpt-5.4',
          },
          fallbacks: [{ credentialId: 'ark-main', modelId: 'ark-code-latest' }],
        },
      },
    });
  });

  it('writes credential-scoped routing as OpenClaw provider refs', async () => {
    const writer = {
      read: vi.fn(async () => ({})),
      replace: vi.fn(async () => {}),
    };
    const service = new CapabilityRoutingApplicationService(
      {
        read: async () => ({ schemaVersion: 1, routing: {} }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
              id: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
              vendorId: 'custom',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    const result = await service.write({
      chat: {
        primary: {
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          modelId: 'gpt-5.4',
        },
        fallbacks: [],
      },
      tts: {
        primary: {
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          modelId: 'tts-1',
        },
        fallbacks: [],
      },
    });

    expect(result.status).toBe(200);
    expect(writer.replace).toHaveBeenCalledWith({
      chat: {
        primary: { providerKey: 'custom-dd749b2e', modelId: 'gpt-5.4' },
        fallbacks: [],
      },
      tts: { providerKey: 'custom-dd749b2e' },
    });
  });

  it('writes custom media credential routing using the OpenClaw contract provider id', async () => {
    const writer = {
      read: vi.fn(async () => ({})),
      replace: vi.fn(async () => {}),
    };
    const service = new CapabilityRoutingApplicationService(
      {
        read: async () => ({ schemaVersion: 1, routing: {} }),
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
              mediaApiProtocol: 'openai',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    const result = await service.write({
      imageGenerate: {
        primary: {
          credentialId: 'custom-media-openai',
          modelId: 'gpt-image-2',
        },
        fallbacks: [],
      },
    });

    expect(result.status).toBe(200);
    expect(writer.replace).toHaveBeenCalledWith({
      imageGenerate: {
        primary: { providerKey: 'matchaclaw-media', modelId: 'custom-media-openai/gpt-image-2' },
        fallbacks: [],
      },
    });
  });

  it('repairs stale OpenClaw routing projection from the MatchaClaw routing store on read', async () => {
    const writer = {
      read: vi.fn(async () => ({
        imageGenerate: {
          primary: { providerKey: 'matchaclaw-media', modelId: 'custom-old/old-image' },
          fallbacks: [],
        },
      })),
      replace: vi.fn(async () => {}),
    };
    const service = new CapabilityRoutingApplicationService(
      {
        read: async () => ({
          schemaVersion: 1,
          routing: {
            imageGenerate: {
              primary: {
                credentialId: 'custom-media-new',
                modelId: 'new-image',
              },
              fallbacks: [],
            },
          },
        }),
        write: async () => {},
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-media-new': {
              id: 'custom-media-new',
              vendorId: 'custom',
              providerKind: 'media',
              mediaApiProtocol: 'openai',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      writer as any,
    );

    await expect(service.read()).resolves.toEqual({
      imageGenerate: {
        primary: {
          credentialId: 'custom-media-new',
          modelId: 'new-image',
        },
        fallbacks: [],
      },
    });
    expect(writer.replace).toHaveBeenCalledWith({
      imageGenerate: {
        primary: { providerKey: 'matchaclaw-media', modelId: 'custom-media-new/new-image' },
        fallbacks: [],
      },
    });
  });
});
