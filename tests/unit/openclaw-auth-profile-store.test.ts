import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  discoverAgentIdsMock,
  readAuthProfilesMock,
  writeAuthProfilesMock,
} = vi.hoisted(() => ({
  discoverAgentIdsMock: vi.fn(async () => ['main']),
  readAuthProfilesMock: vi.fn(),
  writeAuthProfilesMock: vi.fn(async () => {}),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-auth-store', () => ({
  discoverAgentIds: discoverAgentIdsMock,
  readAuthProfiles: readAuthProfilesMock,
  writeAuthProfiles: writeAuthProfilesMock,
}));

import {
  removeProviderKeyFromOpenClaw,
  saveProviderKeyToOpenClaw,
} from '../../runtime-host/application/openclaw/openclaw-auth-profile-store';

type AuthStoreShape = {
  version: number;
  profiles: Record<string, any>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
};

function cloneStore(store: AuthStoreShape): AuthStoreShape {
  return JSON.parse(JSON.stringify(store)) as AuthStoreShape;
}

describe('removeProviderKeyFromOpenClaw', () => {
  const stores = new Map<string, AuthStoreShape>();

  beforeEach(() => {
    stores.clear();
    discoverAgentIdsMock.mockReset();
    readAuthProfilesMock.mockReset();
    writeAuthProfilesMock.mockReset();
    discoverAgentIdsMock.mockResolvedValue(['main']);
    readAuthProfilesMock.mockImplementation(async (agentId = 'main') => {
      return cloneStore(stores.get(agentId) ?? { version: 1, profiles: {} });
    });
    writeAuthProfilesMock.mockImplementation(async (store: AuthStoreShape, agentId = 'main') => {
      stores.set(agentId, cloneStore(store));
    });
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

    await removeProviderKeyFromOpenClaw('custom-abc12345', 'main');

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

    await removeProviderKeyFromOpenClaw('custom-abc12345', 'main');

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

    await removeProviderKeyFromOpenClaw('openai-codex', 'main');

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

  beforeEach(() => {
    stores.clear();
    discoverAgentIdsMock.mockReset();
    readAuthProfilesMock.mockReset();
    writeAuthProfilesMock.mockReset();
    discoverAgentIdsMock.mockResolvedValue(['main']);
    readAuthProfilesMock.mockImplementation(async (agentId = 'main') => {
      return cloneStore(stores.get(agentId) ?? { version: 1, profiles: {} });
    });
    writeAuthProfilesMock.mockImplementation(async (store: AuthStoreShape, agentId = 'main') => {
      stores.set(agentId, cloneStore(store));
    });
  });

  it('OAuth provider 且 apiKey 为空时跳过写入', async () => {
    stores.set('main', {
      version: 1,
      profiles: {},
      order: {},
      lastGood: {},
    });

    await saveProviderKeyToOpenClaw('minimax-portal', '', 'main');

    expect(writeAuthProfilesMock).not.toHaveBeenCalled();
    expect(stores.get('main')).toEqual({
      version: 1,
      profiles: {},
      order: {},
      lastGood: {},
    });
  });
});
