import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readOpenClawJsonMock,
  readJsonFileMock,
  readAuthProfilesMock,
  discoverAgentIdsMock,
  writeAuthProfilesMock,
  writeOpenClawJsonMock,
  fileExistsMock,
} = vi.hoisted(() => ({
  readOpenClawJsonMock: vi.fn(),
  readJsonFileMock: vi.fn(),
  readAuthProfilesMock: vi.fn(async () => ({ version: 1, profiles: {} })),
  discoverAgentIdsMock: vi.fn(async () => ['main']),
  writeAuthProfilesMock: vi.fn(async () => {}),
  writeOpenClawJsonMock: vi.fn(),
  fileExistsMock: vi.fn(async () => false),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-config-mutex', () => ({
  withOpenClawConfigLock: async (handler: () => Promise<unknown>) => await handler(),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-auth-store', () => ({
  discoverAgentIds: discoverAgentIdsMock,
  fileExists: fileExistsMock,
  OPENCLAW_CONFIG_PATH: '/mock/openclaw.json',
  readJsonFile: readJsonFileMock,
  readAuthProfiles: readAuthProfilesMock,
  writeAuthProfiles: writeAuthProfilesMock,
  readOpenClawJson: readOpenClawJsonMock,
  writeOpenClawJson: writeOpenClawJsonMock,
}));

vi.mock('../../runtime-host/application/providers/provider-registry', () => ({
  getProviderEnvVar: vi.fn(() => undefined),
  getProviderDefaultModel: vi.fn(() => undefined),
  getProviderConfig: vi.fn(() => undefined),
}));

vi.mock('../../runtime-host/application/providers/provider-runtime-rules', () => ({
  OPENCLAW_PROVIDER_KEY_MOONSHOT: 'moonshot',
  isOpenClawOAuthPluginProviderKey: vi.fn(() => false),
}));

import {
  getActiveOpenClawProviders,
  getOpenClawProvidersConfig,
  removeProviderFromOpenClaw,
  sanitizeOpenClawConfig,
  syncSessionIdleMinutesToOpenClaw,
} from '../../runtime-host/application/openclaw/openclaw-provider-config-service';

function createSanitizeNeutralConfig(): Record<string, unknown> {
  return {
    commands: {
      restart: true,
    },
    tools: {
      profile: 'full',
      sessions: {
        visibility: 'all',
      },
    },
    plugins: {
      allow: [],
      entries: {},
    },
  };
}

async function writeBundledPluginManifests(
  openclawDir: string,
  manifests: Array<{ id: string; enabledByDefault?: boolean }>,
): Promise<void> {
  const extensionsDir = join(openclawDir, 'dist', 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  for (const manifest of manifests) {
    const pluginDir = join(extensionsDir, manifest.id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: manifest.id,
        ...(manifest.enabledByDefault !== undefined ? { enabledByDefault: manifest.enabledByDefault } : {}),
      }, null, 2),
      'utf8',
    );
  }
}

describe('sanitizeOpenClawConfig feishu plugin migration', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    readJsonFileMock.mockReset();
    readAuthProfilesMock.mockReset();
    discoverAgentIdsMock.mockReset();
    writeAuthProfilesMock.mockReset();
    writeOpenClawJsonMock.mockReset();
    fileExistsMock.mockReset();
    fileExistsMock.mockResolvedValue(true);
    discoverAgentIdsMock.mockResolvedValue(['main']);
    readAuthProfilesMock.mockResolvedValue({ version: 1, profiles: {} });
    readJsonFileMock.mockResolvedValue(createSanitizeNeutralConfig());
  });

  it('会把 feishu-openclaw-plugin 迁移为 openclaw-lark 并禁用冲突的 entries.feishu', async () => {
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['feishu', 'feishu-openclaw-plugin'],
        entries: {
          'feishu-openclaw-plugin': { enabled: true, foo: 'bar' },
          feishu: { enabled: true },
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('openclaw-lark');
    expect(nextConfig.plugins.allow).not.toContain('feishu');
    expect(nextConfig.plugins.allow).not.toContain('feishu-openclaw-plugin');
    expect(nextConfig.plugins.entries['openclaw-lark']).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries.feishu.enabled).toBe(false);
  });

  it('仅存在 entries.feishu 且未配置 openclaw-lark 时不会强制迁移到新插件 ID', async () => {
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: [],
        entries: {
          feishu: { enabled: true },
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.entries.feishu).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries['openclaw-lark']).toBeUndefined();
  });

  it('会把 wecom-openclaw-plugin 迁移为 wecom', async () => {
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['wecom-openclaw-plugin'],
        entries: {
          'wecom-openclaw-plugin': { enabled: true, foo: 'bar' },
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('wecom');
    expect(nextConfig.plugins.allow).not.toContain('wecom-openclaw-plugin');
    expect(nextConfig.plugins.entries.wecom).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries['wecom-openclaw-plugin']).toBeUndefined();
  });

  it('会把 legacy qqbot 插件 ID 迁移为 openclaw-qqbot', async () => {
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['qqbot'],
        entries: {
          qqbot: { enabled: true, foo: 'bar' },
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('openclaw-qqbot');
    expect(nextConfig.plugins.allow).not.toContain('qqbot');
    expect(nextConfig.plugins.entries['openclaw-qqbot']).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries.qqbot).toBeUndefined();
  });

  it('会清理 legacy plugins.entries.whatsapp 并同步 built-in allowlist', async () => {
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['dingtalk', 'whatsapp'],
        entries: {
          whatsapp: { enabled: true },
        },
      },
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              botToken: 'token-1',
            },
          },
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.entries?.whatsapp).toBeUndefined();
    expect(nextConfig.plugins.allow).toContain('dingtalk');
    expect(nextConfig.plugins.allow).toContain('telegram');
    expect(nextConfig.plugins.allow).not.toContain('whatsapp');
  });

  it('会清理 plugins.load.paths 下失效或 bundled 的绝对路径', async () => {
    const retainedAbsolutePath = 'C:\\Users\\Mr.Key\\.openclaw\\plugins\\custom';
    const localBuildPluginPath = join(process.cwd(), 'build', 'openclaw-plugins', 'task-manager');
    fileExistsMock.mockImplementation(
      async (pathname: string) => pathname === '/mock/openclaw.json' || pathname === retainedAbsolutePath,
    );
    readJsonFileMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: [],
        entries: {},
        load: {
          paths: [
            'C:\\Users\\Mr.Key\\node_modules\\openclaw\\extensions\\wecom',
            'C:\\Users\\Mr.Key\\.openclaw\\plugins\\missing',
            './relative-plugin-path',
            localBuildPluginPath,
            retainedAbsolutePath,
          ],
        },
      },
    });

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.load.paths).toEqual([
      './relative-plugin-path',
      retainedAbsolutePath,
    ]);
  });

  it('plugins.allow 非空时会补齐 enabledByDefault 的 bundled 插件', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'openai', enabledByDefault: true },
        { id: 'diffs', enabledByDefault: false },
      ]);
      readJsonFileMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin'],
          entries: {
            'custom-plugin': { enabled: true },
          },
        },
      });

      await sanitizeOpenClawConfig();

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.plugins.allow).toEqual(
        expect.arrayContaining(['custom-plugin', 'browser', 'openai']),
      );
      expect(nextConfig.plugins.allow).not.toContain('diffs');
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('bundled 但非 enabledByDefault 的插件会从 allowlist 移除', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'openai', enabledByDefault: true },
        { id: 'old-bundled', enabledByDefault: false },
      ]);
      readJsonFileMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin', 'unknown-plugin', 'old-bundled', 'browser'],
        },
      });

      await sanitizeOpenClawConfig();

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.plugins.allow).toEqual(
        expect.arrayContaining(['custom-plugin', 'unknown-plugin', 'browser', 'openai']),
      );
      expect(nextConfig.plugins.allow).not.toContain('old-bundled');
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('openclaw.json 缺失时跳过 sanitize，避免提前写入骨架配置', async () => {
    fileExistsMock.mockResolvedValue(false);

    await sanitizeOpenClawConfig();

    expect(readJsonFileMock).not.toHaveBeenCalled();
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });

  it('openclaw.json 不可解析时跳过 sanitize，避免覆盖用户损坏文件', async () => {
    readJsonFileMock.mockResolvedValue(null);

    await sanitizeOpenClawConfig();

    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });
});

describe('syncSessionIdleMinutesToOpenClaw', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    writeOpenClawJsonMock.mockReset();
  });

  it('默认会写入 7 天 idleMinutes', async () => {
    readOpenClawJsonMock.mockResolvedValue({});

    await syncSessionIdleMinutesToOpenClaw();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.session).toEqual({ idleMinutes: 10080 });
  });

  it('用户已配置 idleMinutes 时不覆盖', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      session: {
        idleMinutes: 60,
      },
    });

    await syncSessionIdleMinutesToOpenClaw();

    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });

  it('用户已显式配置 reset/resetByType/resetByChannel 时不写入 idleMinutes', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      session: {
        reset: { daily: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw();
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();

    readOpenClawJsonMock.mockResolvedValue({
      session: {
        resetByType: { main: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw();
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();

    readOpenClawJsonMock.mockResolvedValue({
      session: {
        resetByChannel: { telegram: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw();
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });
});

describe('provider discovery from auth profiles', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    discoverAgentIdsMock.mockReset();
    readAuthProfilesMock.mockReset();
    discoverAgentIdsMock.mockResolvedValue(['main']);
    readAuthProfilesMock.mockResolvedValue({ version: 1, profiles: {} });
  });

  it('getActiveOpenClawProviders 会合并 openclaw.json 和 agent auth-profiles', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      auth: {
        profiles: {
          'openai-codex:default': { provider: 'openai-codex', type: 'oauth' },
          'anthropic:default': { provider: 'anthropic', type: 'api_key' },
        },
      },
    });
    discoverAgentIdsMock.mockResolvedValue(['main', 'work']);
    readAuthProfilesMock.mockImplementation(async (agentId: string) => {
      if (agentId === 'work') {
        return {
          version: 1,
          profiles: {
            'google-gemini-cli:default': { provider: 'google-gemini-cli', type: 'oauth' },
          },
        };
      }
      return { version: 1, profiles: {} };
    });

    const providers = await getActiveOpenClawProviders();
    expect(providers).toEqual(new Set(['openai', 'anthropic', 'google']));
  });

  it('getOpenClawProvidersConfig 会为仅存在于 auth profiles 的 provider 补配置壳', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-5.4',
          },
        },
      },
      auth: {
        profiles: {
          'openai-codex:default': { provider: 'openai-codex', type: 'oauth' },
        },
      },
      models: {
        providers: {},
      },
    });
    discoverAgentIdsMock.mockResolvedValue(['main', 'work']);
    readAuthProfilesMock.mockImplementation(async (agentId: string) => {
      if (agentId === 'work') {
        return {
          version: 1,
          profiles: {
            'anthropic:default': { provider: 'anthropic', type: 'api_key' },
          },
        };
      }
      return { version: 1, profiles: {} };
    });

    const result = await getOpenClawProvidersConfig();
    expect(result.defaultModel).toBe('openai/gpt-5.4');
    expect(result.providers).toMatchObject({
      openai: {},
      anthropic: {},
    });
  });
});

describe('removeProviderFromOpenClaw', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    writeOpenClawJsonMock.mockReset();
    discoverAgentIdsMock.mockReset();
    readAuthProfilesMock.mockReset();
    writeAuthProfilesMock.mockReset();
    fileExistsMock.mockReset();
    discoverAgentIdsMock.mockResolvedValue(['main']);
    fileExistsMock.mockResolvedValue(false);
  });

  it('删除 provider 时会清理 auth-profiles 与 openclaw.json 残留', async () => {
    readAuthProfilesMock.mockResolvedValue({
      version: 1,
      profiles: {
        'custom-abc12345:default': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-main' },
        'custom-abc12345:backup': { type: 'api_key', provider: 'custom-abc12345', key: 'sk-backup' },
      },
      order: {
        'custom-abc12345': ['custom-abc12345:default', 'custom-abc12345:backup'],
      },
      lastGood: {
        'custom-abc12345': 'custom-abc12345:backup',
      },
    });
    readOpenClawJsonMock.mockResolvedValue({
      models: {
        providers: {
          'custom-abc12345': {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
          },
        },
      },
      auth: {
        profiles: {
          'custom-abc12345:oauth': { type: 'oauth', provider: 'custom-abc12345' },
          'custom-abc12345:secondary': { type: 'api_key', provider: 'custom-abc12345' },
        },
      },
    });

    await removeProviderFromOpenClaw('custom-abc12345');

    expect(writeAuthProfilesMock).toHaveBeenCalledTimes(1);
    expect(writeAuthProfilesMock.mock.calls[0][0]).toMatchObject({
      profiles: {},
      order: {},
      lastGood: {},
    });
    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const config = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(config.models.providers).toEqual({});
    expect(config.auth.profiles).toEqual({});
  });

  it('删除 openai 时会同时清理映射到 openai 的 openai-codex auth profile', async () => {
    readAuthProfilesMock.mockResolvedValue({
      version: 1,
      profiles: {
        'openai-codex:default': { type: 'oauth', provider: 'openai-codex' },
        'openai-codex:backup': { type: 'oauth', provider: 'openai-codex' },
      },
      order: {
        'openai-codex': ['openai-codex:default', 'openai-codex:backup'],
      },
      lastGood: {
        'openai-codex': 'openai-codex:default',
      },
    });
    readOpenClawJsonMock.mockResolvedValue({
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
          },
        },
      },
      auth: {
        profiles: {
          'openai-codex:default': { type: 'oauth', provider: 'openai-codex' },
          'openai:legacy': { type: 'api_key', provider: 'openai' },
        },
      },
    });

    await removeProviderFromOpenClaw('openai');

    expect(writeAuthProfilesMock).toHaveBeenCalledTimes(1);
    expect(writeAuthProfilesMock.mock.calls[0][0]).toMatchObject({
      profiles: {},
      order: {},
      lastGood: {},
    });
    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const config = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(config.models.providers).toEqual({});
    expect(config.auth.profiles).toEqual({});
  });
});
