import { describe, expect, it, vi } from 'vitest';
import { CapabilityRoutingApplicationService } from '../../runtime-host/application/providers/capability-routing-service';
import { ProviderCapabilityRoutingWorkflow } from '../../runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow';
import { getOpenClawProviderKeyForType } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules';
import type { ProviderProjectionKeyResolverPort } from '../../runtime-host/application/providers/provider-store-model';

const projectionKeys: ProviderProjectionKeyResolverPort = {
  resolveProviderKey: ({ vendorId, accountId }) => getOpenClawProviderKeyForType(vendorId, accountId),
};

function createService(
  store: ConstructorParameters<typeof ProviderCapabilityRoutingWorkflow>[0]['store'],
  credentials: ConstructorParameters<typeof ProviderCapabilityRoutingWorkflow>[0]['credentials'],
  models: ConstructorParameters<typeof ProviderCapabilityRoutingWorkflow>[0]['models'],
  writer: ConstructorParameters<typeof ProviderCapabilityRoutingWorkflow>[0]['writer'],
): CapabilityRoutingApplicationService {
  return new CapabilityRoutingApplicationService({
    routingWorkflow: new ProviderCapabilityRoutingWorkflow({
      store,
      credentials,
      models,
      writer,
      projectionKeys,
    }),
  });
}

describe('CapabilityRoutingApplicationService', () => {
  it('imports existing OpenClaw routing refs into credential-scoped routing', async () => {
    const writeStore = vi.fn(async () => {});
    const service = createService(
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
        read: async () => ({ schemaVersion: 1, models: [] }),
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
    const service = createService(
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
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      writer as any,
      projectionKeys,
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
    const service = createService(
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
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      writer as any,
      projectionKeys,
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
    const service = createService(
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
      {
        read: async () => ({
          schemaVersion: 1,
          models: [{ credentialId: 'custom-media-new', modelId: 'new-image', capabilities: ['imageGenerate'] }],
        }),
        write: async () => {},
      },
      writer as any,
      projectionKeys,
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

  it('removes routes that point to models no longer present in the catalog', async () => {
    const writeStore = vi.fn(async () => {});
    const writer = {
      read: vi.fn(async () => ({})),
      replace: vi.fn(async () => {}),
    };
    const service = createService(
      {
        read: async () => ({
          schemaVersion: 1,
          routing: {
            chat: {
              primary: { credentialId: 'custom-chat', modelId: 'gpt-5.4' },
              fallbacks: [
                { credentialId: 'custom-chat', modelId: 'removed-chat' },
                { credentialId: 'custom-chat', modelId: 'gpt-5.5' },
              ],
            },
            imageGenerate: {
              primary: { credentialId: 'custom-media', modelId: 'removed-image' },
              fallbacks: [],
            },
          },
        }),
        write: writeStore,
      },
      {
        read: async () => ({
          schemaVersion: 2,
          accounts: {
            'custom-chat': {
              id: 'custom-chat',
              vendorId: 'custom',
            },
            'custom-media': {
              id: 'custom-media',
              vendorId: 'custom',
              providerKind: 'media',
              mediaApiProtocol: 'openai',
            },
          },
          apiKeys: {},
        }),
        write: async () => {},
      },
      {
        read: async () => ({ schemaVersion: 1, models: [] }),
        write: async () => {},
      },
      writer as any,
      projectionKeys,
    );

    await service.pruneUnavailableModelRoutes([
      { credentialId: 'custom-chat', modelId: 'gpt-5.4', capabilities: ['chat'] },
      { credentialId: 'custom-chat', modelId: 'gpt-5.5', capabilities: ['chat'] },
    ]);

    expect(writeStore).toHaveBeenCalledWith({
      schemaVersion: 1,
      routing: {
        chat: {
          primary: { credentialId: 'custom-chat', modelId: 'gpt-5.4' },
          fallbacks: [
            { credentialId: 'custom-chat', modelId: 'gpt-5.5' },
          ],
        },
      },
    });
    expect(writer.replace).toHaveBeenCalledWith({
      chat: {
        primary: { providerKey: 'custom-chat', modelId: 'gpt-5.4' },
        fallbacks: [{ providerKey: 'custom-chat', modelId: 'gpt-5.5' }],
      },
    });
  });
});
