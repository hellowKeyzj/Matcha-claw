import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PROVIDER_TYPES,
  PROVIDER_TYPES,
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  normalizeProviderApiKeyInput,
} from '@/lib/providers';
import { hostApiFetch } from '@/lib/host-api';
import { buildProviderCredentialId, buildProviderListItems, fetchProviderSnapshot } from '@/lib/provider-accounts';

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

describe('provider metadata', () => {
  beforeEach(() => {
    vi.mocked(hostApiFetch).mockReset();
  });

  it('keeps provider metadata about vendors and auth only', () => {
    const siliconflow = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'siliconflow');
    const deepseek = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'deepseek');
    const openrouter = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'openrouter');
    const ark = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'ark');
    expect(siliconflow).toBeDefined();
    expect(deepseek).toMatchObject({
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    });
    expect(openrouter?.docsUrl).toBe('https://openrouter.ai/models');
    expect(ark?.docsUrl).toBe('https://www.volcengine.com/');
  });

  it('resolves provider docs url by locale', () => {
    const anthropic = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'anthropic');
    const custom = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'custom');
    const qwen = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'qwen-portal');

    expect(getProviderDocsUrl(anthropic, 'en')).toBe('https://platform.claude.com/docs/en/api/overview');
    expect(getProviderDocsUrl(custom, 'zh-CN')).toBe(
      'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#IWQCdfe5fobGU3xf3UGcgbLynGh',
    );
    expect(getProviderDocsUrl(custom, 'en')).toBe(
      'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#Ee1ldfvKJoVGvfxc32mcILwenth',
    );
    expect(getProviderDocsUrl(qwen, 'en')).toBeUndefined();
  });

  it('buildProviderListItems handles invalid snapshot arrays safely', () => {
    const items = buildProviderListItems(
      undefined as unknown as never[],
      undefined as unknown as never[],
      undefined as unknown as never[],
    );
    expect(items).toEqual([]);
  });

  it('registers Z.AI CN and Global as builtin provider types', () => {
    expect(PROVIDER_TYPES).toContain('zai');
    expect(PROVIDER_TYPES).toContain('zai-global');
    expect(BUILTIN_PROVIDER_TYPES).toContain('zai');
    expect(BUILTIN_PROVIDER_TYPES).toContain('zai-global');
  });

  it('Z.AI CN and Global share runtime key but keep separate frontend vendors', () => {
    const zaiCn = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'zai');
    const zaiGlobal = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'zai-global');

    expect(zaiCn).toMatchObject({
      name: 'Z.AI (CN)',
      model: 'glm-5.2',
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
      runtimeProviderKey: 'zai',
      apiKeyUrl: 'https://open.bigmodel.cn/user/apiKeys',
    });
    expect(zaiGlobal).toMatchObject({
      name: 'Z.AI (Global)',
      model: 'glm-5.2',
      defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
      codePlan: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-5.2' },
      runtimeProviderKey: 'zai',
      apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    });
  });

  it('Z.AI static vendor projection keeps env key and singleton credential id', async () => {
    vi.mocked(hostApiFetch).mockResolvedValueOnce({ accounts: [] });

    const snapshot = await fetchProviderSnapshot();
    const zaiCn = snapshot.vendors.find((vendor) => vendor.id === 'zai');
    const zaiGlobal = snapshot.vendors.find((vendor) => vendor.id === 'zai-global');

    expect(zaiCn).toMatchObject({ envVar: 'ZAI_API_KEY', supportsMultipleAccounts: false });
    expect(zaiGlobal).toMatchObject({ envVar: 'ZAI_API_KEY', supportsMultipleAccounts: false });
    expect(buildProviderCredentialId('zai', null, snapshot.vendors)).toBe('zai');
    expect(buildProviderCredentialId('zai-global', null, snapshot.vendors)).toBe('zai');
  });

  it('MiniMax provider metadata keeps console urls', () => {
    const minimaxGlobal = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal');
    const minimaxCn = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal-cn');

    expect(minimaxGlobal?.apiKeyUrl).toBe('https://platform.minimax.io');
    expect(minimaxCn?.apiKeyUrl).toBe('https://platform.minimaxi.com/');
  });

  it('normalizes provider API key input before validation and save', () => {
    expect(normalizeProviderApiKeyInput('  sk-test \n')).toBe('sk-test');
  });

  it('OAuth provider metadata keeps auth metadata only', () => {
    const openai = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'openai');
    const google = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'google');
    const minimax = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal');
    const minimaxCn = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal-cn');
    const qwen = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'qwen-portal');

    expect(openai?.apiKeyUrl).toBe('https://platform.openai.com/api-keys');
    expect(openai?.hideOAuthUi).toBeUndefined();
    expect(google?.apiKeyUrl).toBe('https://aistudio.google.com/app/apikey');
    expect(minimax?.supportsApiKey).toBe(true);
    expect(minimaxCn?.supportsApiKey).toBe(true);
    expect(qwen?.isOAuth).toBe(true);
  });
});
