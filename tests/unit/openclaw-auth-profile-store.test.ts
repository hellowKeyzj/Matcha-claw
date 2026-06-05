import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenClawAuthProfileService,
} from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-profile-store';
import { OpenClawAuthProfileWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow';
import { createTestRuntimeLogger } from './helpers/runtime-logger';

type AuthStoreShape = {
  version: number;
  profiles: Record<string, any>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
};

function cloneStore(store: AuthStoreShape): AuthStoreShape {
  return JSON.parse(JSON.stringify(store)) as AuthStoreShape;
}

function createAuthProfileService(stores: Map<string, AuthStoreShape>, writeAuthProfilesMock: ReturnType<typeof vi.fn>) {
  return new OpenClawAuthProfileService(new OpenClawAuthProfileWorkflow({
    repository: {
      discoverAgentIds: async () => ['main'],
      readAuthProfiles: async (agentId = 'main') => cloneStore(stores.get(agentId) ?? { version: 1, profiles: {} }),
      writeAuthProfiles: async (store: AuthStoreShape, agentId = 'main') => {
        writeAuthProfilesMock(store, agentId);
        stores.set(agentId, cloneStore(store));
      },
    },
    logger: createTestRuntimeLogger('openclaw-auth-profile-store-test'),
  }));
}

describe('removeProviderKeyFromOpenClaw', () => {
  const stores = new Map<string, AuthStoreShape>();
  const writeAuthProfilesMock = vi.fn();
  let service: OpenClawAuthProfileService;

  beforeEach(() => {
    stores.clear();
    writeAuthProfilesMock.mockReset();
    service = createAuthProfileService(stores, writeAuthProfilesMock);
  });

  it('仅删除 default 的 api_key profile，并清理 order/lastGood 引用', async () => {
    stores.set('main', {
      version: 1,
      profiles: {
        'custom-abc12345:default': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-main' },
        'custom-abc12345:backup': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-backup' },
      },
      order: {
        'custom-abc12345': ['custom-abc12345:default', 'custom-abc12345:backup'],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:default',
      },
    });

    await service.removeProviderKey('custom-abc12345', 'main');

    expect(stores.get('main')).toEqual({
      version: 1,
      profiles: {
        'custom-abc12345:backup': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-backup' },
      },
      order: {
        'custom-abc12345': ['custom-abc12345:backup'],
      },
      lastGood: {},
    });
  });

  it('default profile 丢失时也会清理 order/lastGood 的脏引用', async () => {
    stores.set('main', {
      version: 1,
      profiles: {
        'custom-abc12345:backup': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-backup' },
      },
      order: {
        'custom-abc12345': ['custom-abc12345:default', 'custom-abc12345:backup'],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:default',
      },
    });

    await service.removeProviderKey('custom-abc12345', 'main');

    expect(stores.get('main')).toEqual({
      version: 1,
      profiles: {
        'custom-abc12345:backup': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-backup' },
      },
      order: {
        'custom-abc12345': ['custom-abc12345:backup'],
      },
      lastGood: {},
    });
  });

  it('删除 api key 时不会误删 oauth default profile', async () => {
    stores.set('main', {
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'acc',
          refresh: 'ref',
          expires: 1,
        },
      },
      order: {
        'openai-codex': ['openai-codex:default'],
      },
      lastGood: {
        'openai-codex': 'openai-codex:default',
      },
    });

    await service.removeProviderKey('openai-codex', 'main');

    expect(stores.get('main')).toEqual({
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'acc',
          refresh: 'ref',
          expires: 1,
        },
      },
      order: {
        'openai-codex': ['openai-codex:default'],
      },
      lastGood: {
        'openai-codex': 'openai-codex:default',
      },
    });
  });
});

describe('saveProviderKeyToOpenClaw', () => {
  const stores = new Map<string, AuthStoreShape>();
  const writeAuthProfilesMock = vi.fn();
  let service: OpenClawAuthProfileService;

  beforeEach(() => {
    stores.clear();
    writeAuthProfilesMock.mockReset();
    service = createAuthProfileService(stores, writeAuthProfilesMock);
  });

  it('OAuth provider 且 apiKey 为空时跳过写入', async () => {
    stores.set('main', {
      version: 1,
      profiles: {},
      order: {},
      lastGood: {},
    });

    await service.saveProviderKey('minimax-portal', '', 'main');

    expect(writeAuthProfilesMock).not.toHaveBeenCalled();
    expect(stores.get('main')).toEqual({
      version: 1,
      profiles: {},
      order: {},
      lastGood: {},
    });
  });
});
