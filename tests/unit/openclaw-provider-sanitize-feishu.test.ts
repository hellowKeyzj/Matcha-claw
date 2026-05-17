import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readOpenClawJsonMock,
  readAuthProfilesMock,
  discoverAgentIdsMock,
  writeAuthProfilesMock,
  writeOpenClawJsonMock,
  fileExistsMock,
} = vi.hoisted(() => ({
  readOpenClawJsonMock: vi.fn(),
  readAuthProfilesMock: vi.fn(async () => ({ version: 1, profiles: {} })),
  discoverAgentIdsMock: vi.fn(async () => ['main']),
  writeAuthProfilesMock: vi.fn(async () => {}),
  writeOpenClawJsonMock: vi.fn(),
  fileExistsMock: vi.fn(async () => false),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-config-mutex', () => ({
  withOpenClawConfigLock: async (handler: () => Promise<unknown>) => await handler(),
}));

vi.mock('../../runtime-host/application/providers/provider-registry', () => ({
  getProviderEnvVar: vi.fn(() => undefined),
  getProviderDefaultModel: vi.fn(() => undefined),
  getProviderConfig: vi.fn(() => undefined),
}));

vi.mock('../../runtime-host/application/providers/provider-runtime-rules', () => ({
  OPENCLAW_PROVIDER_KEY_MINIMAX: 'minimax-portal',
  OPENCLAW_PROVIDER_KEY_MOONSHOT: 'moonshot',
  OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL: 'moonshot-global',
  isOpenClawOAuthPluginProviderKey: vi.fn((provider: string) => (
    provider === 'minimax-portal' || provider === 'qwen-portal'
  )),
}));

import { OpenClawProviderConfigService } from '../../runtime-host/application/openclaw/openclaw-provider-config-service';
import { OpenClawProviderSnapshotService } from '../../runtime-host/application/openclaw/openclaw-provider-snapshot';
import { sanitizeOpenClawConfig } from '../../runtime-host/application/openclaw/openclaw-config-sanitizer';
import { OpenClawAgentModelRepository } from '../../runtime-host/application/openclaw/openclaw-agent-model-repository';
import { createTestOpenClawEnvironmentRepository } from './helpers/runtime-system-environment';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import {
  syncBrowserConfigToOpenClaw,
  syncGatewayTokenToConfig,
  syncSessionIdleMinutesToOpenClaw,
} from '../../runtime-host/application/openclaw/openclaw-runtime-config-sync';
import { createTestRuntimeLogger } from './helpers/runtime-logger';

const testLogger = createTestRuntimeLogger('openclaw-provider-sanitize-test');

function createMockConfigRepository() {
  return {
    read: async () => await readOpenClawJsonMock(),
    write: async (config: Record<string, unknown>) => await writeOpenClawJsonMock(config),
    update: async <T>(mutate: (config: Record<string, unknown>) => Promise<T> | T) => await mutate(await readOpenClawJsonMock()),
    getConfigDir: () => '/mock',
    getConfigFilePath: () => '/mock/openclaw.json',
    getOpenClawDirPath: () => String(process.env.MATCHACLAW_OPENCLAW_DIR || '/mock/openclaw'),
  };
}

const mockConfigRepository = createMockConfigRepository();
const mockFileSystem = createTestRuntimeFileSystem();
const mockAuthRepository = {
  discoverAgentIds: async () => await discoverAgentIdsMock(),
  readAuthProfiles: async (agentId = 'main') => await readAuthProfilesMock(agentId),
  writeAuthProfiles: async (store: Record<string, unknown>, agentId = 'main') => await writeAuthProfilesMock(store, agentId),
};
const mockOAuthPlugins = {
  discoverBundledPlugins: async () => {
    const { OpenClawOAuthPluginRegistrationService } = await import('../../runtime-host/application/openclaw/openclaw-oauth-plugin-registration');
    return await new OpenClawOAuthPluginRegistrationService(mockConfigRepository, mockFileSystem, testLogger).discoverBundledPlugins();
  },
  ensureOAuthPluginEnabled: async (config: Record<string, unknown>, provider: string) => {
    const { OpenClawOAuthPluginRegistrationService } = await import('../../runtime-host/application/openclaw/openclaw-oauth-plugin-registration');
    return await new OpenClawOAuthPluginRegistrationService(mockConfigRepository, mockFileSystem, testLogger).ensureOAuthPluginEnabled(config, provider);
  },
  removeOAuthPluginRegistrations: async (config: Record<string, unknown>, provider: string) => {
    const { OpenClawOAuthPluginRegistrationService } = await import('../../runtime-host/application/openclaw/openclaw-oauth-plugin-registration');
    return await new OpenClawOAuthPluginRegistrationService(mockConfigRepository, mockFileSystem, testLogger).removeOAuthPluginRegistrations(config, provider);
  },
};

function createProviderConfigService() {
  const environmentRepository = createTestOpenClawEnvironmentRepository();
  return new OpenClawProviderConfigService(
    mockConfigRepository,
    mockAuthRepository,
    mockOAuthPlugins,
    new OpenClawAgentModelRepository(mockConfigRepository, mockFileSystem),
    testLogger,
  );
}

function createProviderSnapshotService() {
  return new OpenClawProviderSnapshotService(mockConfigRepository, mockAuthRepository, testLogger);
}

async function sanitizeMockConfig() {
  const environmentRepository = createTestOpenClawEnvironmentRepository();
  environmentRepository.pathExists = async (pathname: string) => await fileExistsMock(pathname);
  await sanitizeOpenClawConfig(mockConfigRepository, mockOAuthPlugins, environmentRepository, testLogger);
}

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
  manifests: Array<{
    id: string;
    enabledByDefault?: boolean;
    providers?: string[];
    legacyPluginIds?: string[];
  }>,
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
        ...(manifest.providers ? { providers: manifest.providers } : {}),
        ...(manifest.legacyPluginIds ? { legacyPluginIds: manifest.legacyPluginIds } : {}),
      }, null, 2),
      'utf8',
    );
  }
}

describe('sanitizeOpenClawConfig feishu plugin migration', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    readAuthProfilesMock.mockReset();
    discoverAgentIdsMock.mockReset();
    writeAuthProfilesMock.mockReset();
    writeOpenClawJsonMock.mockReset();
    fileExistsMock.mockReset();
    fileExistsMock.mockResolvedValue(true);
    discoverAgentIdsMock.mockResolvedValue(['main']);
    readAuthProfilesMock.mockResolvedValue({ version: 1, profiles: {} });
    readOpenClawJsonMock.mockResolvedValue(createSanitizeNeutralConfig());
  });

  it('会把 feishu-openclaw-plugin 迁移为 openclaw-lark 并禁用冲突的 entries.feishu', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['feishu', 'feishu-openclaw-plugin'],
        entries: {
          'feishu-openclaw-plugin': { enabled: true, foo: 'bar' },
          feishu: { enabled: true },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('openclaw-lark');
    expect(nextConfig.plugins.allow).not.toContain('feishu');
    expect(nextConfig.plugins.allow).not.toContain('feishu-openclaw-plugin');
    expect(nextConfig.plugins.entries['openclaw-lark']).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries.feishu.enabled).toBe(false);
  });

  it('仅存在 entries.feishu 且未配置 openclaw-lark 时不会强制迁移到新插件 ID', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: [],
        entries: {
          feishu: { enabled: true },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.entries.feishu).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries['openclaw-lark']).toBeUndefined();
  });

  it('已配置 openclaw-lark 但缺少 entries.feishu 时也会补写 built-in feishu 禁用项', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          'openclaw-lark': { enabled: true },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.entries['openclaw-lark']).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries.feishu).toMatchObject({ enabled: false });
  });

  it('会把 wecom-openclaw-plugin 迁移为 wecom', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['wecom-openclaw-plugin'],
        entries: {
          'wecom-openclaw-plugin': { enabled: true, foo: 'bar' },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('wecom');
    expect(nextConfig.plugins.allow).not.toContain('wecom-openclaw-plugin');
    expect(nextConfig.plugins.entries.wecom).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries['wecom-openclaw-plugin']).toBeUndefined();
  });

  it('会把 legacy qqbot 插件 ID 迁移为 openclaw-qqbot', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      plugins: {
        allow: ['qqbot'],
        entries: {
          qqbot: { enabled: true, foo: 'bar' },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.allow).toContain('openclaw-qqbot');
    expect(nextConfig.plugins.allow).not.toContain('qqbot');
    expect(nextConfig.plugins.entries['openclaw-qqbot']).toMatchObject({ enabled: true, foo: 'bar' });
    expect(nextConfig.plugins.entries.qqbot).toBeUndefined();
  });

  it('会清理 legacy plugins.entries.whatsapp 并同步 built-in allowlist', async () => {
    readOpenClawJsonMock.mockResolvedValue({
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

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.entries?.whatsapp).toBeUndefined();
    expect(nextConfig.plugins.allow).toContain('dingtalk');
    expect(nextConfig.plugins.allow).toContain('telegram');
    expect(nextConfig.plugins.allow).not.toContain('whatsapp');
  });

  it('会移除 dingtalk strict-schema 不兼容的 accounts/defaultAccount', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      channels: {
        dingtalk: {
          enabled: true,
          clientId: 'ding-client-id',
          accounts: {
            default: {
              clientId: 'legacy-client-id',
            },
          },
          defaultAccount: 'default',
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.channels.dingtalk.clientId).toBe('ding-client-id');
    expect(nextConfig.channels.dingtalk.accounts).toBeUndefined();
    expect(nextConfig.channels.dingtalk.defaultAccount).toBeUndefined();
  });

  it('会把 Feishu accounts.default 迁移到 openclaw-lark 实际读取的顶层配置', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      ...createSanitizeNeutralConfig(),
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: {
              appId: 'cli_default',
              appSecret: 'default-secret',
              name: 'Default Feishu',
              enabled: true,
            },
            backup: {
              appId: 'cli_backup',
              appSecret: 'backup-secret',
              enabled: true,
            },
          },
        },
      },
    });

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.channels.feishu).toMatchObject({
      enabled: true,
      appId: 'cli_default',
      appSecret: 'default-secret',
      name: 'Default Feishu',
    });
    expect(nextConfig.channels.feishu.accounts.default).toBeUndefined();
    expect(nextConfig.channels.feishu.accounts.backup).toMatchObject({
      appId: 'cli_backup',
      appSecret: 'backup-secret',
    });
    expect(nextConfig.channels.feishu.defaultAccount).toBeUndefined();
  });

  it('会清理 plugins.load.paths 下失效或 bundled 的绝对路径', async () => {
    const retainedAbsolutePath = 'C:\\Users\\Mr.Key\\.openclaw\\plugins\\custom';
    const localBuildPluginPath = join(process.cwd(), 'build', 'openclaw-plugins', 'task-manager');
    fileExistsMock.mockImplementation(
      async (pathname: string) => pathname.endsWith('openclaw.json') || pathname === retainedAbsolutePath,
    );
    readOpenClawJsonMock.mockResolvedValue({
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

    await sanitizeMockConfig();

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.plugins.load.paths).toEqual([
      './relative-plugin-path',
      retainedAbsolutePath,
    ]);
  });

  it('plugins.allow 非空时不会补齐 OpenClaw bundled 插件', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'openai', enabledByDefault: true },
        { id: 'diffs', enabledByDefault: false },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin'],
          entries: {
            'custom-plugin': { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('plugins.allow 非空时不会补回未激活的 enabledByDefault provider 插件', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'openai', enabledByDefault: true, providers: ['openai', 'openai-codex'] },
        { id: 'anthropic', enabledByDefault: true, providers: ['anthropic'] },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        models: {
          providers: {
            openai: {
              apiKey: 'sk-test',
            },
          },
        },
        plugins: {
          allow: ['custom-plugin'],
          entries: {
            'custom-plugin': { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('显式启用的 bundled 非默认插件不再由 sanitize 改写', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'diffs', enabledByDefault: false },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin', 'diffs'],
          entries: {
            'custom-plugin': { enabled: true },
            diffs: { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('已配置 openclaw-lark 时不会因 enabledByDefault 再把 bare feishu 补回 allowlist', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'feishu', enabledByDefault: true },
        { id: 'browser', enabledByDefault: true },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin', 'openclaw-lark'],
          entries: {
            'openclaw-lark': { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.plugins.allow).toEqual(
        expect.arrayContaining(['custom-plugin', 'openclaw-lark']),
      );
      expect(nextConfig.plugins.allow).not.toContain('browser');
      expect(nextConfig.plugins.allow).not.toContain('feishu');
      expect(nextConfig.plugins.entries.feishu).toMatchObject({ enabled: false });
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('bundled 但非 enabledByDefault 的插件不会被 sanitize 从用户 allowlist 移除', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
        { id: 'openai', enabledByDefault: true },
        { id: 'old-bundled', enabledByDefault: false },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['custom-plugin', 'unknown-plugin', 'old-bundled', 'browser'],
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('会移除未安装且未信任的禁用插件 entry，避免 Gateway 启动期 stale config warnings', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-stale-entries-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        { id: 'browser', enabledByDefault: true },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        plugins: {
          allow: ['trusted-disabled-plugin'],
          entries: {
            browser: { enabled: false },
            dingtalk: { enabled: false },
            modelstudio: { enabled: false },
            'trusted-disabled-plugin': { enabled: false },
            'active-custom-plugin': { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.plugins.entries.browser).toMatchObject({ enabled: false });
      expect(nextConfig.plugins.entries['trusted-disabled-plugin']).toMatchObject({ enabled: false });
      expect(nextConfig.plugins.entries['active-custom-plugin']).toMatchObject({ enabled: true });
      expect(nextConfig.plugins.entries.dingtalk).toBeUndefined();
      expect(nextConfig.plugins.entries.modelstudio).toBeUndefined();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('会把 MiniMax 旧 auth 插件 ID 规范化到 bundled minimax 插件', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        {
          id: 'minimax',
          enabledByDefault: true,
          providers: ['minimax', 'minimax-portal'],
          legacyPluginIds: ['minimax-portal-auth'],
        },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        ...createSanitizeNeutralConfig(),
        models: {
          providers: {
            'minimax-portal': {
              baseUrl: 'https://api.minimax.io/anthropic',
              api: 'anthropic-messages',
            },
          },
        },
        plugins: {
          allow: ['minimax-portal-auth'],
          entries: {
            'minimax-portal-auth': { enabled: true },
          },
        },
      });

      await sanitizeMockConfig();

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.plugins.entries.minimax).toMatchObject({ enabled: true });
      expect(nextConfig.plugins.entries['minimax-portal-auth']).toBeUndefined();
      expect(nextConfig.plugins.allow ?? []).not.toContain('minimax-portal-auth');
      expect(nextConfig.plugins.allow ?? []).not.toContain('minimax');
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });

  it('openclaw.json 缺失时跳过 sanitize，避免提前写入骨架配置', async () => {
    fileExistsMock.mockResolvedValue(false);

    await sanitizeMockConfig();

    expect(readOpenClawJsonMock).not.toHaveBeenCalled();
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });

  it('openclaw.json 不可解析时跳过 sanitize，避免覆盖用户损坏文件', async () => {
    readOpenClawJsonMock.mockResolvedValue(null);

    await sanitizeMockConfig();

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

    await syncSessionIdleMinutesToOpenClaw(mockConfigRepository, testLogger);

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

    await syncSessionIdleMinutesToOpenClaw(mockConfigRepository, testLogger);

    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });

  it('用户已显式配置 reset/resetByType/resetByChannel 时不写入 idleMinutes', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      session: {
        reset: { daily: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw(mockConfigRepository, testLogger);
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();

    readOpenClawJsonMock.mockResolvedValue({
      session: {
        resetByType: { main: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw(mockConfigRepository, testLogger);
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();

    readOpenClawJsonMock.mockResolvedValue({
      session: {
        resetByChannel: { telegram: '04:00' },
      },
    });
    await syncSessionIdleMinutesToOpenClaw(mockConfigRepository, testLogger);
    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });
});

describe('syncBrowserConfigToOpenClaw', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    writeOpenClawJsonMock.mockReset();
  });

  it('默认补齐 browser.enabled/defaultProfile 与私网 SSRF 放行策略', async () => {
    readOpenClawJsonMock.mockResolvedValue({});

    await syncBrowserConfigToOpenClaw(mockConfigRepository, testLogger);

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.browser).toEqual({
      enabled: true,
      defaultProfile: 'openclaw',
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  it('用户已显式配置 dangerouslyAllowPrivateNetwork 时不覆盖原值', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      browser: {
        enabled: true,
        defaultProfile: 'openclaw',
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
        },
      },
    });

    await syncBrowserConfigToOpenClaw(mockConfigRepository, testLogger);

    expect(writeOpenClawJsonMock).not.toHaveBeenCalled();
  });
});

describe('syncGatewayTokenToConfig', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    writeOpenClawJsonMock.mockReset();
  });

  it('会把 control UI allowlist 规范成同时包含 file:// 与 null', async () => {
    readOpenClawJsonMock.mockResolvedValue({
      gateway: {
        controlUi: {
          allowedOrigins: ['http://localhost:18789', 'file://'],
        },
      },
    });

    await syncGatewayTokenToConfig(mockConfigRepository, 'gateway-token', testLogger);

    expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
    const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
    expect(nextConfig.gateway.auth).toEqual({
      mode: 'token',
      token: 'gateway-token',
    });
    expect(nextConfig.gateway.controlUi.allowedOrigins).toEqual([
      'http://localhost:18789',
      'file://',
      'null',
    ]);
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

    const providers = await createProviderSnapshotService().getActiveProviders();
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

    const result = await createProviderSnapshotService().getProvidersConfig();
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

    await createProviderConfigService().removeProvider('custom-abc12345');

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

    await createProviderConfigService().removeProvider('openai');

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

  it('删除 MiniMax 时会同时清理 canonical 与 legacy OAuth 插件注册', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        {
          id: 'minimax',
          enabledByDefault: true,
          providers: ['minimax', 'minimax-portal'],
          legacyPluginIds: ['minimax-portal-auth'],
        },
      ]);
      readAuthProfilesMock.mockResolvedValue({ version: 1, profiles: {} });
      readOpenClawJsonMock.mockResolvedValue({
        models: {
          providers: {
            'minimax-portal': {
              baseUrl: 'https://api.minimax.io/anthropic',
              api: 'anthropic-messages',
            },
          },
        },
        plugins: {
          allow: ['minimax', 'minimax-portal-auth'],
          entries: {
            minimax: { enabled: true },
            'minimax-portal-auth': { enabled: true },
          },
        },
      });

      await createProviderConfigService().removeProvider('minimax-portal');

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const config = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(config.models.providers).toEqual({});
      expect(config.plugins).toBeUndefined();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });
});

describe('syncProviderConfigToOpenClaw OAuth plugin compatibility', () => {
  beforeEach(() => {
    readOpenClawJsonMock.mockReset();
    writeOpenClawJsonMock.mockReset();
  });

  it('MiniMax 会启用 bundled canonical plugin 并清理 legacy plugin id', async () => {
    const tempOpenClawDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-'));
    process.env.MATCHACLAW_OPENCLAW_DIR = tempOpenClawDir;
    try {
      await writeBundledPluginManifests(tempOpenClawDir, [
        {
          id: 'minimax',
          enabledByDefault: true,
          providers: ['minimax', 'minimax-portal'],
          legacyPluginIds: ['minimax-portal-auth'],
        },
      ]);
      readOpenClawJsonMock.mockResolvedValue({
        plugins: {
          allow: ['minimax-portal-auth'],
          entries: {
            'minimax-portal-auth': { enabled: true },
          },
        },
      });

      await createProviderConfigService().syncProviderConfig('minimax-portal', {
        baseUrl: 'https://api.minimax.io/anthropic',
        api: 'anthropic-messages',
        apiKeyEnv: 'minimax-oauth',
        authHeader: true,
      });

      expect(writeOpenClawJsonMock).toHaveBeenCalledTimes(1);
      const nextConfig = writeOpenClawJsonMock.mock.calls[0][0] as Record<string, any>;
      expect(nextConfig.models.providers['minimax-portal']).toMatchObject({
        baseUrl: 'https://api.minimax.io/anthropic',
        api: 'anthropic-messages',
        apiKey: 'minimax-oauth',
        authHeader: true,
      });
      expect(nextConfig.plugins.allow ?? []).not.toContain('minimax');
      expect(nextConfig.plugins.allow ?? []).not.toContain('minimax-portal-auth');
      expect(nextConfig.plugins.entries.minimax).toMatchObject({ enabled: true });
      expect(nextConfig.plugins.entries['minimax-portal-auth']).toBeUndefined();
    } finally {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
      await rm(tempOpenClawDir, { recursive: true, force: true });
    }
  });
});
